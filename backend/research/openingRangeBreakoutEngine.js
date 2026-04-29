'use strict';

const { ScalpContinuationEngine } = require('./scalpContinuationEngine');

class OpeningRangeBreakoutEngine extends ScalpContinuationEngine {
  constructor(options = {}) {
    super({
      ...options,
      researchOptions: {
        orbRangeMinutes: 60,
        orbMaxEntryMinutes: 180,
        orbTimeStopHours: 12,
        orbCooldownBars: 24,
        orbMinRangeAtr: 0.4,
        orbMaxRangeAtr: 1.8,
        scalpMinR: 2.0,
        scalpMaxHoldBars: 48,
        ...(options.researchOptions || {}),
      },
    });
  }

  async runOrbBacktest(symbol, yearsBack = 2, seriesOverride = null) {
    const bundle = seriesOverride || await this._buildSeriesBundle(symbol, yearsBack);
    const { m15, m30, h1, h2, h4, d1, w1 } = bundle;
    if (!m15 || !m30) return this._emptyReport(symbol, yearsBack, 'noM15');

    const trades = [];
    const signals = [];
    const skips = { weekend: 0, session: 0, range: 0, setup: 0, regime: 0, policy: 0, levels: 0, cooldown: 0 };
    const sessionState = new Map();
    let h1End = 0, h2End = 0, h4End = 0, d1End = 0, w1End = 0, m30End = 0;
    let cooldownUntil = -1;
    const tsOf = (arr, j) => this._tsMs(arr[j].datetime);
    const warmup = 500;

    for (let i = warmup; i < m15.length - 2; i++) {
      const ts = this._normalizeUtc(m15[i].datetime);
      const ms = ts.getTime();
      if (this._isWeekendEntryBlocked(ts)) {
        skips.weekend++;
        continue;
      }
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
      const session = activeSess[0];
      if (!['LONDON', 'NEW_YORK', 'OVERLAP'].includes(session.label)) {
        skips.session++;
        continue;
      }

      const rangeInfo = this._sessionRangeState(sessionState, symbol, session, ts, m15[i]);
      if (!rangeInfo.ready) {
        skips.range++;
        continue;
      }
      if (rangeInfo.traded || rangeInfo.minutesFromStart > Number(this.researchOptions.orbMaxEntryMinutes || 180)) {
        skips.range++;
        continue;
      }

      const mkt = {
        weekly: this._buildTF(w1.slice(Math.max(0, w1End - 51), w1End + 1)),
        daily: this._buildTF(d1.slice(Math.max(0, d1End - 99), d1End + 1)),
        h4: this._buildTF(h4.slice(Math.max(0, h4End - 99), h4End + 1)),
        h2: this._buildTF(h2.slice(Math.max(0, h2End - 99), h2End + 1)),
        h1: this._buildTF(h1.slice(Math.max(0, h1End - 99), h1End + 1)),
        m30: this._buildTF(m30.slice(Math.max(0, m30End - 99), m30End + 1)),
        m15: this._buildTF(m15.slice(Math.max(0, i - 99), i + 1)),
        intermarket: this._resolveIntermarket(symbol, ts),
      };

      const regime = this.brain1._regime(mkt);
      if (!regime.signalAllowed) {
        skips.regime++;
        continue;
      }

      const setup = this._orbSetup(mkt, rangeInfo, regime.label);
      if (!setup.valid) {
        skips.setup++;
        continue;
      }

      const levels = this._orbLevels(mkt, setup.direction, rangeInfo);
      if (!levels.valid) {
        skips.levels++;
        continue;
      }

      const tier = this.brain1._tier(setup.score);
      const signal = {
        symbol,
        direction: setup.direction,
        entry_type: 'OPENING_RANGE_BREAKOUT',
        entry_price: levels.entry,
        stop_loss: levels.sl,
        tp1: levels.tp1,
        tp2: levels.tp2,
        atr_value: mkt.m15.atr,
        rr_ratio: levels.rr,
        confluence_score: setup.score,
        confidence_tier: tier.label,
        risk_pct: tier.riskPct,
        session: session.label,
        regime: regime.label,
        level_type: `${session.label}_ORB`,
        adx_value: mkt.h1?.adx ?? mkt.h4?.adx,
        timestamp: ts.toISOString(),
        month: ts.toISOString().slice(0, 7),
      };

      const policy = this._executionPolicy(signal);
      if (!policy.allowed) {
        skips.policy++;
        continue;
      }

      const future = m15.slice(i + 1, i + 1 + Number(this.researchOptions.scalpMaxHoldBars || 48));
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
      rangeInfo.traded = true;
      cooldownUntil = i + Number(this.researchOptions.orbCooldownBars || 24);
    }

    return this._buildReport(symbol, yearsBack, signals, trades, m15.length, skips, signals.length);
  }

  _sessionRangeState(store, symbol, session, ts, candle) {
    const startHour = session.label === 'OVERLAP' ? 13 : session.start;
    const sessionStartMs = Date.UTC(
      ts.getUTCFullYear(),
      ts.getUTCMonth(),
      ts.getUTCDate(),
      startHour,
      0,
      0,
      0
    );
    const minutesFromStart = Math.floor((ts.getTime() - sessionStartMs) / 60000);
    const key = `${symbol}:${session.label}:${ts.toISOString().slice(0, 10)}`;
    if (!store.has(key)) {
      store.set(key, {
        rangeHigh: candle.high,
        rangeLow: candle.low,
        bars: 1,
        ready: false,
        traded: false,
      });
    }

    const state = store.get(key);
    if (minutesFromStart < 0) return { ...state, minutesFromStart, ready: false };

    if (minutesFromStart < Number(this.researchOptions.orbRangeMinutes || 60)) {
      state.rangeHigh = Math.max(state.rangeHigh, candle.high);
      state.rangeLow = Math.min(state.rangeLow, candle.low);
      state.bars += 1;
      state.ready = false;
      return { ...state, minutesFromStart };
    }

    state.ready = true;
    return { ...state, minutesFromStart };
  }

  _orbTrendBias(mkt) {
    const daily = this.brain1._bias(mkt.daily, this.brain1.strategy.dailySwings);
    const h4 = this.brain1._bias(mkt.h4, this.brain1.strategy.h4Swings);
    const h1 = this.brain1._bias(mkt.h1, 2);

    if (daily === h4 && daily !== 'NEUTRAL') return daily;
    if (daily === 'NEUTRAL' && h4 === h1 && h4 !== 'NEUTRAL') return h4;
    if (h4 !== 'NEUTRAL' && h4 === h1) return h4;
    return 'NEUTRAL';
  }

  _orbSetup(mkt, rangeInfo, regime) {
    const m15 = mkt.m15;
    const h1 = mkt.h1;
    if (!m15 || !h1 || !rangeInfo.ready) return { valid: false };

    const last = m15.candles[m15.candles.length - 1];
    const atr = m15.atr || h1.atr || 0;
    if (!atr) return { valid: false };

    const rangeSize = Math.abs(rangeInfo.rangeHigh - rangeInfo.rangeLow);
    const minRange = atr * Number(this.researchOptions.orbMinRangeAtr || 0.4);
    const maxRange = atr * Number(this.researchOptions.orbMaxRangeAtr || 1.8);
    if (!Number.isFinite(rangeSize) || rangeSize < minRange || rangeSize > maxRange) return { valid: false };

    const buffer = atr * 0.08;
    const body = Math.abs(last.close - last.open);
    const candleRange = Math.max(last.high - last.low, 1e-9);
    const bodyStrong = body / candleRange >= 0.4;
    const volumeAvg = m15.volumes.slice(-21, -1).reduce((sum, v) => sum + v, 0) / 20 || 0;
    const volumeOk = volumeAvg <= 0 || (last.volume || 0) >= volumeAvg * 1.05;
    const bias = this._orbTrendBias(mkt);
    const adx = Number(h1.adx || mkt.h4?.adx || 20);

    let direction = null;
    if (last.close > rangeInfo.rangeHigh + buffer) direction = 'BUY';
    if (last.close < rangeInfo.rangeLow - buffer) direction = 'SELL';
    if (!direction || !bodyStrong || !volumeOk) return { valid: false };
    if (bias !== 'NEUTRAL' && bias !== direction) return { valid: false };
    if (!['TRENDING', 'WEAK_TREND'].includes(regime)) return { valid: false };
    if (!Number.isFinite(adx) || adx < 15 || adx > 45) return { valid: false };

    const rsi = Number(m15.rsi || 50);
    const rsiOk = direction === 'BUY' ? rsi >= 52 && rsi <= 78 : rsi >= 22 && rsi <= 48;
    if (!rsiOk) return { valid: false };

    let score = 4;
    if (bias === direction) score++;
    if (adx >= 20 && adx <= 35) score++;

    return {
      valid: true,
      direction,
      score: Math.min(score, 6),
    };
  }

  _orbLevels(mkt, direction, rangeInfo) {
    const entry = mkt.m15.closes[mkt.m15.closes.length - 1];
    const atr = mkt.m15.atr || mkt.h1?.atr || 0;
    if (!atr) return { valid: false };

    const sl = direction === 'BUY'
      ? rangeInfo.rangeLow - atr * 0.1
      : rangeInfo.rangeHigh + atr * 0.1;
    const risk = Math.abs(entry - sl);
    if (!Number.isFinite(risk) || risk <= 0 || risk < atr * 0.3 || risk > atr * 2.5) return { valid: false };

    const rr = Number(this.researchOptions.scalpMinR || 2.0);
    const tp1 = direction === 'BUY' ? entry + risk : entry - risk;
    const tp2 = direction === 'BUY' ? entry + risk * rr : entry - risk * rr;
    return { valid: true, entry, sl, tp1, tp2, rr };
  }
}

module.exports = { OpeningRangeBreakoutEngine };
