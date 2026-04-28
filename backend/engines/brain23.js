// ═══════════════════════════════════════════════════════════════════════════
// BRAIN 2 — TRADE GUARDIAN
// Watches structure, not price. Candle CLOSE rule. No wick reactions.
// ═══════════════════════════════════════════════════════════════════════════

const { INVALIDATION, ATR, EXIT_STRATEGY } = require('../utils/constants');

class Brain2 {
  constructor({ dataService, aiAnalyst, brain3, notifier, db, newsService }) {
    this.data     = dataService;
    this.ai       = aiAnalyst;
    this.brain3   = brain3;
    this.notifier = notifier;
    this.db       = db;
    this.news     = newsService; // NEW-04 FIX: wire in news service
    // NEW-08 FIX: deduplication map — track last alert level per signal id
    this.lastAlertLevel = new Map(); // signalId → level name
  }

  async monitorAll() {
    // FIX BUG-10: Only monitor signals that are in an active TRADE state
    // ACTIVE = signal sent AND entry price reached (trade open)
    // TP1/TP2/PARTIAL = trade still running, needs monitoring
    // We exclude signals where entry was never hit (they expire via cron)
    const actives = await this.db.getActiveSignals();
    if (!actives.length) return;

    // Filter to only trades that have been entered
    // In production with broker integration, entry_hit flag would be set
    // For now, monitor all ACTIVE/TP1/TP2/PARTIAL signals conservatively
    const tradesToMonitor = actives.filter(s =>
      ['ACTIVE','TP1','TP2','PARTIAL'].includes(s.status)
    );

    if (!tradesToMonitor.length) return;
    console.log(`[Brain2] Monitoring ${tradesToMonitor.length} open trade(s)...`);
    await Promise.allSettled(tradesToMonitor.map(s => this._monitor(s)));
  }

  async _monitor(signal) {
    try {
      const mkt = await this._marketData(signal);
      if (!mkt) return;

      // Check TPs first
      const tp = this._checkTP(signal, mkt.currentPrice);
      if (tp.hit) { await this._onTP(signal, tp, mkt.currentPrice); return; }

      // Check SL (CANDLE CLOSE rule)
      if (this._slHit(signal, mkt)) { await this._onSL(signal, mkt.currentPrice); return; }

      // Expire
      if (signal.status === 'ACTIVE' && new Date() > new Date(signal.valid_until)) {
        if (!signal.entry_hit) { await this._onExpire(signal); return; }
      }

      // Flash crash
      if (this._flashCrash(mkt, signal.atr_value)) {
        await this._onEmergency(signal, mkt.currentPrice, 'Flash crash detected'); return;
      }

      // Structure analysis
      const struct = this._structureAnalysis(signal, mkt);

      // Route by level
      await this._route(signal, struct, mkt);

      // Log event
      await this.db.saveBrain2Event({
        signal_id:         signal.id,
        symbol:            signal.symbol,
        invalidation_level: struct.level.name,
        description:       struct.desc,
        price_at_event:    mkt.currentPrice,
        structure_level:   signal.stop_loss,
        alert_sent:        struct.level !== INVALIDATION.LEVEL_1,
      });

    } catch (err) {
      console.error(`[Brain2] Error monitoring ${signal.symbol}:`, err.message);
    }
  }

  // ── STRUCTURE ANALYSIS ───────────────────────────────────────────────────
  _structureAnalysis(signal, mkt) {
    const { direction } = signal;
    const lastH4 = mkt.h4Candle;
    const lastH1 = mkt.h1Candle;

    // CRITICAL: Only candle CLOSE beyond structure triggers — NOT wicks
    let h4Broken = false, h1Broken = false, volumeOnBreak = false;

    if (direction === 'BUY') {
      h4Broken = lastH4 && mkt.h4SwingLow !== null && lastH4.close < mkt.h4SwingLow;
      h1Broken = lastH1 && mkt.h1SwingLow !== null && lastH1.close < mkt.h1SwingLow;
    } else {
      h4Broken = lastH4 && mkt.h4SwingHigh !== null && lastH4.close > mkt.h4SwingHigh;
      h1Broken = lastH1 && mkt.h1SwingHigh !== null && lastH1.close > mkt.h1SwingHigh;
    }

    volumeOnBreak = mkt.volumeRatio > 1.3;

    // HTF critical — if Daily structure gone, emergency
    if (!mkt.htfTrendValid) {
      return { level: INVALIDATION.EMERGENCY, h4Broken, h1Broken, desc: 'Daily/Weekly structure broken' };
    }

    if (h4Broken && volumeOnBreak) {
      return { level: INVALIDATION.LEVEL_4, h4Broken, h1Broken, desc: 'H4 closed beyond structure with volume', volumeOnBreak };
    }

    if (h4Broken && !volumeOnBreak) {
      return { level: INVALIDATION.LEVEL_3, h4Broken, h1Broken, desc: 'H4 broke on low volume — possible liquidity sweep', volumeOnBreak };
    }

    if (h1Broken) {
      return { level: INVALIDATION.LEVEL_2, h4Broken: false, h1Broken, desc: 'H1 structure softened — H4 still intact' };
    }

    const distR = mkt.atr > 0 ? Math.abs(mkt.currentPrice - signal.stop_loss) / mkt.atr : 99;
    if (distR < 0.4) {
      return { level: INVALIDATION.LEVEL_2, desc: 'Approaching SL zone — within 0.4×ATR' };
    }

    return { level: INVALIDATION.LEVEL_1, h4Broken: false, h1Broken: false, desc: 'Normal — structure intact' };
  }

  // ── ROUTE BY LEVEL ── NEW-08 FIX: dedup alerts — only fire once per level change
  async _route(signal, struct, mkt) {
    const levelName = struct.level.name;
    const lastLevel = this.lastAlertLevel.get(signal.id);

    // Only send alert if this is a NEW level (not repeating the same level)
    const isNewLevel = levelName !== lastLevel;

    switch (levelName) {
      case 'NOISE':
        // Reset dedup when back to noise (clear last alert)
        if (lastLevel && lastLevel !== 'NOISE') {
          this.lastAlertLevel.set(signal.id, 'NOISE');
        }
        break;

      case 'WARNING':
        if (isNewLevel) {
          this.lastAlertLevel.set(signal.id, levelName);
          await this.notifier.send(this._fmt(signal, '⚠️ MONITOR', struct.desc, mkt.currentPrice), 'UPDATE');
        }
        break;

      case 'SOFT_INVALIDATION': {
        const inProfit = signal.direction === 'BUY'
          ? mkt.currentPrice > signal.entry_price
          : mkt.currentPrice < signal.entry_price;

        if (isNewLevel) {
          this.lastAlertLevel.set(signal.id, levelName);
          if (inProfit) {
            await this.db.updateSignalSL(signal.id, signal.entry_price);
            await this.notifier.send(this._fmt(signal, '🟡 THESIS WEAKENING', `${struct.desc}. SL moved to breakeven.`, mkt.currentPrice), 'UPDATE');
          } else {
            await this.notifier.send(this._fmt(signal, '🟡 SOFT INVALIDATION', struct.desc, mkt.currentPrice), 'UPDATE');
          }
        }
        break;
      }

      case 'HARD_INVALIDATION': {
        // Hard invalidation always acts — even if repeated — because Brain3 may exit
        // But only ask AI once (Brain3 closes the signal anyway)
        this.lastAlertLevel.set(signal.id, levelName);
        const aiCheck = await this.ai.monitorTrade(signal, {
          currentPrice:       mkt.currentPrice,
          h4StructureBroken:  struct.h4Broken,
          h1StructureBroken:  struct.h1Broken,
          htfTrendValid:      mkt.htfTrendValid,
          volumeOnBreak:      struct.volumeOnBreak,
          candleClosedBeyond: struct.h4Broken,
          newsApproaching:    mkt.newsApproaching,
          newsMins:           mkt.newsMins,
        });

        if (aiCheck.is_liquidity_sweep) {
          if (isNewLevel) {
            const tighter = signal.direction === 'BUY'
              ? signal.stop_loss + signal.atr_value * 0.3
              : signal.stop_loss - signal.atr_value * 0.3;
            await this.db.updateSignalSL(signal.id, tighter);
            await this.notifier.send(this._fmt(signal, '🔴 POSSIBLE STOP HUNT', `AI: liquidity sweep suspected. SL tightened.`, mkt.currentPrice), 'UPDATE');
          }
        } else {
          await this.brain3.arbitrate(signal, mkt, aiCheck);
          // Clear dedup after Brain3 acts (signal will close)
          this.lastAlertLevel.delete(signal.id);
        }
        break;
      }

      case 'EMERGENCY':
        this.lastAlertLevel.delete(signal.id); // Signal closing — clear dedup
        await this._onEmergency(signal, mkt.currentPrice, struct.desc);
        break;
    }
  }

  // ── EVENT HANDLERS ────────────────────────────────────────────────────────
  async _onTP(signal, tp, price) {
    if (tp.level === 'TP1') {
      await this.db.updateSignalStatus(signal.id, 'TP1');
      await this.db.updateSignalSL(signal.id, signal.entry_price);
      const msg = `✅ TP1 HIT — ${signal.symbol}
━━━━━━━━━━━━━━━━━━━━━━━
Direction : ${signal.direction}
Entry     : ${signal.entry_price}
TP1 Price : ${signal.tp1}
Banked    : +2.0R on 40%
━━━━━━━━━━━━━━━━━━━━━━━
✅ SL → BREAKEVEN
🎯 Riding 60% to TP2 (${signal.tp2})`;
      await this.notifier.send(msg, 'TP_HIT');
    } else {
      await this.db.updateSignalStatus(signal.id, 'TP2');
      await this.db.updateSignalSL(signal.id, signal.tp1);
      const msg = `✅ TP2 HIT — ${signal.symbol}
━━━━━━━━━━━━━━━━━━━━━━━
TP2 Price : ${signal.tp2}
Banked    : +3.0R on another 40%
━━━━━━━━━━━━━━━━━━━━━━━
🏃 Trailing 20% — SL at TP1
Let it run.`;
      await this.notifier.send(msg, 'TP_HIT');
    }
  }

  // ── SL HIT HANDLER ── FIX BUG-06: calculate actual pnlR, don't hardcode -1.0
  // SL may have been moved to breakeven → pnlR = 0 not -1.0
  async _onSL(signal, price) {
    const risk  = Math.abs(signal.entry_price - signal.stop_loss);
    const dir   = signal.direction === 'BUY' ? 1 : -1;
    // FIX BUG-05: use parseFloat to ensure number not string
    const pnlR  = risk > 0 ? parseFloat(((price - signal.entry_price) * dir / risk).toFixed(2)) : -1.0;

    await this.db.closeSignal(signal.id, price, 'SL_HIT', pnlR);
    const msg = `🔴 STOP LOSS — ${signal.symbol}
━━━━━━━━━━━━━━━━━━━━━━━
Direction : ${signal.direction}
Entry     : ${signal.entry_price}
Exit      : ${price}
Result    : ${pnlR >= 0 ? '+' : ''}${pnlR.toFixed(2)}R
━━━━━━━━━━━━━━━━━━━━━━━
Trade archived. Lesson stored.
Composure. Next setup.`;
    await this.notifier.send(msg, 'SL_HIT');
  }

  async _onEmergency(signal, price, reason) {
    await this.db.closeSignal(signal.id, price, 'EMERGENCY_EXIT', null);
    const msg = `🚨 EMERGENCY EXIT — ${signal.symbol}
━━━━━━━━━━━━━━━━━━━━━━━
Reason : ${reason}
Price  : ${price}
━━━━━━━━━━━━━━━━━━━━━━━
EXIT IMMEDIATELY. No hesitation.`;
    await this.notifier.send(msg, 'EMERGENCY');
  }

  async _onExpire(signal) {
    await this.db.closeSignal(signal.id, null, 'EXPIRED', null);
    await this.notifier.send(`⏱ SIGNAL EXPIRED — ${signal.symbol}\nEntry never triggered within validity window.\nArchived for learning.`, 'UPDATE');
  }

  // ── TP CHECK ─────────────────────────────────────────────────────────────
  // TP1 reachable from ACTIVE and WARNING (Brain2 warned but trade still open)
  // TP2 reachable from TP1 and PARTIAL (Brain3 partial exit still rides to TP2)
  _checkTP(signal, price) {
    const { direction, tp1, tp2, status } = signal;

    // TP1 check: not yet reached TP1 — includes WARNING status (trade still live)
    if (['ACTIVE', 'WARNING'].includes(status)) {
      const hit = direction === 'BUY' ? price >= tp1 : price <= tp1;
      if (hit) return { hit: true, level: 'TP1' };
    }

    // TP2 check: after TP1 hit, or after Brain3 partial exit
    if (['TP1', 'PARTIAL'].includes(status)) {
      const hit = direction === 'BUY' ? price >= tp2 : price <= tp2;
      if (hit) return { hit: true, level: 'TP2' };
    }

    return { hit: false };
  }

  // ── SL CHECK (CANDLE CLOSE RULE) ─────────────────────────────────────────
  _slHit(signal, mkt) {
    const c = mkt.h4Candle;
    if (!c) return false;
    // Only trigger on CLOSE, never on wick — this is the candle close rule
    return signal.direction === 'BUY' ? c.close < signal.stop_loss : c.close > signal.stop_loss;
  }

  // ── FLASH CRASH ───────────────────────────────────────────────────────────
  _flashCrash(mkt, atr) {
    if (!atr || !mkt.h4Candle) return false;
    return (mkt.h4Candle.high - mkt.h4Candle.low) > atr * ATR.FLASH_CRASH_TRIGGER;
  }

  // ── FORMAT MESSAGE ── FIX BUG-05: parseFloat pnlR so > 0 comparison works
  _fmt(signal, status, reason, price) {
    const risk  = Math.abs(signal.entry_price - signal.stop_loss);
    const dir   = signal.direction === 'BUY' ? 1 : -1;
    const pnlR  = risk > 0 ? parseFloat(((price - signal.entry_price) * dir / risk).toFixed(2)) : 0;
    return `${status} — ${signal.symbol}
━━━━━━━━━━━━━━━━━━━━━━━
${reason}
Current : ${price}
Entry   : ${signal.entry_price}
P&L     : ${pnlR >= 0 ? '+' : ''}${pnlR.toFixed(2)}R
SL      : ${signal.stop_loss}
TP1     : ${signal.tp1}`;
  }

  // ── FETCH MONITORING DATA ── NEW-04 FIX: actually check news approaching
  async _marketData(signal) {
    try {
      const [h4, h1, daily, weekly, tick] = await Promise.all([
        this.data.getCandles(signal.symbol, '4h', 20),
        this.data.getCandles(signal.symbol, '1h', 20),
        this.data.getCandles(signal.symbol, '1D', 20),
        this.data.getCandles(signal.symbol, '1W', 10),
        this.data.getCurrentPrice(signal.symbol),
      ]);

      const dailyBias   = this._simpleBias(daily);
      const weeklyBias  = this._simpleBias(weekly);
      const htfTrendValid = dailyBias === signal.direction || weeklyBias === signal.direction;

      const lastH4 = h4.candles?.[h4.candles.length - 1];
      const lastH1 = h1?.candles?.[h1.candles.length - 1];
      const vols   = h4.volumes || [];
      const avgVol = vols.slice(-20).reduce((a,b)=>a+b,0) / 20 || 1;
      const volRatio = (vols[vols.length-1] || 0) / avgVol;

      // NEW-04 FIX: Check if high-impact news is approaching
      let newsApproaching = false;
      let newsMins = null;
      if (this.news) {
        try {
          const newsCheck = await this.news.checkBlackout(signal.symbol);
          if (newsCheck.blocked && newsCheck.minutesUntil !== undefined) {
            newsApproaching = true;
            newsMins = newsCheck.minutesUntil;
          }
        } catch (e) { /* non-critical — don't crash monitoring */ }
      }

      return {
        currentPrice:      tick.price,
        h4Candle:          lastH4,
        h1Candle:          lastH1,
        h4SwingLow:        h4.swingLows?.[h4.swingLows.length - 1] || null,
        h4SwingHigh:       h4.swingHighs?.[h4.swingHighs.length - 1] || null,
        h1SwingLow:        h1?.swingLows?.[h1.swingLows.length - 1] || null,
        h1SwingHigh:       h1?.swingHighs?.[h1.swingHighs.length - 1] || null,
        htfTrendValid,
        dailyTrendIntact:  dailyBias === signal.direction,
        weeklyTrendIntact: weeklyBias === signal.direction,
        volumeRatio:       volRatio,
        atr:               h4.atr || signal.atr_value,
        newsApproaching,   // Now actually populated
        newsMins,
      };
    } catch (err) {
      console.error(`[Brain2] Market data error for ${signal.symbol}:`, err.message);
      return null;
    }
  }

  _simpleBias(tf) {
    if (!tf?.closes?.length) return 'NEUTRAL';
    const c = tf.closes;
    const mid = c[Math.floor(c.length / 2)];
    return c[c.length - 1] > mid ? 'BUY' : 'SELL';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BRAIN 3 — EXIT ARBITER
// ═══════════════════════════════════════════════════════════════════════════

class Brain3 {
  constructor({ aiAnalyst, notifier, db }) {
    this.ai       = aiAnalyst;
    this.notifier = notifier;
    this.db       = db;
  }

  async arbitrate(signal, mkt, brain2Assessment) {
    console.log(`[Brain3] Arbitrating ${signal.symbol}...`);
    const decision = await this.ai.arbitrateExit(signal, mkt, brain2Assessment);
    await this._execute(signal, decision, mkt.currentPrice);
  }

  async _execute(signal, d, price) {
    const pnlR = this._pnlR(signal, price);

    switch (d.exit_action) {
      case 'FULL_EXIT': {
        // NEW-01 FIX: pass number to closeSignal, not string from toFixed()
        const pnlRNum = parseFloat(pnlR.toFixed(2));
        await this.db.closeSignal(signal.id, price, 'BRAIN3_FULL_EXIT', pnlRNum);
        await this.notifier.send(`🔴 BRAIN 3 FULL EXIT — ${signal.symbol}
━━━━━━━━━━━━━━━━━━━━━━━
Exit Price : ${price}
Result     : ${pnlRNum >= 0 ? '+' : ''}${pnlRNum.toFixed(2)}R
━━━━━━━━━━━━━━━━━━━━━━━
🤖 ${d.reasoning}
Trade archived. Lesson stored.`, 'EXIT');
        break;
      }

      case 'PARTIAL_EXIT': {
        // NEW-01 FIX: ensure pnlR stays number
        const pnlRNum = parseFloat(pnlR.toFixed(2));
        await this.db.updateSignalStatus(signal.id, 'PARTIAL');
        await this.db.updateSignalSL(signal.id, signal.entry_price);
        await this.notifier.send(`🟡 BRAIN 3 PARTIAL EXIT — ${signal.symbol}
━━━━━━━━━━━━━━━━━━━━━━━
${d.exit_percent}% closed @ ${price}
Locked: ${pnlRNum >= 0 ? '+' : ''}${pnlRNum.toFixed(2)}R
SL → BREAKEVEN
Remaining: ${100 - d.exit_percent}% open
━━━━━━━━━━━━━━━━━━━━━━━
🤖 ${d.reasoning}`, 'UPDATE');
        break;
      }

      case 'HOLD_TIGHTEN':
        if (d.new_sl) await this.db.updateSignalSL(signal.id, d.new_sl);
        await this.notifier.send(`⚡ BRAIN 3 — HOLD & TIGHTEN — ${signal.symbol}
SL tightened to: ${d.new_sl || signal.stop_loss}
🤖 ${d.reasoning}`, 'UPDATE');
        break;

      case 'HOLD':
        await this.notifier.send(`💬 BRAIN 3 — HOLD CONFIRMED — ${signal.symbol}
Thesis still valid. 🤖 ${d.reasoning}`, 'UPDATE');
        break;
    }
  }

  _pnlR(signal, price) {
    const risk = Math.abs(signal.entry_price - signal.stop_loss);
    if (!risk) return 0;
    const dir = signal.direction === 'BUY' ? 1 : -1;
    return (price - signal.entry_price) * dir / risk;
  }
}

module.exports = { Brain2, Brain3 };
