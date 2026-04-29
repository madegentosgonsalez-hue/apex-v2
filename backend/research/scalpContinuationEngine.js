'use strict';

const Backtester = require('../backtest');

const SCALP_SESSION_CONFIG = {
  ASIAN:    { label: 'ASIAN', start: 0,  end: 8,  pairs: ['AUDUSD', 'EURJPY', 'GBPJPY'] },
  LONDON:   { label: 'LONDON', start: 8,  end: 16, pairs: ['EURUSD', 'GBPUSD', 'USDCHF', 'XAUUSD'] },
  NEW_YORK: { label: 'NEW_YORK', start: 13, end: 21, pairs: ['EURUSD', 'GBPUSD', 'USDCAD', 'XAUUSD', 'GBPJPY'] },
  OVERLAP:  { label: 'OVERLAP', start: 13, end: 16, pairs: ['EURUSD', 'GBPUSD', 'XAUUSD', 'GBPJPY', 'USDCAD', 'USDCHF', 'EURJPY', 'AUDUSD'] },
};

class ScalpContinuationEngine extends Backtester {
  constructor(options = {}) {
    super({
      ...options,
      sessionConfig: options.sessionConfig || SCALP_SESSION_CONFIG,
      researchOptions: {
        scalpTimeStopHours: 12,
        scalpMaxHoldBars: 96,
        scalpCooldownBars: 8,
        scalpMinR: 1.6,
        ...(options.researchOptions || {}),
      },
    });
  }

  async runScalpBacktest(symbol, yearsBack = 2, seriesOverride = null) {
    const bundle = seriesOverride || await this._buildSeriesBundle(symbol, yearsBack);
    const { m15, m30, h1, h2, h4, d1, w1 } = bundle;

    if (!m15 || !m30) {
      return this._emptyReport(symbol, yearsBack, 'noM15');
    }

    const trades = [];
    const signals = [];
    const skips = { session: 0, regime: 0, bias: 0, setup: 0, policy: 0, levels: 0, cooldown: 0 };
    let h1End = 0, h2End = 0, h4End = 0, d1End = 0, w1End = 0, m30End = 0;
    let cooldownUntil = -1;
    const tsOf = (arr, j) => new Date(arr[j].datetime).getTime();
    const warmup = 500;

    for (let i = warmup; i < m15.length - 2; i++) {
      const ts = new Date(m15[i].datetime);
      const ms = ts.getTime();
      if (i < cooldownUntil) {
        skips.cooldown++;
        continue;
      }

      while (h1End < h1.length - 1 && tsOf(h1, h1End + 1) <= ms) h1End++;
      while (h2End < h2.length - 1 && tsOf(h2, h2End + 1) <= ms) h2End++;
      while (h4End < h4.length - 1 && tsOf(h4, h4End + 1) <= ms) h4End++;
      while (d1End < d1.length - 1 && tsOf(d1, d1End + 1) <= ms) d1End++;
      while (w1End < w1.length - 1 && tsOf(w1, w1End + 1) <= ms) w1End++;
      while (m30End < m30.length - 1 && tsOf(m30, m30End + 1) <= ms) m30End++;

      if (h4End < 200 || d1End < 50 || w1End < 20 || m30End < 80) continue;

      const utcH = ts.getUTCHours();
      const activeSess = this._activeSessionsFor(symbol, utcH);
      if (!activeSess.length) {
        skips.session++;
        continue;
      }
      const session = this._sessionLabel(activeSess);

      const mkt = {
        weekly:      this._buildTF(w1.slice(Math.max(0, w1End - 51), w1End + 1)),
        daily:       this._buildTF(d1.slice(Math.max(0, d1End - 99), d1End + 1)),
        h4:          this._buildTF(h4.slice(Math.max(0, h4End - 99), h4End + 1)),
        h2:          this._buildTF(h2.slice(Math.max(0, h2End - 99), h2End + 1)),
        h1:          this._buildTF(h1.slice(Math.max(0, h1End - 99), h1End + 1)),
        m30:         this._buildTF(m30.slice(Math.max(0, m30End - 99), m30End + 1)),
        m15:         this._buildTF(m15.slice(Math.max(0, i - 99), i + 1)),
        intermarket: this._resolveIntermarket(symbol, ts),
      };

      const regime = this.brain1._regime(mkt);
      if (!regime.signalAllowed) {
        skips.regime++;
        continue;
      }

      const bias = this.brain1._topDownBias(mkt);
      if (bias.direction === 'NEUTRAL') {
        skips.bias++;
        continue;
      }

      const setup = this._scalpSetup(mkt, bias.direction, regime.label);
      if (!setup.valid) {
        skips.setup++;
        continue;
      }

      const levels = this._scalpLevels(mkt, bias.direction);
      if (!levels.valid) {
        skips.levels++;
        continue;
      }

      const tier = this.brain1._tier(setup.score);
      const signal = {
        symbol,
        direction: bias.direction,
        entry_type: 'SCALP_CONTINUATION',
        entry_price: levels.entry,
        stop_loss: levels.sl,
        tp1: levels.tp1,
        tp2: levels.tp2,
        atr_value: mkt.m15.atr,
        rr_ratio: levels.rr,
        confluence_score: setup.score,
        confidence_tier: tier.label,
        risk_pct: tier.riskPct,
        session,
        regime: regime.label,
        level_type: setup.type,
        adx_value: mkt.h4.adx,
        timestamp: ts.toISOString(),
        month: ts.toISOString().slice(0, 7),
      };

      const policy = this._executionPolicy(signal);
      if (!policy.allowed) {
        skips.policy++;
        continue;
      }

      const future = m15.slice(i + 1, i + 1 + Number(this.researchOptions.scalpMaxHoldBars || 96));
      const exit = this._simulateScalp(signal, future);
      if (!exit) continue;

      signals.push(signal);
      trades.push({
        symbol,
        entryTime: signal.timestamp,
        exitTime: exit.exitTime,
        direction: signal.direction,
        entryType: signal.entry_type,
        tier: signal.confidence_tier,
        session: signal.session,
        regime: signal.regime,
        hourUTC: ts.getUTCHours(),
        levelType: signal.level_type,
        confluence: signal.confluence_score,
        adx: signal.adx_value,
        month: signal.month,
        r: exit.r,
        win: exit.r > 0,
        exitReason: exit.exitReason,
      });
      cooldownUntil = i + Number(this.researchOptions.scalpCooldownBars || 8);
    }

    return this._buildReport(symbol, yearsBack, signals, trades, m15.length, skips, signals.length);
  }

  _scalpSetup(mkt, dir, regime) {
    const m15 = mkt.m15;
    const m30 = mkt.m30;
    if (!m15 || !m30 || m15.candles.length < 30 || m30.candles.length < 30) return { valid: false };

    const price = m15.closes[m15.closes.length - 1];
    const atr = m15.atr || 0;
    if (!atr) return { valid: false };

    const m15Trend = dir === 'BUY'
      ? price > m15.ema21 && m15.ema21 > m15.ema50
      : price < m15.ema21 && m15.ema21 < m15.ema50;
    const m30Price = m30.closes[m30.closes.length - 1];
    const m30Trend = dir === 'BUY'
      ? m30Price > m30.ema21 && m30.ema21 > m30.ema50
      : m30Price < m30.ema21 && m30.ema21 < m30.ema50;
    if (!m15Trend || !m30Trend) return { valid: false };

    const recent = m15.candles.slice(-8);
    const last = recent[recent.length - 1];
    const range = Math.max(last.high - last.low, 1e-9);
    const body = Math.abs(last.close - last.open);
    const momentum = dir === 'BUY'
      ? last.close > last.open && body / range >= 0.45
      : last.close < last.open && body / range >= 0.45;

    const pullback = dir === 'BUY'
      ? recent.some(c => c.low <= m15.ema21 + atr * 0.25) && last.close > m15.ema21
      : recent.some(c => c.high >= m15.ema21 - atr * 0.25) && last.close < m15.ema21;

    const prior = m15.candles.slice(-18, -3);
    const priorLow = Math.min(...prior.map(c => c.low));
    const priorHigh = Math.max(...prior.map(c => c.high));
    const sweep = dir === 'BUY'
      ? recent.some(c => c.low < priorLow) && last.close > priorLow
      : recent.some(c => c.high > priorHigh) && last.close < priorHigh;

    if (!momentum || (!pullback && !sweep)) return { valid: false };

    const rsi = m15.rsi || 50;
    const rsiOk = dir === 'BUY' ? rsi >= 45 && rsi <= 72 : rsi >= 28 && rsi <= 55;
    const h4AdxOk = (mkt.h4?.adx || 20) <= 45;
    if (!rsiOk || !h4AdxOk) return { valid: false };

    let score = 4;
    if (m30Trend) score++;
    if (sweep) score++;
    if (regime === 'WEAK_TREND' || regime === 'TRENDING') score++;
    score = Math.min(score, 6);

    return { valid: true, score, type: sweep ? 'M15_SWEEP_CONTINUATION' : 'M15_EMA_CONTINUATION' };
  }

  _scalpLevels(mkt, dir) {
    const m15 = mkt.m15;
    const entry = m15.closes[m15.closes.length - 1];
    const atr = m15.atr || 0;
    if (!atr) return { valid: false };

    let sl;
    if (dir === 'BUY') {
      const lows = (m15.swingLows || []).filter(v => v < entry).slice(-5);
      sl = lows.length ? Math.max(...lows) - atr * 0.25 : entry - atr * 1.5;
    } else {
      const highs = (m15.swingHighs || []).filter(v => v > entry).slice(-5);
      sl = highs.length ? Math.min(...highs) + atr * 0.25 : entry + atr * 1.5;
    }

    const risk = Math.abs(entry - sl);
    if (!Number.isFinite(risk) || risk <= 0 || risk > atr * 3.0 || risk < atr * 0.35) return { valid: false };
    const rr = Number(this.researchOptions.scalpMinR || 1.6);
    const tp1 = dir === 'BUY' ? entry + risk : entry - risk;
    const tp2 = dir === 'BUY' ? entry + risk * rr : entry - risk * rr;
    return { valid: true, entry, sl, tp1, tp2, rr, atr };
  }

  _simulateScalp(signal, futureM15) {
    const entry = Number(signal.entry_price);
    const sl = Number(signal.stop_loss);
    const tp1 = Number(signal.tp1);
    const tp2 = Number(signal.tp2);
    const risk = Math.abs(entry - sl);
    if (!risk || !futureM15.length) return null;

    const isBuy = signal.direction === 'BUY';
    const entryMs = new Date(signal.timestamp).getTime();
    const timeStopHours = Number(this.researchOptions.scalpTimeStopHours || 12);
    let tp1Done = false;
    let totalR = 0;

    for (const c of futureM15) {
      const elapsedHours = (new Date(c.datetime).getTime() - entryMs) / 36e5;
      const slLevel = tp1Done ? entry : sl;
      const slHit = isBuy ? c.low <= slLevel : c.high >= slLevel;
      if (slHit) {
        return {
          r: Number((tp1Done ? totalR : -1).toFixed(2)),
          exitReason: tp1Done ? 'SCALP_BE' : 'SCALP_SL',
          exitTime: c.datetime,
        };
      }

      if (!tp1Done && (isBuy ? c.high >= tp1 : c.low <= tp1)) {
        tp1Done = true;
        totalR += 0.5;
      }

      if (isBuy ? c.high >= tp2 : c.low <= tp2) {
        totalR += 0.5 * Number(signal.rr_ratio || 1.6);
        return { r: Number(totalR.toFixed(2)), exitReason: 'SCALP_TP', exitTime: c.datetime };
      }

      if (elapsedHours >= timeStopHours) {
        const closeR = isBuy ? (c.close - entry) / risk : (entry - c.close) / risk;
        const rem = tp1Done ? 0.5 : 1;
        return {
          r: Number((totalR + closeR * rem).toFixed(2)),
          exitReason: 'SCALP_TIME_STOP',
          exitTime: c.datetime,
        };
      }
    }

    const last = futureM15[futureM15.length - 1];
    const openR = isBuy ? (last.close - entry) / risk : (entry - last.close) / risk;
    return { r: Number(openR.toFixed(2)), exitReason: 'SCALP_OPEN_AT_END', exitTime: last.datetime };
  }

  _emptyReport(symbol, yearsBack, reason) {
    return {
      provider: 'none',
      symbol,
      yearsBack,
      summary: {
        totalTrades: 0,
        totalSignals: 0,
        candidateSignals: 0,
        avgSignalsPerMonth: 0,
        winRate: 0,
        winsCount: 0,
        lossCount: 0,
        totalR: 0,
        avgR: 0,
        largestWin: 0,
        largestLoss: 0,
        maxConsecutiveWins: 0,
        maxConsecutiveLosses: 0,
        profitFactor: 0,
        signalRate: 0,
      },
      tradeLog: [],
      skipCounts: { [reason]: 1 },
    };
  }
}

class RangeReversionEngine extends ScalpContinuationEngine {
  async runRangeBacktest(symbol, yearsBack = 2, seriesOverride = null) {
    const bundle = seriesOverride || await this._buildSeriesBundle(symbol, yearsBack);
    const { m15, m30, h1, h2, h4, d1, w1 } = bundle;
    if (!m15 || !m30) return this._emptyReport(symbol, yearsBack, 'noM15');

    const trades = [];
    const signals = [];
    const skips = { session: 0, regime: 0, setup: 0, policy: 0, levels: 0, cooldown: 0 };
    let h1End = 0, h2End = 0, h4End = 0, d1End = 0, w1End = 0, m30End = 0;
    let cooldownUntil = -1;
    const tsOf = (arr, j) => new Date(arr[j].datetime).getTime();
    const warmup = 500;

    for (let i = warmup; i < m15.length - 2; i++) {
      const ts = new Date(m15[i].datetime);
      const ms = ts.getTime();
      if (i < cooldownUntil) {
        skips.cooldown++;
        continue;
      }

      while (h1End < h1.length - 1 && tsOf(h1, h1End + 1) <= ms) h1End++;
      while (h2End < h2.length - 1 && tsOf(h2, h2End + 1) <= ms) h2End++;
      while (h4End < h4.length - 1 && tsOf(h4, h4End + 1) <= ms) h4End++;
      while (d1End < d1.length - 1 && tsOf(d1, d1End + 1) <= ms) d1End++;
      while (w1End < w1.length - 1 && tsOf(w1, w1End + 1) <= ms) w1End++;
      while (m30End < m30.length - 1 && tsOf(m30, m30End + 1) <= ms) m30End++;

      if (h4End < 200 || d1End < 50 || w1End < 20 || m30End < 80) continue;

      const utcH = ts.getUTCHours();
      const activeSess = this._activeSessionsFor(symbol, utcH);
      if (!activeSess.length) {
        skips.session++;
        continue;
      }
      const session = this._sessionLabel(activeSess);

      const mkt = {
        weekly:      this._buildTF(w1.slice(Math.max(0, w1End - 51), w1End + 1)),
        daily:       this._buildTF(d1.slice(Math.max(0, d1End - 99), d1End + 1)),
        h4:          this._buildTF(h4.slice(Math.max(0, h4End - 99), h4End + 1)),
        h2:          this._buildTF(h2.slice(Math.max(0, h2End - 99), h2End + 1)),
        h1:          this._buildTF(h1.slice(Math.max(0, h1End - 99), h1End + 1)),
        m30:         this._buildTF(m30.slice(Math.max(0, m30End - 99), m30End + 1)),
        m15:         this._buildTF(m15.slice(Math.max(0, i - 99), i + 1)),
        intermarket: this._resolveIntermarket(symbol, ts),
      };

      const regime = this.brain1._regime(mkt);
      if (!regime.signalAllowed || !['RANGING', 'WEAK_TREND'].includes(regime.label)) {
        skips.regime++;
        continue;
      }

      const setup = this._rangeSetup(mkt);
      if (!setup.valid) {
        skips.setup++;
        continue;
      }

      const levels = this._rangeLevels(mkt, setup.direction);
      if (!levels.valid) {
        skips.levels++;
        continue;
      }

      const tier = this.brain1._tier(setup.score);
      const signal = {
        symbol,
        direction: setup.direction,
        entry_type: 'RANGE_REVERSION',
        entry_price: levels.entry,
        stop_loss: levels.sl,
        tp1: levels.tp1,
        tp2: levels.tp2,
        atr_value: mkt.m15.atr,
        rr_ratio: levels.rr,
        confluence_score: setup.score,
        confidence_tier: tier.label,
        risk_pct: tier.riskPct,
        session,
        regime: regime.label,
        level_type: setup.type,
        adx_value: mkt.h4.adx,
        timestamp: ts.toISOString(),
        month: ts.toISOString().slice(0, 7),
      };

      const policy = this._executionPolicy(signal);
      if (!policy.allowed) {
        skips.policy++;
        continue;
      }

      const future = m15.slice(i + 1, i + 1 + Number(this.researchOptions.rangeMaxHoldBars || 64));
      const exit = this._simulateScalp(signal, future);
      if (!exit) continue;

      signals.push(signal);
      trades.push({
        symbol,
        entryTime: signal.timestamp,
        exitTime: exit.exitTime,
        direction: signal.direction,
        entryType: signal.entry_type,
        tier: signal.confidence_tier,
        session: signal.session,
        regime: signal.regime,
        hourUTC: ts.getUTCHours(),
        levelType: signal.level_type,
        confluence: signal.confluence_score,
        adx: signal.adx_value,
        month: signal.month,
        r: exit.r,
        win: exit.r > 0,
        exitReason: exit.exitReason,
      });
      cooldownUntil = i + Number(this.researchOptions.rangeCooldownBars || 6);
    }

    return this._buildReport(symbol, yearsBack, signals, trades, m15.length, skips, signals.length);
  }

  _rangeSetup(mkt) {
    const m15 = mkt.m15;
    const m30 = mkt.m30;
    if (!m15 || !m30 || m15.candles.length < 60 || m30.candles.length < 40) return { valid: false };
    const atr = m15.atr || 0;
    if (!atr || (mkt.h4?.adx || 20) > 22) return { valid: false };

    const recent = m15.candles.slice(-4);
    const last = recent[recent.length - 1];
    const prior = m15.candles.slice(-44, -4);
    const priorHigh = Math.max(...prior.map(c => c.high));
    const priorLow = Math.min(...prior.map(c => c.low));
    const rangeSize = priorHigh - priorLow;
    if (!Number.isFinite(rangeSize) || rangeSize < atr * 2.2 || rangeSize > atr * 9) return { valid: false };

    const sweptHigh = recent.some(c => c.high > priorHigh + atr * 0.05) && last.close < priorHigh;
    const sweptLow = recent.some(c => c.low < priorLow - atr * 0.05) && last.close > priorLow;
    if (!sweptHigh && !sweptLow) return { valid: false };

    const direction = sweptLow ? 'BUY' : 'SELL';
    const rsi = m15.rsi || 50;
    const rsiOk = direction === 'BUY' ? rsi <= 45 : rsi >= 55;
    if (!rsiOk) return { valid: false };

    const m30Price = m30.closes[m30.closes.length - 1];
    const stretched = direction === 'BUY'
      ? m30Price < m30.ema21 || m15.closes[m15.closes.length - 1] < m15.ema21
      : m30Price > m30.ema21 || m15.closes[m15.closes.length - 1] > m15.ema21;
    if (!stretched) return { valid: false };

    let score = 4;
    if (rangeSize >= atr * 3) score++;
    if ((mkt.h4?.adx || 20) < 15) score++;
    return { valid: true, direction, score: Math.min(score, 6), type: sweptLow ? 'LOW_SWEEP_REVERSION' : 'HIGH_SWEEP_REVERSION' };
  }

  _rangeLevels(mkt, dir) {
    const m15 = mkt.m15;
    const entry = m15.closes[m15.closes.length - 1];
    const atr = m15.atr || 0;
    if (!atr) return { valid: false };

    const recent = m15.candles.slice(-44, -1);
    let sl;
    if (dir === 'BUY') {
      sl = Math.min(...recent.map(c => c.low)) - atr * 0.2;
    } else {
      sl = Math.max(...recent.map(c => c.high)) + atr * 0.2;
    }

    const risk = Math.abs(entry - sl);
    if (!Number.isFinite(risk) || risk < atr * 0.35 || risk > atr * 2.2) return { valid: false };
    const rr = Number(this.researchOptions.rangeMinR || 1.35);
    const tp1 = dir === 'BUY' ? entry + risk : entry - risk;
    const tp2 = dir === 'BUY' ? entry + risk * rr : entry - risk * rr;
    return { valid: true, entry, sl, tp1, tp2, rr };
  }
}

module.exports = { ScalpContinuationEngine, RangeReversionEngine };
