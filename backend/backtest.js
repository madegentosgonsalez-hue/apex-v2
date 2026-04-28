'use strict';

const fs = require('fs');
const path = require('path');

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
const WEEKLY_ANCHOR_MS = Date.UTC(1970, 0, 5, 0, 0, 0, 0); // Monday 00:00 UTC.

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
    this._cacheDir = process.env.BACKTEST_CACHE_DIR
      ? path.resolve(process.env.BACKTEST_CACHE_DIR)
      : path.join(__dirname, 'research', 'cache');
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

  _aggregateMs(candles, periodMs, anchorMs = 0) {
    const ms      = periodMs;
    const buckets = new Map();
    for (const c of candles) {
      const key = Math.floor((new Date(c.datetime).getTime() - anchorMs) / ms);
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

  _aggregate(candles, periodHours, anchorMs = 0) {
    return this._aggregateMs(candles, periodHours * 3600 * 1000, anchorMs);
  }

  _aggregateMinutes(candles, periodMinutes, anchorMs = 0) {
    return this._aggregateMs(candles, periodMinutes * 60 * 1000, anchorMs);
  }

  _seriesCachePath(symbol, yearsBack, interval, provider) {
    const safeProvider = String(provider || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
    const safeSymbol = String(symbol || 'UNKNOWN').replace(/[^A-Z0-9_-]/gi, '_');
    const safeInterval = String(interval || '1h').replace(/[^a-z0-9_-]/gi, '_');
    const safeYears = String(yearsBack).replace(/[^0-9._-]/g, '_');
    return path.join(this._cacheDir, `${safeProvider}-${safeSymbol}-${safeInterval}-${safeYears}y.json`);
  }

  _readSeriesCache(symbol, yearsBack, interval, provider) {
    if (/^(1|true|yes)$/i.test(String(process.env.BACKTEST_REFRESH || 'false'))) {
      return null;
    }
    const cachePath = this._seriesCachePath(symbol, yearsBack, interval, provider);
    if (!fs.existsSync(cachePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      return Array.isArray(parsed?.candles) ? parsed.candles : null;
    } catch {
      return null;
    }
  }

  _writeSeriesCache(symbol, yearsBack, interval, provider, candles) {
    try {
      fs.mkdirSync(this._cacheDir, { recursive: true });
      const cachePath = this._seriesCachePath(symbol, yearsBack, interval, provider);
      fs.writeFileSync(cachePath, JSON.stringify({
        symbol,
        yearsBack,
        interval,
        provider,
        generatedAt: new Date().toISOString(),
        candles,
      }));
    } catch (err) {
      console.warn(`[Backtest] Cache write skipped for ${symbol} ${interval}: ${err.message}`);
    }
  }

  async _fetchJsonWithRetry(url, options = {}) {
    const {
      attempts = 4,
      delayMs = 15000,
      retryLabel = 'request',
    } = options;

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const resp = await fetch(url);
        const json = await resp.json();
        const message = String(json?.error || json?.message || '');
        const rateLimited = resp.status === 429 || /maximum requests per minute|rate limit/i.test(message);

        if (rateLimited && attempt < attempts) {
          console.warn(`[Backtest] ${retryLabel} rate-limited. Waiting ${delayMs}ms before retry ${attempt + 1}/${attempts}...`);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        return { resp, json };
      } catch (err) {
        lastError = err;
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
      }
    }

    throw lastError || new Error(`${retryLabel} failed after ${attempts} attempts`);
  }

  // ── FETCH 1H HISTORICAL FROM TWELVE DATA ───────────────────────────────

  async _fetchSeries(symbol, yearsBack, interval = '1h') {
    const provider = String(process.env.MARKET_DATA_PROVIDER || 'twelve').toLowerCase();
    const cached = this._readSeriesCache(symbol, yearsBack, interval, provider);
    if (cached?.length) {
      console.log(`[Backtest] ${symbol} — loaded ${cached.length} ${interval} candles from ${provider} cache.`);
      return cached;
    }

    const polygonKey = process.env.POLYGON_API_KEY;
    if (provider === 'polygon' && polygonKey && /^[A-Z]{6}$/.test(symbol)) {
      const polygonIntervals = {
        '15m': { multiplier: 15, timespan: 'minute', chunkDays: 7, label: 'M15' },
        '30m': { multiplier: 30, timespan: 'minute', chunkDays: 14, label: 'M30' },
        '1h':  { multiplier: 1, timespan: 'hour', chunkDays: 30, label: 'H1' },
      };
      const config = polygonIntervals[interval];
      if (!config) {
        throw new Error(`Polygon does not support interval ${interval} in backtest mode`);
      }
      const end = new Date();
      const start = new Date();
      start.setFullYear(start.getFullYear() - yearsBack);
      const ticker = `C:${symbol}`;
      const all = [];
      let cursor = new Date(start);
      let requestCount = 0;

      while (cursor < end) {
        const chunkStart = new Date(cursor);
        const chunkEnd = new Date(cursor);
        chunkEnd.setDate(chunkEnd.getDate() + config.chunkDays);
        if (chunkEnd > end) chunkEnd.setTime(end.getTime());

        if (requestCount > 0) {
          await new Promise(r => setTimeout(r, 12500)); // 5 calls/minute on free plan.
        }

        const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${config.multiplier}/${config.timespan}/${chunkStart.toISOString().slice(0, 10)}/${chunkEnd.toISOString().slice(0, 10)}?adjusted=true&sort=asc&limit=50000&apiKey=${polygonKey}`;
        const { json } = await this._fetchJsonWithRetry(url, {
          attempts: 5,
          delayMs: 15000,
          retryLabel: `Polygon ${symbol} ${interval} ${chunkStart.toISOString().slice(0, 10)}`,
        });
        if (!Array.isArray(json?.results)) {
          throw new Error(json?.error || json?.message || `Polygon: no ${config.label} results for ${symbol} ${chunkStart.toISOString().slice(0, 10)}-${chunkEnd.toISOString().slice(0, 10)}`);
        }

        all.push(...json.results.map((v) => ({
          datetime: new Date(v.t).toISOString().slice(0, 19).replace('T', ' '),
          open: Number(v.o),
          high: Number(v.h),
          low: Number(v.l),
          close: Number(v.c),
          volume: Number(v.v || 0),
        })));

        requestCount++;
        cursor = new Date(chunkEnd);
        cursor.setDate(cursor.getDate() + 1);
      }

      const candles = all
        .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))
        .filter((c, idx, arr) => idx === 0 || c.datetime !== arr[idx - 1].datetime);
      this._writeSeriesCache(symbol, yearsBack, interval, provider, candles);
      return candles;
    }

    const symbolMap = {
      XAUUSD: 'XAU/USD',
      USDCAD: 'USD/CAD',
    };
    const tdSym = symbolMap[symbol]
                || (/^[A-Z]{6}$/.test(symbol) ? `${symbol.slice(0,3)}/${symbol.slice(3)}` : symbol);

    const tdIntervals = {
      '15m': { interval: '15min', chunkDays: 35, label: 'M15' },
      '30m': { interval: '30min', chunkDays: 70, label: 'M30' },
      '1h':  { interval: '1h', chunkDays: 150, label: 'H1' },
    };
    const tdConfig = tdIntervals[interval];
    if (!tdConfig) {
      throw new Error(`Twelve Data does not support interval ${interval} in backtest mode`);
    }

    const end   = new Date();
    const start = new Date();
    start.setFullYear(start.getFullYear() - yearsBack);

    const key = process.env.TWELVE_DATA_API_KEY;
    let requestCount = 0;
    const all = [];
    let cursor = new Date(start);

    while (cursor < end) {
      const chunkStart = new Date(cursor);
      const chunkEnd = new Date(cursor);
      chunkEnd.setDate(chunkEnd.getDate() + tdConfig.chunkDays);
      if (chunkEnd > end) chunkEnd.setTime(end.getTime());

      if (requestCount > 0) {
        await new Promise(r => setTimeout(r, 8000)); // Free tier allows 8 credits/minute.
      }

      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSym)}&interval=${tdConfig.interval}&outputsize=5000&start_date=${chunkStart.toISOString().slice(0,10)}&end_date=${chunkEnd.toISOString().slice(0,10)}&apikey=${key}&format=JSON&order=ASC`;

      const { json } = await this._fetchJsonWithRetry(url, {
        attempts: 4,
        delayMs: 8000,
        retryLabel: `TwelveData ${symbol} ${interval} ${chunkStart.toISOString().slice(0, 10)}`,
      });

      if (json.status === 'error' || !Array.isArray(json.values)) {
        throw new Error(json.message || `Twelve Data: no ${tdConfig.label} values returned for ${chunkStart.toISOString().slice(0,10)} to ${chunkEnd.toISOString().slice(0,10)}`);
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

    const candles = all
      .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))
      .filter((c, idx, arr) => idx === 0 || c.datetime !== arr[idx - 1].datetime);
    this._writeSeriesCache(symbol, yearsBack, interval, provider, candles);
    return candles;
  }

  async _fetchH1(symbol, yearsBack) {
    return this._fetchSeries(symbol, yearsBack, '1h');
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

    if (policy.disabled) {
      return { allowed: false, reason: `${signal.symbol} disabled by policy` };
    }

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

      const conviction = Number(resp.conviction || 0);
      const aiTier =
        conviction >= 88 ? 'DIAMOND' :
        conviction >= 75 ? 'GOLD' :
        conviction >= 65 ? 'SILVER' :
        'SKIP';

      if (aiTier === 'SKIP' || (resp.decision === 'CONDITIONAL' && conviction < SIGNAL_RULES.MIN_AI_CONVICTION)) {
        return { accepted: false, reason: 'ai' };
      }

      if (TIER_RANK[aiTier] < TIER_RANK[signal.confidence_tier]) {
        signal.confidence_tier = aiTier;
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

  _isFreshH4Scan(ts) {
    const utcMins = ts.getUTCHours() * 60 + ts.getUTCMinutes();
    return (utcMins % 240) <= 30;
  }

  // ── BRAIN1 ANALYSIS ON HISTORICAL SNAPSHOT ─────────────────────────────

  _analyzeSnapshot(symbol, h4s, h2s, h1s, d1s, w1s, ts, m30s = null, m15s = null) {
    const skip = (reason) => ({ signal: null, skipReason: reason });
    try {
      const b = this.brain1;
      const mkt = {
        weekly:      this._buildTF(w1s.slice(-52)),
        daily:       this._buildTF(d1s.slice(-100)),
        h4:          this._buildTF(h4s.slice(-100)),
        h2:          this._buildTF(h2s.slice(-100)),
        h1:          this._buildTF(h1s.slice(-100)),
        m30:         this._buildTF((m30s || h1s).slice(-100)),
        m15:         m15s ? this._buildTF(m15s.slice(-100)) : null,
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

  async _buildSeriesBundle(symbol, yearsBack = 1, h1Override = null, onProgress = null) {
    console.log(`[Backtest] ${symbol} — fetching ${yearsBack}Y of 1H data...`);
    if (onProgress) onProgress(5, 'Fetching historical data…');

    const provider = String(process.env.MARKET_DATA_PROVIDER || 'twelve').toLowerCase();
    const useRealLowerTf = !h1Override && provider === 'polygon' && /^[A-Z]{6}$/.test(symbol);

    let m15 = null;
    let m30 = null;
    let h1 = null;
    let h2 = null;
    let h4 = null;
    let d1 = null;
    let w1 = null;

    if (useRealLowerTf) {
      const m15Raw = await this._fetchSeries(symbol, yearsBack, '15m');
      if (!m15Raw || m15Raw.length < 800) throw new Error(`Insufficient M15 data: ${m15Raw?.length || 0} candles`);

      console.log(`[Backtest] ${symbol} — ${m15Raw.length} M15 candles. Aggregating...`);
      if (onProgress) onProgress(15, 'Aggregating timeframes from M15…');

      m15 = m15Raw;
      m30 = this._aggregateMinutes(m15, 30);
      h1 = this._aggregateMinutes(m15, 60);
      h2 = this._aggregateMinutes(m15, 120);
      h4 = this._aggregateMinutes(m15, 240);
      d1 = this._aggregateMinutes(m15, 1440);
      w1 = this._aggregateMinutes(m15, 10080, WEEKLY_ANCHOR_MS);
    } else {
      const h1Raw = h1Override || await this._fetchH1(symbol, yearsBack);
      if (!h1Raw || h1Raw.length < 200) throw new Error(`Insufficient data: ${h1Raw?.length || 0} candles`);

      console.log(`[Backtest] ${symbol} — ${h1Raw.length} H1 candles. Aggregating...`);
      if (onProgress) onProgress(15, 'Aggregating timeframes…');

      h1 = h1Raw;
      h2 = this._aggregate(h1, 2);
      h4 = this._aggregate(h1, 4);
      d1 = this._aggregate(h1, 24);
      w1 = this._aggregate(h1, 168, WEEKLY_ANCHOR_MS);
    }

    if (!h1 || !h4 || !d1 || !w1) throw new Error(`Failed to build backtest timeframes for ${symbol}`);
    if (onProgress) onProgress(15, 'Aggregating timeframes…');

    console.log(`[Backtest] ${symbol} — H4 bars: ${h4.length}, D1: ${d1.length}, W1: ${w1.length}`);

    return { provider, useRealLowerTf, m15, m30, h1, h2, h4, d1, w1 };
  }

  async runBacktest(symbol, yearsBack = 1, onProgress = null, h1Override = null, seriesOverride = null) {
    const bundle = seriesOverride || await this._buildSeriesBundle(symbol, yearsBack, h1Override, onProgress);
    const { m15, m30, h1, h2, h4, d1, w1 } = bundle;

    const signals = [];
    const trades  = [];
    let candidateSignals = 0;
    let tradeEndTime = null;
    const enforceSingleTradeLock = !this.researchOptions.allowConcurrentTrades;

    // Diagnostic skip counters — returned in report for debugging
    const skips = { inTrade: 0, regime: 0, bias: 0, location: 0, entryType: 0, confluence: 0, levels: 0, session: 0 };

    // Pointer-based sliding window (O(n) instead of O(n²))
    let h1End = 0, h2End = 0, d1End = 0, w1End = 0, m30End = 0, m15End = 0;
    const tsOf = (arr, j) => new Date(arr[j].datetime).getTime();

    const H4_WARMUP = 200; // 200 H4 bars = ~50 days, ensures daily ema50 has enough bars
    const finalizeSignal = async (signal, h4Slice, h4Index, progressIndex, progressTotal) => {
      candidateSignals++;

      const overlay = await this._applySignalOverlay(signal, trades);
      if (!overlay.accepted) {
        skips[overlay.reason || 'ai'] = (skips[overlay.reason || 'ai'] || 0) + 1;
        return;
      }

      const policy = this._executionPolicy(signal);
      if (!policy.allowed) {
        skips.policy = (skips.policy || 0) + 1;
        return;
      }

      signals.push(signal);

      const futureH4 = h4.slice(h4Index + 1, h4Index + 501);
      const startAtr = h4Slice[h4Slice.length - 1]
        ? this._atr(h4Slice, Math.min(14, h4Slice.length))
        : null;

      const exit = this._simulateTrade(signal, futureH4, startAtr);
      if (!exit) return;

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

      if (enforceSingleTradeLock) {
        tradeEndTime = new Date(exit.exitTime).getTime();
      }

      if (onProgress) {
        const pct = Math.round(15 + (progressIndex / Math.max(progressTotal, 1)) * 75);
        onProgress(pct, `Replaying bar ${progressIndex}/${progressTotal} — ${signals.length} signals so far`);
      }
    };

    if (m15) {
      let closedH4End = -1;
      const total = m15.length - 1;

      for (let i = 0; i < m15.length; i++) {
        const scanTs = new Date(m15[i].datetime);
        const scanMs = scanTs.getTime();

        while (closedH4End < h4.length - 2 && tsOf(h4, closedH4End + 2) <= scanMs) closedH4End++;
        if (closedH4End < H4_WARMUP) continue;
        if (!this._isFreshH4Scan(scanTs)) continue;

        if (enforceSingleTradeLock && tradeEndTime && scanMs <= tradeEndTime) {
          skips.inTrade++;
          continue;
        }

        while (h1End < h1.length - 1 && tsOf(h1, h1End + 1) <= scanMs) h1End++;
        while (h2End < h2.length - 1 && tsOf(h2, h2End + 1) <= scanMs) h2End++;
        while (d1End < d1.length - 1 && tsOf(d1, d1End + 1) <= scanMs) d1End++;
        while (w1End < w1.length - 1 && tsOf(w1, w1End + 1) <= scanMs) w1End++;
        while (m30 && m30End < m30.length - 1 && tsOf(m30, m30End + 1) <= scanMs) m30End++;
        while (m15End < m15.length - 1 && tsOf(m15, m15End + 1) <= scanMs) m15End++;

        const h4Slice = h4.slice(Math.max(0, closedH4End - 99), closedH4End + 1);
        const h2Slice = h2.slice(Math.max(0, h2End - 99), h2End + 1);
        const h1Slice = h1.slice(Math.max(0, h1End - 99), h1End + 1);
        const d1Slice = d1.slice(Math.max(0, d1End - 99), d1End + 1);
        const w1Slice = w1.slice(Math.max(0, w1End - 51), w1End + 1);
        const m30Slice = m30 ? m30.slice(Math.max(0, m30End - 99), m30End + 1) : null;
        const m15Slice = m15.slice(Math.max(0, m15End - 99), m15End + 1);

        const { signal, skipReason } = this._analyzeSnapshot(symbol, h4Slice, h2Slice, h1Slice, d1Slice, w1Slice, scanTs, m30Slice, m15Slice);
        if (!signal) {
          if (skipReason) skips[skipReason] = (skips[skipReason] || 0) + 1;
          continue;
        }

        await finalizeSignal(signal, h4Slice, closedH4End, i, total);
      }
    } else {
      const total = h4.length - H4_WARMUP - 1;

      for (let i = H4_WARMUP; i < h4.length - 1; i++) {
        const h4Ts = new Date(h4[i + 1].datetime);
        const h4Ms = h4Ts.getTime();

        if (enforceSingleTradeLock && tradeEndTime && h4Ms <= tradeEndTime) {
          skips.inTrade++;
          continue;
        }

        while (h1End < h1.length - 1 && tsOf(h1, h1End + 1) <= h4Ms) h1End++;
        while (h2End < h2.length - 1 && tsOf(h2, h2End + 1) <= h4Ms) h2End++;
        while (d1End < d1.length - 1 && tsOf(d1, d1End + 1) <= h4Ms) d1End++;
        while (w1End < w1.length - 1 && tsOf(w1, w1End + 1) <= h4Ms) w1End++;
        while (m30 && m30End < m30.length - 1 && tsOf(m30, m30End + 1) <= h4Ms) m30End++;
        while (m15 && m15End < m15.length - 1 && tsOf(m15, m15End + 1) <= h4Ms) m15End++;

        const h4Slice = h4.slice(Math.max(0, i - 99), i + 1);
        const h2Slice = h2.slice(Math.max(0, h2End - 99), h2End + 1);
        const h1Slice = h1.slice(Math.max(0, h1End - 99), h1End + 1);
        const d1Slice = d1.slice(Math.max(0, d1End - 99), d1End + 1);
        const w1Slice = w1.slice(Math.max(0, w1End - 51), w1End + 1);
        const m30Slice = m30 ? m30.slice(Math.max(0, m30End - 99), m30End + 1) : null;
        const m15Slice = m15 ? m15.slice(Math.max(0, m15End - 99), m15End + 1) : null;

        const { signal, skipReason } = this._analyzeSnapshot(symbol, h4Slice, h2Slice, h1Slice, d1Slice, w1Slice, h4Ts, m30Slice, m15Slice);
        if (!signal) {
          if (skipReason) skips[skipReason] = (skips[skipReason] || 0) + 1;
          continue;
        }

        await finalizeSignal(signal, h4Slice, i, i - H4_WARMUP, total);
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
