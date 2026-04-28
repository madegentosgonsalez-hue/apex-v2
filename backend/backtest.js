'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// APEX BACKTEST ENGINE
// Fetches 1 year historical 1H OHLC from Twelve Data, aggregates into all
// required timeframes, replays Brain1 analysis on each H4 candle close,
// simulates 40/40/20 exit model, generates comprehensive report.
// Brain1/Brain2/Brain3 logic is NOT modified — only simulated on historical data.
// ═══════════════════════════════════════════════════════════════════════════

const Brain1       = require('./engines/brain1-signal');
const AIAnalyst    = require('./engines/aiAnalyst');
const { SIGNAL_RULES } = require('./utils/constants');

// Minimal mocks so Brain1 can run without live DB/news/data calls
const MOCK_NEWS = { checkBlackout: async () => ({ blocked: false }) };
const MOCK_DB   = {
  getPair:                async () => null,
  checkDailyLossLimit:    async () => ({ limitHit: false }),
  getActiveSignalForPair: async () => null,
  saveAIDecision:         async () => null,
  query:                  async () => ({ rows: [] }),
};

const BT_SESSION_CONFIG = {
  ASIAN:    { label: 'ASIAN', start: 0,  end: 8,  pairs: ['AUDUSD', 'EURJPY', 'GBPJPY'], allowedTypes: ['TYPE_A', 'TYPE_B', 'TYPE_C', 'TYPE_D'] },
  LONDON:   { label: 'LONDON', start: 8,  end: 16, pairs: ['EURUSD', 'GBPUSD', 'USDCHF', 'XAUUSD'], allowedTypes: ['TYPE_A', 'TYPE_B', 'TYPE_C', 'TYPE_D'] },
  NEW_YORK: { label: 'NEW_YORK', start: 13, end: 21, pairs: ['EURUSD', 'GBPUSD', 'USDCAD', 'XAUUSD', 'GBPJPY'], allowedTypes: ['TYPE_A', 'TYPE_B', 'TYPE_C', 'TYPE_D'] },
  OVERLAP:  { label: 'OVERLAP', start: 13, end: 16, pairs: ['EURUSD', 'GBPUSD', 'XAUUSD', 'GBPJPY', 'USDCAD', 'USDCHF', 'EURJPY', 'AUDUSD'], allowedTypes: ['TYPE_A', 'TYPE_B', 'TYPE_C', 'TYPE_D'] },
};
const TIER_RANK = { SKIP: 0, BRONZE: 1, SILVER: 2, GOLD: 3, DIAMOND: 4 };

class Backtester {
  constructor({
    dataService,
    aiAnalyst = null,
    sessionConfig = BT_SESSION_CONFIG,
    pairPolicy = null,
    strategyProfile = null,
    contextSeries = null,
    researchOptions = null,
  } = {}) {
    this.data   = dataService;
    this.brain1 = new Brain1({ dataService, newsService: MOCK_NEWS, db: MOCK_DB, strategyProfile });
    this.ai     = aiAnalyst;
    this.sessionConfig = sessionConfig;
    this.pairPolicy = pairPolicy || {};
    this.contextSeries = contextSeries || null;
    this.researchOptions = {
      allowConcurrentTrades: false,
      syntheticIntermarket: false,
      ...(researchOptions || {}),
    };
    this._contextDailyCache = new Map();
  }

  // ── INDICATOR MATH ──────────────────────────────────────────────────────

  _ema(closes, period) {
    if (!closes.length) return null;
    const k = 2 / (period + 1);
    if (closes.length < period) {
      // Fewer bars than period: seed from first close and run EMA forward
      // This keeps ema21 faster than ema50 even with sparse data
      let v = closes[0];
      for (let i = 1; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
      return v;
    }
    let v = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
    return v;
  }

  _rsi(closes, period = 14) {
    if (closes.length <= period) return 50;
    let g = 0, l = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) g += d; else l -= d;
    }
    const ag = g / period, al = l / period;
    return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }

  _atr(candles, period = 14) {
    if (candles.length < 2) return 0;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const h = candles[i].high, lo = candles[i].low, pc = candles[i - 1].close;
      trs.push(Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc)));
    }
    const sl = trs.slice(-period);
    return sl.reduce((a, b) => a + b, 0) / sl.length;
  }

  _adx(candles, period = 14) {
    if (candles.length < period + 1) return 20;
    let pdm = 0, mdm = 0, tr = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      const up = candles[i].high - candles[i - 1].high;
      const dn = candles[i - 1].low  - candles[i].low;
      if (up > dn && up > 0) pdm += up;
      if (dn > up && dn > 0) mdm += dn;
      const h = candles[i].high, lo = candles[i].low, pc = candles[i - 1].close;
      tr += Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc));
    }
    if (!tr) return 20;
    const pdi = (pdm / tr) * 100, mdi = (mdm / tr) * 100;
    return Math.abs(pdi - mdi) / (pdi + mdi + 1e-9) * 100;
  }

  _swings(values, isHigh, lookback = 2) {
    const r = [];
    for (let i = lookback; i < values.length - lookback; i++) {
      const center = values[i];
      let isPeak = true;
      for (let j = 1; j <= lookback; j++) {
        if (isHigh  && (values[i - j] >= center || values[i + j] >= center)) { isPeak = false; break; }
        if (!isHigh && (values[i - j] <= center || values[i + j] <= center)) { isPeak = false; break; }
      }
      if (isPeak) r.push(center);
    }
    return r;
  }

  _buildTF(candles) {
    if (!candles || candles.length < 5) return null;
    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume || 0);
    return {
      candles, closes, highs, lows, volumes,
      ema21:      this._ema(closes, 21),
      ema50:      this._ema(closes, 50),
      rsi:        this._rsi(closes),
      atr:        this._atr(candles),
      adx:        this._adx(candles),
      swingHighs: this._swings(highs, true),
      swingLows:  this._swings(lows,  false),
    };
  }

  // ── AGGREGATE 1H → HIGHER TIMEFRAMES ───────────────────────────────────

  _aggregate(h1, periodHours) {
    const ms      = periodHours * 3600 * 1000;
    const buckets = new Map();
    for (const c of h1) {
      const key = Math.floor(new Date(c.datetime).getTime() / ms);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(c);
    }
    return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, cs]) => ({
      datetime: cs[0].datetime,
      open:     cs[0].open,
      high:     Math.max(...cs.map(c => c.high)),
      low:      Math.min(...cs.map(c => c.low)),
      close:    cs[cs.length - 1].close,
      volume:   cs.reduce((s, c) => s + (c.volume || 0), 0),
    }));
  }

  // ── FETCH 1H HISTORICAL FROM TWELVE DATA ───────────────────────────────

  async _fetchH1(symbol, yearsBack) {
    const symbolMap = {
      XAUUSD: 'XAU/USD',
      USDCAD: 'USD/CAD',
    };
    const tdSym = symbolMap[symbol]
                || (/^[A-Z]{6}$/.test(symbol) ? `${symbol.slice(0,3)}/${symbol.slice(3)}` : symbol);

    const end   = new Date();
    const start = new Date();
    start.setFullYear(start.getFullYear() - yearsBack);

    const key = process.env.TWELVE_DATA_API_KEY;
    const chunkDays = 150; // ~3600 H1 bars per request, safely below Twelve Data output caps.
    let requestCount = 0;
    const all = [];
    let cursor = new Date(start);

    while (cursor < end) {
      const chunkStart = new Date(cursor);
      const chunkEnd = new Date(cursor);
      chunkEnd.setDate(chunkEnd.getDate() + chunkDays);
      if (chunkEnd > end) chunkEnd.setTime(end.getTime());

      if (requestCount > 0) {
        await new Promise(r => setTimeout(r, 8000)); // Free tier allows 8 credits/minute.
      }

      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSym)}&interval=1h&outputsize=5000&start_date=${chunkStart.toISOString().slice(0,10)}&end_date=${chunkEnd.toISOString().slice(0,10)}&apikey=${key}&format=JSON&order=ASC`;

      const resp = await fetch(url);
      const json = await resp.json();

      if (json.status === 'error' || !Array.isArray(json.values)) {
        throw new Error(json.message || `Twelve Data: no values returned for ${chunkStart.toISOString().slice(0,10)} to ${chunkEnd.toISOString().slice(0,10)}`);
      }

      all.push(...json.values.map(v => ({
        datetime: v.datetime,
        open:   parseFloat(v.open),
        high:   parseFloat(v.high),
        low:    parseFloat(v.low),
        close:  parseFloat(v.close),
        volume: parseFloat(v.volume || 0),
      })));
      requestCount++;

      cursor = new Date(chunkEnd);
      cursor.setDate(cursor.getDate() + 1);
    }

    return all
      .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))
      .filter((c, idx, arr) => idx === 0 || c.datetime !== arr[idx - 1].datetime);
  }

  _contextDaily(symbol) {
    if (!this.contextSeries?.[symbol]) return null;
    if (!this._contextDailyCache.has(symbol)) {
      this._contextDailyCache.set(symbol, this._aggregate(this.contextSeries[symbol], 24));
    }
    return this._contextDailyCache.get(symbol);
  }

  _findLatestIndex(candles, tsMs) {
    for (let i = candles.length - 1; i >= 0; i--) {
      if (new Date(candles[i].datetime).getTime() <= tsMs) return i;
    }
    return -1;
  }

  _usdRole(symbol) {
    if (['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'XAUUSD'].includes(symbol)) return 'QUOTE';
    if (['USDJPY', 'USDCAD', 'USDCHF'].includes(symbol)) return 'BASE';
    return null;
  }

  _resolveIntermarket(symbol, ts) {
    if (!this.researchOptions.syntheticIntermarket || !this.contextSeries) {
      return { dxyTrend: 'UNKNOWN', vix: null, btcDominance: null };
    }

    const tsMs = ts.getTime();
    let score = 0;
    let weight = 0;

    for (const otherSymbol of Object.keys(this.contextSeries)) {
      if (otherSymbol === symbol) continue;
      const role = this._usdRole(otherSymbol);
      if (!role) continue;

      const daily = this._contextDaily(otherSymbol);
      if (!daily || daily.length < 8) continue;

      const idx = this._findLatestIndex(daily, tsMs);
      if (idx < 3) continue;

      const now = daily[idx]?.close;
      const prev = daily[idx - 3]?.close;
      if (!isFinite(now) || !isFinite(prev) || prev === 0) continue;

      const ret = (now - prev) / prev;
      if (Math.abs(ret) < 0.001) continue;

      const usdVote = role === 'QUOTE' ? -Math.sign(ret) : Math.sign(ret);
      const voteWeight = Math.min(Math.abs(ret) * 100, 3);
      score += usdVote * voteWeight;
      weight += voteWeight;
    }

    if (weight < 2) return { dxyTrend: 'UNKNOWN', vix: null, btcDominance: null };

    const normalized = score / weight;
    const dxyTrend = normalized >= 0.2 ? 'UP' : normalized <= -0.2 ? 'DOWN' : 'UNKNOWN';
    return { dxyTrend, vix: null, btcDominance: null };
  }

  _activeSessionsFor(symbol, utcHour) {
    const sessions = Object.values(this.sessionConfig).filter(cfg =>
      utcHour >= cfg.start && utcHour < cfg.end && cfg.pairs.includes(symbol)
    );
    return sessions.sort((a, b) => {
      const priority = { OVERLAP: 0, NEW_YORK: 1, LONDON: 2, ASIAN: 3 };
      return (priority[a.label] ?? 9) - (priority[b.label] ?? 9);
    });
  }

  _sessionLabel(activeSessions) {
    return activeSessions[0]?.label || null;
  }

  _executionPolicy(signal) {
    const policy = this.pairPolicy[signal.symbol];
    if (!policy) return { allowed: true };

    if (policy.sessions && !policy.sessions.includes(signal.session)) {
      return { allowed: false, reason: `${signal.symbol} restricted to ${policy.sessions.join('/')}` };
    }

    if (policy.minTier && TIER_RANK[signal.confidence_tier] < TIER_RANK[policy.minTier]) {
      return { allowed: false, reason: `${signal.symbol} requires ${policy.minTier}+` };
    }

    return { allowed: true };
  }

  async _applySignalOverlay(signal, trades) {
    if (!this.ai) {
      return { accepted: true, signal };
    }

    if (typeof this.ai.analyzeSignalFull === 'function') {
      const aiContext = this._buildBacktestAIContext(signal, trades, signal.session, signal.regime);
      const aiDecision = await this.ai.analyzeSignalFull(signal, {
        mode: 'backtest-simulated',
        backtestContext: aiContext,
      });
      if (!aiDecision || aiDecision.tier === 'SKIP') {
        return { accepted: false, reason: 'ai' };
      }
      signal.confidence_tier = aiDecision.tier;
      signal.ai_conviction = aiDecision.conviction;
      signal.ai_reason = aiDecision.reason;
      return { accepted: true, signal };
    }

    if (typeof this.ai.validateSignal === 'function') {
      const hist = null;
      const resp = await this.ai.validateSignal(signal, hist);
      if (!resp || resp.decision === 'REJECT') {
        return { accepted: false, reason: 'ai' };
      }
      signal.ai_conviction = resp.conviction;
      signal.ai_reason = resp.reasoning || resp.reason || 'AI validation passed.';
      return { accepted: true, signal };
    }

    return { accepted: true, signal };
  }

  _buildLearningSnapshot(trades) {
    if (!trades.length) return null;

    const group = (rows, keyFn) => {
      const stats = {};
      for (const row of rows) {
        const key = keyFn(row);
        if (!stats[key]) stats[key] = { total: 0, wins: 0 };
        stats[key].total++;
        if (row.r > 0) stats[key].wins++;
      }
      return Object.entries(stats)
        .map(([key, value]) => ({ key, winRate: value.total > 0 ? (value.wins / value.total) * 100 : 0, total: value.total }))
        .sort((a, b) => b.winRate - a.winRate || b.total - a.total)[0]?.key || null;
    };

    return {
      pair: group(trades, t => t.symbol),
      bestEntryType: group(trades, t => t.entryType),
      bestSession: group(trades, t => t.session),
    };
  }

  _buildBacktestAIContext(signal, executedTrades, sessionLabel, regimeLabel) {
    const tierStats = { DIAMOND: { total: 0, wins: 0, winRate: null }, GOLD: { total: 0, wins: 0, winRate: null }, SILVER: { total: 0, wins: 0, winRate: null } };
    for (const tier of Object.keys(tierStats)) {
      const tierTrades = executedTrades.filter(t => t.tier === tier);
      const wins = tierTrades.filter(t => t.r > 0).length;
      tierStats[tier] = {
        total: tierTrades.length,
        wins,
        winRate: tierTrades.length ? Number(((wins / tierTrades.length) * 100).toFixed(1)) : null,
      };
    }

    const similar = executedTrades.filter(t => t.symbol === signal.symbol && t.entryType === signal.entry_type);
    const similarWins = similar.filter(t => t.r > 0).length;

    return {
      pairTypePerformance: {
        total: similar.length,
        wins: similarWins,
        winRate: similar.length ? Number(((similarWins / similar.length) * 100).toFixed(1)) : null,
        avgR: similar.length ? Number((similar.reduce((sum, t) => sum + t.r, 0) / similar.length).toFixed(2)) : null,
      },
      tierPerformance: tierStats,
      learning: this._buildLearningSnapshot(executedTrades),
      session: sessionLabel,
      regime: regimeLabel,
      volatility: (signal.adx_value || 0) >= 30 ? 'EXPANDED' : (signal.adx_value || 0) <= 14 ? 'COMPRESSED' : 'NORMAL',
      dailyLosses: 0,
      recentSimilar: similar.slice(-5).map(t => ({ outcome: t.r > 0 ? 'WIN' : 'LOSS', r: t.r })),
    };
  }

  // ── BRAIN1 ANALYSIS ON HISTORICAL SNAPSHOT ─────────────────────────────

  _analyzeSnapshot(symbol, h4s, h2s, h1s, d1s, w1s, ts) {
    const skip = (reason) => ({ signal: null, skipReason: reason });
    try {
      const b = this.brain1;
      const mkt = {
        weekly:      this._buildTF(w1s.slice(-52)),
        daily:       this._buildTF(d1s.slice(-100)),
        h4:          this._buildTF(h4s.slice(-100)),
        h2:          this._buildTF(h2s.slice(-100)),
        h1:          this._buildTF(h1s.slice(-100)),
        m30:         this._buildTF(h1s.slice(-40)),
        m15:         null,
        intermarket: this._resolveIntermarket(symbol, ts),
      };
      if (!mkt.h4 || !mkt.daily || !mkt.weekly) return skip('regime');

      const utcH = ts.getUTCHours();
      const activeSess = this._activeSessionsFor(symbol, utcH);
      if (!activeSess.length) return skip('session');
      const typeRestrict = [...new Set(activeSess.flatMap(s => s.allowedTypes || []))];
      const session = this._sessionLabel(activeSess);

      const regime = b._regime(mkt);
      if (!regime.signalAllowed) return skip('regime');

      const bias = b._topDownBias(mkt);
      if (bias.direction === 'NEUTRAL') return skip('bias');

      const loc = b._locationCheck(mkt, bias.direction);
      if (!loc.valid) return skip('location');

      const entryType = b._entryType(mkt, bias.direction, loc);
      if (!entryType) return skip('entryType');
      if (typeRestrict.length && !typeRestrict.includes(entryType)) return skip('entryType');

      const cf = b._confluence(mkt, bias.direction, loc, symbol, bias.h2Conflicts);
      const entryMin = { TYPE_A: 5, TYPE_B: 4, TYPE_C: 4, TYPE_D: 5 }[entryType] || 4;
      const minScore = Math.max(SIGNAL_RULES.MIN_CONFLUENCE || 4, entryMin);
      if (cf.score < minScore) return skip('confluence');

      const levels = b._levels(mkt, bias.direction, loc);
      if (!levels.valid || levels.rr < (SIGNAL_RULES.MIN_RR || 2.0)) return skip('levels');

      const tier = b._tier(cf.score);

      return {
        signal: {
          symbol, direction: bias.direction,
          entry_type:       entryType,
          entry_price:      levels.entry,
          stop_loss:        levels.sl,
          tp1:              levels.tp1,
          tp2:              levels.tp2,
          atr_value:        levels.atr,
          rr_ratio:         levels.rr,
          confluence_score: cf.score,
          htf_trend_aligned:    cf.factors.htfAligned,
          key_level_present:    cf.factors.keyLevel,
          volume_confirmed:     cf.factors.volume,
          rsi_momentum_aligned: cf.factors.rsi,
          candle_pattern_found: cf.factors.candle,
          intermarket_aligned:  cf.factors.intermarket,
          h2_conflict:          cf.h2Conflict || false,
          level_type:           loc.type,
          confidence_tier:  tier.label,
          regime:           regime.label,
          adx_value:        mkt.h4?.adx,
          rsi_value:        mkt.h4?.rsi,
          vix_level:        mkt.intermarket?.vix ?? null,
          dxy_direction:    mkt.intermarket?.dxyTrend || 'UNKNOWN',
          session,
          risk_pct:         tier.riskPct,
          news_clear:       true,
          timestamp:        ts.toISOString(),
          month:            ts.toISOString().slice(0, 7),
        },
        skipReason: null,
      };
    } catch { return { signal: null, skipReason: 'regime' }; }
  }

  // ── SIMULATE 40/40/20 EXIT ──────────────────────────────────────────────

  _simulateTrade(signal, futureH4, startAtr) {
    const { direction: dir, entry_price: entry, stop_loss: sl, tp1, tp2 } = signal;
    const isBuy  = dir === 'BUY';
    const risk   = Math.abs(entry - sl);
    if (!risk) return null;

    let lot1Done = false, lot2Done = false, lot3Done = false;
    let beActive = false;
    let totalR   = 0;
    let trailSl  = sl;
    const atr    = startAtr || risk;

    for (const c of futureH4) {
      const hi = c.high, lo = c.low;

      // SL check (priority over TP)
      const slHit = isBuy ? lo <= (beActive ? entry : sl) : hi >= (beActive ? entry : sl);
      if (!lot1Done && slHit) {
        return { r: -1, exitReason: 'SL', exitTime: c.datetime, exitPrice: sl };
      }
      if (lot1Done && slHit) {
        return { r: parseFloat((totalR).toFixed(2)), exitReason: 'SL_BE', exitTime: c.datetime, exitPrice: entry };
      }

      // 20% trail SL check (ATR-based)
      if (lot2Done && !lot3Done) {
        const trailHit = isBuy ? lo <= trailSl : hi >= trailSl;
        if (trailHit) {
          totalR += 0.2 * Math.abs(trailSl - entry) / risk;
          return { r: parseFloat(totalR.toFixed(2)), exitReason: 'TRAIL_SL', exitTime: c.datetime, exitPrice: trailSl };
        }
        // Update trail
        if (isBuy)  trailSl = Math.max(trailSl, c.close - atr * 1.5);
        else        trailSl = Math.min(trailSl, c.close + atr * 1.5);
      }

      // TP1: close 40% at 2R, move SL to BE
      if (!lot1Done && (isBuy ? hi >= tp1 : lo <= tp1)) {
        lot1Done = true; beActive = true;
        totalR += 0.4 * 2; // 40% × 2R
      }

      // TP2: close 40% at 3R
      if (lot1Done && !lot2Done && (isBuy ? hi >= tp2 : lo <= tp2)) {
        lot2Done = true;
        totalR += 0.4 * 3; // 40% × 3R
        trailSl = isBuy ? c.close - atr * 1.5 : c.close + atr * 1.5;
      }

      // Trail 20%: close at TP2 level or trail hit
      if (lot2Done && !lot3Done && (isBuy ? hi >= tp2 : lo <= tp2)) {
        lot3Done = true;
        totalR += 0.2 * 3;
        return { r: parseFloat(totalR.toFixed(2)), exitReason: 'FULL_TP', exitTime: c.datetime, exitPrice: tp2 };
      }
    }

    // Incomplete trade at end of data
    const last = futureH4[futureH4.length - 1];
    if (last) {
      const openR = isBuy ? (last.close - entry) / risk : (entry - last.close) / risk;
      const rem   = lot2Done ? 0.2 : lot1Done ? 0.6 : 1.0;
      return { r: parseFloat((totalR + openR * rem).toFixed(2)), exitReason: 'OPEN_AT_END', exitTime: last.datetime, exitPrice: last.close };
    }
    return null;
  }

  // ── MAIN BACKTEST ───────────────────────────────────────────────────────

  async runBacktest(symbol, yearsBack = 1, onProgress = null, h1Override = null) {
    console.log(`[Backtest] ${symbol} — fetching ${yearsBack}Y of 1H data...`);
    if (onProgress) onProgress(5, 'Fetching historical data…');

    const h1Raw = h1Override || await this._fetchH1(symbol, yearsBack);
    if (!h1Raw || h1Raw.length < 200) throw new Error(`Insufficient data: ${h1Raw?.length || 0} candles`);

    console.log(`[Backtest] ${symbol} — ${h1Raw.length} H1 candles. Aggregating...`);
    if (onProgress) onProgress(15, 'Aggregating timeframes…');

    const h1 = h1Raw;
    const h2 = this._aggregate(h1, 2);
    const h4 = this._aggregate(h1, 4);
    const d1 = this._aggregate(h1, 24);
    const w1 = this._aggregate(h1, 168);

    console.log(`[Backtest] ${symbol} — H4 bars: ${h4.length}, D1: ${d1.length}, W1: ${w1.length}`);

    const signals = [];
    const trades  = [];
    let candidateSignals = 0;
    let tradeEndTime = null;
    const enforceSingleTradeLock = !this.researchOptions.allowConcurrentTrades;

    // Diagnostic skip counters — returned in report for debugging
    const skips = { inTrade: 0, regime: 0, bias: 0, location: 0, entryType: 0, confluence: 0, levels: 0, session: 0 };

    // Pointer-based sliding window (O(n) instead of O(n²))
    let h1End = 0, h2End = 0, d1End = 0, w1End = 0;
    const tsOf = (arr, j) => new Date(arr[j].datetime).getTime();

    const H4_WARMUP = 200; // 200 H4 bars = ~50 days, ensures daily ema50 has enough bars
    const total = h4.length - H4_WARMUP - 1;

    for (let i = H4_WARMUP; i < h4.length - 1; i++) {
      const h4Ts = new Date(h4[i].datetime);
      const h4Ms = h4Ts.getTime();

      // Skip while in an active trade
      if (enforceSingleTradeLock && tradeEndTime && h4Ms <= tradeEndTime) { skips.inTrade++; continue; }

      // Advance pointers to include all candles up to current H4 bar
      while (h1End < h1.length - 1 && tsOf(h1, h1End + 1) <= h4Ms) h1End++;
      while (h2End < h2.length - 1 && tsOf(h2, h2End + 1) <= h4Ms) h2End++;
      while (d1End < d1.length - 1 && tsOf(d1, d1End + 1) <= h4Ms) d1End++;
      while (w1End < w1.length - 1 && tsOf(w1, w1End + 1) <= h4Ms) w1End++;

      const h4Slice = h4.slice(Math.max(0, i - 99), i + 1);
      const h2Slice = h2.slice(Math.max(0, h2End - 99), h2End + 1);
      const h1Slice = h1.slice(Math.max(0, h1End - 99), h1End + 1);
      const d1Slice = d1.slice(Math.max(0, d1End - 99), d1End + 1);
      const w1Slice = w1.slice(Math.max(0, w1End - 51), w1End + 1);

      const { signal, skipReason } = this._analyzeSnapshot(symbol, h4Slice, h2Slice, h1Slice, d1Slice, w1Slice, h4Ts);
      if (!signal) { if (skipReason) skips[skipReason] = (skips[skipReason] || 0) + 1; continue; }
      candidateSignals++;

      const overlay = await this._applySignalOverlay(signal, trades);
      if (!overlay.accepted) {
        skips[overlay.reason || 'ai'] = (skips[overlay.reason || 'ai'] || 0) + 1;
        continue;
      }

      const policy = this._executionPolicy(signal);
      if (!policy.allowed) {
        skips.policy = (skips.policy || 0) + 1;
        continue;
      }

      signals.push(signal);

      // Simulate trade outcome on next 500 H4 bars (≈83 days max per trade)
      const futureH4 = h4.slice(i + 1, i + 501);
      const startAtr  = h4Slice[h4Slice.length - 1]
        ? this._atr(h4Slice, Math.min(14, h4Slice.length)) : null;

      const exit = this._simulateTrade(signal, futureH4, startAtr);
      if (!exit) continue;

      trades.push({
        symbol,
        entryTime:  signal.timestamp,
        exitTime:   exit.exitTime,
        direction:  signal.direction,
        entryType:  signal.entry_type,
        tier:       signal.confidence_tier,
        session:    signal.session,
        regime:     signal.regime,
        month:      signal.month,
        r:          exit.r,
        win:        exit.r > 0,
        exitReason: exit.exitReason,
      });

      // Block further signals until this trade closes
      if (enforceSingleTradeLock) {
        tradeEndTime = new Date(exit.exitTime).getTime();
      }

      if (onProgress) {
        const pct = Math.round(15 + ((i - H4_WARMUP) / total) * 75);
        onProgress(pct, `Replaying bar ${i - H4_WARMUP}/${total} — ${signals.length} signals so far`);
      }
    }

    console.log(`[Backtest] ${symbol} — skip counts:`, skips);
    if (onProgress) onProgress(95, 'Building report…');
    return this._buildReport(symbol, yearsBack, signals, trades, h4.length, skips, candidateSignals);
  }

  // ── COMPREHENSIVE REPORT ────────────────────────────────────────────────

  _buildReport(symbol, yearsBack, signals, trades, totalBars, skips = {}, candidateSignals = null) {
    const wins   = trades.filter(t => t.r > 0);
    const losses = trades.filter(t => t.r <= 0);
    const totalR = parseFloat(trades.reduce((s, t) => s + t.r, 0).toFixed(2));
    const winPct = (w, t) => t > 0 ? parseFloat((w / t * 100).toFixed(1)) : 0;

    // Consecutive streaks
    let maxWin = 0, maxLoss = 0, curW = 0, curL = 0;
    for (const t of trades) {
      if (t.r > 0) { curW++; curL = 0; maxWin  = Math.max(maxWin,  curW); }
      else         { curL++; curW = 0; maxLoss = Math.max(maxLoss, curL); }
    }

    // Profit factor
    const grossWin  = wins.reduce((s, t) => s + t.r, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.r, 0));
    const profitFactor = grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : (grossWin > 0 ? 999 : 0);

    // Group helper — all values numeric
    const grp = (field) => {
      const m = {};
      for (const t of trades) {
        const k = t[field] || 'UNKNOWN';
        if (!m[k]) m[k] = { trades: 0, wins: 0, totalR: 0 };
        m[k].trades++; m[k].totalR += t.r;
        if (t.r > 0) m[k].wins++;
      }
      return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, {
        trades:  v.trades,
        wins:    v.wins,
        winRate: winPct(v.wins, v.trades),
        totalR:  parseFloat(v.totalR.toFixed(2)),
      }]));
    };

    const entryGrp   = grp('entryType');
    const tierGrp    = grp('tier');
    const sessionGrp = grp('session');
    const monthGrp   = grp('month');

    const bestOf = (obj) => Object.entries(obj)
      .filter(([, v]) => v.trades >= 3)
      .sort((a, b) => (b[1].wins / b[1].trades) - (a[1].wins / a[1].trades))[0]?.[0] || 'N/A';

    return {
      symbol, yearsBack,
      generatedAt:  new Date().toISOString(),
      dataPoints:   totalBars,
      skipCounts:   skips,
      summary: {
        totalTrades:           trades.length,
        totalSignals:          signals.length,
        candidateSignals:      candidateSignals ?? signals.length,
        avgSignalsPerMonth:    Number((signals.length / Math.max(yearsBack * 12, 1)).toFixed(2)),
        winRate:               winPct(wins.length, trades.length),  // numeric %
        winsCount:             wins.length,
        lossCount:             losses.length,
        totalR,
        avgR:                  trades.length > 0 ? parseFloat((totalR / trades.length).toFixed(2)) : 0,
        largestWin:            wins.length  > 0 ? parseFloat(Math.max(...wins.map(t => t.r)).toFixed(2))  : 0,
        largestLoss:           losses.length > 0 ? parseFloat(Math.min(...losses.map(t => t.r)).toFixed(2)) : 0,
        maxConsecutiveWins:    maxWin,
        maxConsecutiveLosses:  maxLoss,
        profitFactor,
        signalRate:            parseFloat((signals.length / Math.max(totalBars, 1) * 100).toFixed(2)),
      },
      best: {
        entryType: bestOf(entryGrp),
        session:   bestOf(sessionGrp),
        tier:      bestOf(tierGrp),
      },
      byEntryType: entryGrp,
      byTier:      tierGrp,
      bySession:   sessionGrp,
      byMonth:     monthGrp,
      recentTrades: trades.slice(-30).map(t => ({
        date:       t.entryTime?.slice(0, 16),
        exitTime:   t.exitTime?.slice ? t.exitTime.slice(0, 16) : t.exitTime,
        direction:  t.direction,
        entryType:  t.entryType,
        tier:       t.tier,
        pnlR:       t.r,
        outcome:    t.r > 0 ? 'WIN' : 'LOSS',
        exitReason: t.exitReason,
      })),
    };
  }
}

module.exports = Backtester;
