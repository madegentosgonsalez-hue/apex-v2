'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// APEX BACKTEST ENGINE
// Fetches 1 year historical 1H OHLC from Twelve Data, aggregates into all
// required timeframes, replays Brain1 analysis on each H4 candle close,
// simulates 40/40/20 exit model, generates comprehensive report.
// Brain1/Brain2/Brain3 logic is NOT modified — only simulated on historical data.
// ═══════════════════════════════════════════════════════════════════════════

const Brain1       = require('./engines/brain1-signal');
const { SIGNAL_RULES } = require('./utils/constants');

// Minimal mocks so Brain1 can run without live DB/news/data calls
const MOCK_NEWS = { checkBlackout: async () => ({ blocked: false }) };
const MOCK_DB   = {
  getPair:                async () => null,
  checkDailyLossLimit:    async () => ({ limitHit: false }),
  getActiveSignalForPair: async () => null,
  query:                  async () => ({ rows: [] }),
};

class Backtester {
  constructor({ dataService }) {
    this.data   = dataService;
    this.brain1 = new Brain1({ dataService, newsService: MOCK_NEWS, db: MOCK_DB });
  }

  // ── INDICATOR MATH ──────────────────────────────────────────────────────

  _ema(closes, period) {
    if (!closes.length) return null;
    if (closes.length < period) {
      // Not enough bars for true EMA — SMA approximation so nulls don't block bias
      return closes.reduce((a, b) => a + b, 0) / closes.length;
    }
    const k = 2 / (period + 1);
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
    const tdSym = symbol === 'XAUUSD' ? 'XAU/USD'
                : /^[A-Z]{6}$/.test(symbol) ? `${symbol.slice(0,3)}/${symbol.slice(3)}`
                : symbol;

    const end   = new Date();
    const start = new Date();
    start.setFullYear(start.getFullYear() - yearsBack);

    const key = process.env.TWELVE_DATA_API_KEY;
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSym)}&interval=1h&outputsize=5000&start_date=${start.toISOString().slice(0,10)}&end_date=${end.toISOString().slice(0,10)}&apikey=${key}&format=JSON&order=ASC`;

    const resp = await fetch(url);
    const json = await resp.json();

    if (json.status === 'error' || !Array.isArray(json.values)) {
      throw new Error(json.message || 'Twelve Data: no values returned');
    }

    return json.values.map(v => ({
      datetime: v.datetime,
      open:   parseFloat(v.open),
      high:   parseFloat(v.high),
      low:    parseFloat(v.low),
      close:  parseFloat(v.close),
      volume: parseFloat(v.volume || 0),
    }));
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
        m30:         null,
        m15:         null,
        intermarket: { dxyTrend: 'UNKNOWN', vix: null, btcDominance: null },
      };
      if (!mkt.h4 || !mkt.daily || !mkt.weekly) return skip('regime');

      // Session filter first — cheapest check
      const utcH = ts.getUTCHours();
      let session = 'ASIAN';
      if (utcH >= 13 && utcH < 16)      session = 'LONDON_NY_OVERLAP';
      else if (utcH >= 8 && utcH < 13)  session = 'LONDON';
      else if (utcH >= 16 && utcH < 21) session = 'NEW_YORK';
      if (session === 'ASIAN') return skip('session');

      const regime = b._regime(mkt);
      if (!regime.signalAllowed) return skip('regime');

      const bias = b._topDownBias(mkt);
      if (bias.direction === 'NEUTRAL') return skip('bias');

      const loc = b._locationCheck(mkt, bias.direction);
      if (!loc.valid) return skip('location');

      const entryType = b._entryType(mkt, bias.direction, loc);
      if (!entryType) return skip('entryType');

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
          rr_ratio:         levels.rr,
          confluence_score: cf.score,
          confidence_tier:  tier.label,
          regime:           regime.label,
          session,
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

  async runBacktest(symbol, yearsBack = 1, onProgress = null) {
    console.log(`[Backtest] ${symbol} — fetching ${yearsBack}Y of 1H data...`);
    if (onProgress) onProgress(5, 'Fetching historical data…');

    const h1Raw = await this._fetchH1(symbol, yearsBack);
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
    let tradeEndTime = null;

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
      if (tradeEndTime && h4Ms <= tradeEndTime) { skips.inTrade++; continue; }

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
      tradeEndTime = new Date(exit.exitTime).getTime();

      if (onProgress) {
        const pct = Math.round(15 + ((i - H4_WARMUP) / total) * 75);
        onProgress(pct, `Replaying bar ${i - H4_WARMUP}/${total} — ${signals.length} signals so far`);
      }
    }

    console.log(`[Backtest] ${symbol} — skip counts:`, skips);
    if (onProgress) onProgress(95, 'Building report…');
    return this._buildReport(symbol, yearsBack, signals, trades, h4.length, skips);
  }

  // ── COMPREHENSIVE REPORT ────────────────────────────────────────────────

  _buildReport(symbol, yearsBack, signals, trades, totalBars, skips = {}) {
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
