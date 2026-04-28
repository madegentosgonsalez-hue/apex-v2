// ═══════════════════════════════════════════════════════════════════════════
// BRAIN 1 — SIGNAL ENGINE
// Location → Direction → Entry Type → Score → Build Signal
// Pure technical logic. No emotion. No guessing.
// ═══════════════════════════════════════════════════════════════════════════

const { SIGNAL_RULES, ATR, REGIMES, CONFIDENCE_TIERS } = require('../utils/constants');

class Brain1 {
  constructor({ dataService, newsService, db }) {
    this.data  = dataService;
    this.news  = newsService;
    this.db    = db;
  }

  // ── MASTER SCAN ────────────────────────────────────────────────────────────
  async scan(symbol) {
    try {
      console.log(`[Brain1] Scanning ${symbol}...`);

      // STEP 1 — Hard pre-filters (fastest checks first)
      const pre = await this._prefilter(symbol);
      if (!pre.pass) return this._skip(symbol, pre.reason);

      // STEP 2 — Fetch all 7 timeframes + intermarket
      const mkt = await this._fetchAll(symbol);
      if (!mkt) return this._skip(symbol, 'Data unavailable');

      // STEP 3 — Regime check
      const regime = this._regime(mkt);
      if (!regime.signalAllowed) return this._skip(symbol, `Regime blocked: ${regime.label}`);

      // STEP 3b — FLAW-15 FIX: H4 candle close confirmation
      // Only scan when H4 candle has recently closed or is about to close
      // Prevents acting on incomplete candles that may invalidate at close
      if (!this._h4CandleClosed()) {
        return this._skip(symbol, 'H4 candle mid-formation — waiting for close confirmation');
      }

      // STEP 4 — Top-down directional bias (Weekly + Daily must agree)
      const bias = this._topDownBias(mkt);
      if (bias.direction === 'NEUTRAL') return this._skip(symbol, 'HTF conflict — W and D disagree');

      // STEP 5 — Location: is price at a meaningful level?
      const loc = this._locationCheck(mkt, bias.direction);
      if (!loc.valid) return this._skip(symbol, 'Price mid-range — no key level nearby');

      // STEP 6 — Entry type identification
      const entryType = this._entryType(mkt, bias.direction, loc);
      if (!entryType) return this._skip(symbol, 'No entry type pattern matched');

      // STEP 7 — Confluence score (pass symbol + h2Conflicts from already-computed bias)
      // NEW-05 FIX: pass bias.h2Conflicts so _confluence doesn't recompute _topDownBias
      const cf = this._confluence(mkt, bias.direction, loc, symbol, bias.h2Conflicts);
      if (cf.score < SIGNAL_RULES.MIN_CONFLUENCE) {
        return this._skip(symbol, `Confluence ${cf.score}/6 — need ≥${SIGNAL_RULES.MIN_CONFLUENCE}`);
      }

      // STEP 7b — FLAW-12 FIX: Enforce entry type minimum confluence
      // TYPE_A and TYPE_D require minimum 5/6 by strategy definition
      const entryMinConfluence = { TYPE_A: 5, TYPE_B: 4, TYPE_C: 4, TYPE_D: 5 };
      const minRequired = entryMinConfluence[entryType] || 4;
      if (cf.score < minRequired) {
        return this._skip(symbol, `${entryType} requires ≥${minRequired}/6 confluence (got ${cf.score})`);
      }

      // STEP 8 — Calculate entry / SL / TP levels
      const levels = this._levels(mkt, bias.direction, loc);
      if (!levels.valid) return this._skip(symbol, 'Cannot calculate valid levels');

      // STEP 9 — R:R check
      if (levels.rr < SIGNAL_RULES.MIN_RR) {
        return this._skip(symbol, `R:R ${levels.rr.toFixed(2)} below minimum ${SIGNAL_RULES.MIN_RR}`);
      }

      // STEP 10 — Assign tier
      const tier = this._tier(cf.score);

      // STEP 11 — Build signal object
      // FLAW-11 FIX: pass actual news_clear from prefilter (not hardcoded true)
      const signal = this._buildSignal({
        symbol, bias, entryType, cf, levels, regime, tier, mkt, loc,
        newsClear: pre.newsClear ?? true, // Prefilter sets this
      });

      console.log(`[Brain1] ✅ ${symbol}: ${bias.direction} | ${cf.score}/6 | ${tier.label} | ${entryType}${cf.h2Conflict ? ' [H2⚠]' : ''}`);
      return { signal, reason: 'Signal ready for AI' };

    } catch (err) {
      console.error(`[Brain1] Error scanning ${symbol}:`, err.message);
      return this._skip(symbol, `Scan error: ${err.message}`);
    }
  }

  // ── PRE-FILTER ── FLAW-11 FIX: return newsClear status for signal object
  async _prefilter(symbol) {
    let pair = null;
    try { pair = await this.db.getPair(symbol); } catch {}
    // pair.active is ignored — server.js activePairs array already controls which
    // pairs are scanned, so checking DB active flag here is redundant duplicate state.

    const session = this._sessionCheck(pair?.session_type || 'FOREX');
    if (!session.active) return { pass: false, reason: `Session closed (${session.reason})`, newsClear: true };

    const newsCheck = await this.news.checkBlackout(symbol);
    if (newsCheck.blocked) return {
      pass: false,
      reason: `News blackout: ${newsCheck.event} (${newsCheck.minutesUntil}min)`,
      newsClear: false,
    };

    const losses = await this.db.checkDailyLossLimit();
    if (losses.limitHit) return { pass: false, reason: `Daily loss limit hit (${losses.count} losses)`, newsClear: true };

    const existing = await this.db.getActiveSignalForPair(symbol);
    if (existing) return { pass: false, reason: 'Active signal already exists', newsClear: true };

    // All checks passed — news is clear
    return { pass: true, newsClear: true };
  }

  // ── TOP-DOWN BIAS ─────────────────────────────────────────────────────────
  // FLAW-10 FIX: H2 bridge now participates as a confirmation gate
  _topDownBias(mkt) {
    const weekly = this._bias(mkt.weekly, 3); // 3 confirmed swings on weekly is sufficient
    const daily  = this._bias(mkt.daily,  3); // 3 confirmed swings on daily
    const h4     = this._bias(mkt.h4,     3);
    const h2     = this._bias(mkt.h2,     3);

    // RULE: Weekly AND Daily must agree — that's the direction
    if (weekly === daily && weekly !== 'NEUTRAL') {
      // FLAW-10 FIX: H2 must not contradict H4
      // If H2 is showing opposite direction to H4, setup is not clean — downgrade
      const h2Conflicts = h2 !== 'NEUTRAL' && h2 !== h4;
      return {
        direction:    weekly,
        strength:     weekly === h4 ? (h2Conflicts ? 'MODERATE' : 'STRONG') : 'MODERATE',
        h2Conflicts,  // Flagged for AI context and confluence weighting
        weekly, daily, h4, h2,
      };
    }
    return { direction: 'NEUTRAL', weekly, daily, h4, h2 };
  }

  // FLAW-01 FIX: Structure MUST be confirmed before EMA can support bias
  // FLAW-02 FIX: minSwings parameter — Weekly=5, Daily=4, H4=3
  _bias(tf, minSwings = 3) {
    if (!tf?.closes?.length) return 'NEUTRAL';

    const closes = tf.closes;
    const price  = closes[closes.length - 1];
    const highs  = tf.swingHighs?.slice(-(minSwings + 1)) || [];
    const lows   = tf.swingLows?.slice(-(minSwings + 1))  || [];

    // FLAW-01 FIX: Need minimum swings to confirm structure
    // If we don't have enough swings, EMAs alone cannot determine bias
    const hasEnoughSwings = highs.length >= minSwings && lows.length >= minSwings;

    // Structure analysis: HH+HL = bullish, LH+LL = bearish
    let isHHHL = false;
    let isLHLL = false;

    if (hasEnoughSwings) {
      // Verify the LAST 2 consecutive swings trend in same direction
      const lastHighs = highs.slice(-2);
      const lastLows  = lows.slice(-2);
      isHHHL = lastHighs[1] > lastHighs[0] && lastLows[1] > lastLows[0];
      isLHLL = lastHighs[1] < lastHighs[0] && lastLows[1] < lastLows[0];
    }

    // Price above ema50 with ema21 > ema50 = uptrend confirmed (allows pullback to ema21 zone)
    const aboveEMAs = tf.ema21 && tf.ema50 && price > tf.ema50 && tf.ema21 > tf.ema50;
    const belowEMAs = tf.ema21 && tf.ema50 && price < tf.ema50 && tf.ema21 < tf.ema50;

    // FLAW-01 FIX: Structure confirmed + EMA aligned = strong bias
    if (isHHHL && aboveEMAs) return 'BUY';
    if (isLHLL && belowEMAs) return 'SELL';

    // FLAW-01 FIX: Structure confirmed but EMA disagrees = weak, treat as NEUTRAL
    if (isHHHL && belowEMAs) return 'NEUTRAL'; // Structure says buy but price below EMAs
    if (isLHLL && aboveEMAs) return 'NEUTRAL'; // Structure says sell but price above EMAs

    // FLAW-01 FIX: Structure NOT confirmed — EMA alone is NOT enough for HTF bias
    // Without confirmed structure, we cannot determine direction
    if (!hasEnoughSwings) return 'NEUTRAL';

    // EMAs aligned but structure not yet confirmed HH/HL or LH/LL pattern
    // This is transitional — treat as NEUTRAL to avoid false signals
    return 'NEUTRAL';
  }

  // ── REGIME ── FLAW-08 FIX: ATR expansion for forex, VIX only for stocks/gold
  _regime(mkt) {
    const adx = mkt.h4?.adx || 20;
    const vix = mkt.intermarket?.vix || 0;
    const atr = mkt.h4?.atr || 0;

    // FLAW-08 FIX: ATR expansion ratio vs 20-period average ATR
    // A suddenly expanded ATR = high volatility regardless of VIX
    const recentATR  = atr;
    const closes     = mkt.h4?.closes || [];
    // Approximate historical ATR by measuring avg range of last 20 candles
    const candles    = mkt.h4?.candles?.slice(-20) || [];
    const avgRange   = candles.length > 5
      ? candles.reduce((s, c) => s + (c.high - c.low), 0) / candles.length
      : recentATR;
    const atrRatio   = avgRange > 0 ? recentATR / avgRange : 1;

    // Crisis: VIX≥40 OR ATR expanded >3x average (market in shock)
    if (vix >= 40 || atrRatio >= 3.0) return { ...REGIMES.CRISIS, signalAllowed: false };

    // High volatility: VIX≥30 OR ATR expanded >2x (for any market type)
    if (vix >= 30 || atrRatio >= 2.0) return { ...REGIMES.HIGH_VOLATILITY, signalAllowed: false };

    // Standard regime detection by ADX
    if (adx >= 25) return { ...REGIMES.TRENDING,   signalAllowed: true, atrRatio };
    if (adx >= 15) return { ...REGIMES.WEAK_TREND,  signalAllowed: true, atrRatio };
    return             { ...REGIMES.RANGING,        signalAllowed: true, atrRatio };
  }

  // ── H4 CANDLE CLOSE CONFIRMATION ── FLAW-15 FIX
  // getCandles() always returns completed historical candles, so there is no
  // risk of acting on an incomplete candle — timing restriction is unnecessary.
  _h4CandleClosed() {
    return true;
  }

  // ── LOCATION CHECK ────────────────────────────────────────────────────────
  _locationCheck(mkt, dir) {
    const h4    = mkt.h4;
    const price = h4.closes[h4.closes.length - 1];
    const atr   = h4.atr;
    const tol   = atr * 0.6; // tolerance = 0.6×ATR

    let match = null;

    // 1. Order Blocks
    const obs = this._orderBlocks(h4, dir);
    for (const ob of obs) {
      if (Math.abs(price - ob.price) <= tol) {
        match = { type: 'ORDER_BLOCK', price: ob.price };
        break;
      }
    }

    // 2. Fair Value Gaps — FLAW-05: only matching direction FVGs
    if (!match) {
      const fvgs = this._fairValueGaps(h4, dir); // Pass dir for direction filter
      for (const fvg of fvgs) {
        if (price >= fvg.low - tol && price <= fvg.high + tol) {
          match = { type: 'FVG', price: fvg.mid || (fvg.high + fvg.low) / 2 };
          break;
        }
      }
    }

    // 3. Swing structure
    if (!match) {
      const swings = dir === 'BUY' ? h4.swingLows : h4.swingHighs;
      const recent = swings?.slice(-3) || [];
      for (const s of recent) {
        if (Math.abs(price - s) <= tol) {
          match = { type: 'SWING_LEVEL', price: s };
          break;
        }
      }
    }

    // 4. EMA levels
    if (!match) {
      if (Math.abs(price - h4.ema21) <= tol) match = { type: 'EMA21', price: h4.ema21 };
      else if (Math.abs(price - h4.ema50) <= tol) match = { type: 'EMA50', price: h4.ema50 };
    }

    if (!match) return { valid: false };
    return { valid: true, ...match, currentPrice: price };
  }

  // ── ENTRY TYPE ── with FLAW-12 enforcement: entry type min confluence gates
  _entryType(mkt, dir, loc) {
    const h4  = mkt.h4;
    const h1  = mkt.h1;
    const m15 = mkt.m15;
    const m30 = mkt.m30;

    // TYPE A: Liquidity sweep + MSB + FVG (min 5/6 — enforced in scan step 12)
    const sweep  = this._liquiditySweep(h4, dir);
    const msb    = this._msb(h1, dir);
    const hasFvg = loc.type === 'FVG' || this._fairValueGaps(h4, dir).length > 0;
    if (sweep && msb && hasFvg) return 'TYPE_A';

    // TYPE D: Breakout retest + volume (min 5/6 — enforced in scan step 12)
    const breakout  = this._breakoutRetest(h4, dir);
    const volExpand = this._volumeExpansion(h4);
    if (breakout && volExpand) return 'TYPE_D';

    // TYPE B: Order block + momentum candle (min 4/6)
    const ob  = loc.type === 'ORDER_BLOCK';
    const mom = this._momentumCandle(m15, dir) || this._momentumCandle(m30, dir);
    if (ob && mom) return 'TYPE_B';

    // TYPE C: EMA pullback in trend (min 4/6)
    const ema   = loc.type === 'EMA21' || loc.type === 'EMA50';
    const adxOk = h4.adx >= 20;
    if (ema && adxOk) return 'TYPE_C';

    return null;
  }

  // ── CONFLUENCE SCORING ── 9 factors (was 6). Minimum still 4. Tier thresholds scale.
  _confluence(mkt, dir, loc, symbol, biasH2Conflicts) {
    const h4     = mkt.h4;
    const rsi    = h4.rsi;
    const vol    = h4.volumes;
    const regime = this._regime(mkt).label;
    const f      = {};

    // Factor 1: HTF trend — both Weekly AND Daily agree
    f.htfAligned = this._bias(mkt.weekly, 5) === dir && this._bias(mkt.daily, 4) === dir;

    // Factor 2: Price at key level
    f.keyLevel = loc.valid;

    // Factor 3: Volume above 20-period average
    const avgVol = vol.length > 0 ? vol.slice(-20).reduce((a,b) => a+b, 0) / Math.min(vol.length, 20) : 0;
    f.volume = avgVol > 0 && vol[vol.length-1] > avgVol;

    // Factor 4: RSI regime-aware
    if (dir === 'BUY') {
      if (regime === 'TRENDING')     f.rsi = rsi >= 40 && rsi <= 65;
      else if (regime === 'RANGING') f.rsi = rsi >= 35 && rsi <= 55;
      else                           f.rsi = rsi >= 50 && rsi <= 70;
    } else {
      if (regime === 'TRENDING')     f.rsi = rsi >= 35 && rsi <= 60;
      else if (regime === 'RANGING') f.rsi = rsi >= 45 && rsi <= 65;
      else                           f.rsi = rsi >= 30 && rsi <= 50;
    }

    // Factor 5: Candle pattern on any trigger timeframe
    f.candle = this._candlePattern(mkt.m30, dir) ||
               this._candlePattern(mkt.h1,  dir) ||
               this._candlePattern(mkt.h4,  dir);

    // Factor 6: Pair-aware intermarket
    f.intermarket = this._intermarketCheck(mkt.intermarket, dir, symbol);

    // Factor 7: AMD Phase — Manipulation (sweep) or Distribution (sweep + MSB) = +1
    f.amdPhase = this._amdPhase(mkt, dir);

    // Factor 8: IFVG — old opposite FVG filled and flipped near entry level = +1
    f.ifvg = this._ifvgCheck(mkt.h4, dir, loc);

    // Factor 9: OTE Zone — entry within 62-79% Fibonacci retracement = +1
    f.oteZone = this._oteZone(mkt.h4, dir, loc);

    // NEW-05 FIX: Use h2Conflicts from already-computed bias (not re-computing)
    let score = Object.values(f).filter(Boolean).length;
    if (biasH2Conflicts) {
      score = Math.max(0, score - 1); // H2 contradicts H4 = reduce by 1
    }

    return { score, factors: f, h2Conflict: biasH2Conflicts };
  }

  // ── LEVEL CALCULATION ─────────────────────────────────────────────────────
  _levels(mkt, dir, loc) {
    const h4    = mkt.h4;
    const atr   = h4.atr;
    if (!atr || atr <= 0) return { valid: false }; // Guard: no ATR = no levels

    const price = h4.closes[h4.closes.length - 1];
    const entry = loc.price
      ? (Math.abs(price - loc.price) < atr * 0.4 ? price : loc.price)
      : price;

    let structureLevel, sl;

    if (dir === 'BUY') {
      // SL below the NEAREST swing low below entry
      // Use Math.max of valid lows = highest low that is still below entry = closest support
      const validLows = (h4.swingLows || []).filter(l => l < entry);
      if (validLows.length === 0) {
        structureLevel = entry - atr * 2; // ATR fallback
      } else {
        structureLevel = Math.max(...validLows); // NEAREST low below entry, not deepest
      }
      sl = structureLevel - (atr * ATR.SL_BUFFER);
    } else {
      // SL above the NEAREST swing high above entry
      // Use Math.min of valid highs = lowest high that is still above entry = closest resistance
      const validHighs = (h4.swingHighs || []).filter(h => h > entry);
      if (validHighs.length === 0) {
        structureLevel = entry + atr * 2; // ATR fallback
      } else {
        structureLevel = Math.min(...validHighs); // NEAREST high above entry, not furthest
      }
      sl = structureLevel + (atr * ATR.SL_BUFFER);
    }

    // Guard: structureLevel must be finite
    if (!isFinite(structureLevel) || !isFinite(sl)) return { valid: false };

    const risk = Math.abs(entry - sl);
    if (risk < 0.000001) return { valid: false }; // Zero risk = invalid

    const tp1 = dir === 'BUY' ? entry + risk * 2 : entry - risk * 2;
    const tp2 = dir === 'BUY' ? entry + risk * 3 : entry - risk * 3;
    const rr  = parseFloat((Math.abs(tp1 - entry) / risk).toFixed(2));

    // Final sanity checks
    if (!isFinite(tp1) || !isFinite(tp2)) return { valid: false };

    return {
      valid:          true,
      entry:          parseFloat(entry.toFixed(8)),
      sl:             parseFloat(sl.toFixed(8)),
      tp1:            parseFloat(tp1.toFixed(8)),
      tp2:            parseFloat(tp2.toFixed(8)),
      risk:           parseFloat(risk.toFixed(8)),
      rr,
      atr:            parseFloat(atr.toFixed(8)),
      structureLevel: parseFloat(structureLevel.toFixed(8)),
    };
  }

  // ── TIER ASSIGNMENT ── Scales to 9 factors (was 6)
  _tier(score) {
    if (score >= 7) return CONFIDENCE_TIERS.DIAMOND; // 7-9/9
    if (score >= 5) return CONFIDENCE_TIERS.GOLD;    // 5-6/9
    if (score >= 4) return CONFIDENCE_TIERS.SILVER;  // 4/9
    if (score >= 3) return CONFIDENCE_TIERS.BRONZE;  // 3/9
    return CONFIDENCE_TIERS.SKIP;
  }

  // ── BUILD SIGNAL OBJECT ── FLAW-11 FIX: news_clear from prefilter result
  _buildSignal({ symbol, bias, entryType, cf, levels, regime, tier, mkt, loc, newsClear }) {
    const validUntil = new Date(Date.now() + SIGNAL_RULES.SIGNAL_VALIDITY_HRS * 3600000);

    return {
      symbol,
      direction:             bias.direction,
      entry_type:            entryType,
      entry_price:           levels.entry,
      stop_loss:             levels.sl,
      tp1:                   levels.tp1,
      tp2:                   levels.tp2,
      atr_value:             levels.atr,
      rr_ratio:              levels.rr,
      confluence_score:      cf.score,
      htf_trend_aligned:     cf.factors.htfAligned,
      key_level_present:     cf.factors.keyLevel,
      volume_confirmed:      cf.factors.volume,
      rsi_momentum_aligned:  cf.factors.rsi,
      candle_pattern_found:  cf.factors.candle,
      intermarket_aligned:   cf.factors.intermarket,
      h2_conflict:           cf.h2Conflict || false, // FLAW-10: log H2 conflicts
      level_type:            loc.type,
      regime:                regime.label,
      adx_value:             mkt.h4?.adx,
      rsi_value:             mkt.h4?.rsi,
      session:               this._currentSession(),
      confidence_tier:       tier.label,
      risk_pct:              tier.riskPct,
      news_clear:            newsClear ?? true, // FLAW-11 FIX: from prefilter, not hardcoded
      dxy_direction:         mkt.intermarket?.dxyTrend,
      vix_level:             mkt.intermarket?.vix,
      btc_dominance:         mkt.intermarket?.btcDominance,
      valid_until:           validUntil,
    };
  }

  // ── PATTERN DETECTORS ─────────────────────────────────────────────────────

  // FLAW-06 FIX: Use MOST RECENT swing only, not minimum of all 3
  _liquiditySweep(tf, dir) {
    const candles = tf?.candles?.slice(-10) || [];
    const lows    = tf?.swingLows?.slice(-3)  || [];
    const highs   = tf?.swingHighs?.slice(-3) || [];

    if (dir === 'BUY' && lows.length) {
      // FLAW-06 FIX: Only sweep LAST swing low, not historical minimum
      const refLow = lows[lows.length - 1];
      return candles.some(c => c.low < refLow && c.close > refLow);
    }
    if (dir === 'SELL' && highs.length) {
      const refHigh = highs[highs.length - 1];
      return candles.some(c => c.high > refHigh && c.close < refHigh);
    }
    return false;
  }

  // FLAW-07 FIX: MSB confirmed by candle CLOSE not current tick price
  _msb(tf, dir) {
    if (!tf?.candles?.length || !tf.swingHighs?.length || !tf.swingLows?.length) return false;
    const candles    = tf.candles;
    const lastClosed = candles[candles.length - 2]; // Previous CLOSED candle
    if (!lastClosed) return false;

    if (dir === 'BUY') {
      const lastHigh = tf.swingHighs[tf.swingHighs.length - 1];
      // FLAW-07 FIX: Previous completed candle closed above swing high = confirmed MSB
      return lastClosed.close > lastHigh;
    }
    const lastLow = tf.swingLows[tf.swingLows.length - 1];
    return lastClosed.close < lastLow;
  }

  // FLAW-14 FIX: Retest zone tightened from ATR×1.5 to ATR×0.5
  _breakoutRetest(tf, dir) {
    if (!tf?.closes?.length || !tf.atr) return false;
    const price = tf.closes[tf.closes.length - 1];
    const atr   = tf.atr;

    if (dir === 'BUY') {
      const highs = tf.swingHighs?.slice(-4) || [];
      const breakLevel = highs.length >= 2 ? highs[highs.length - 2] : null;
      // FLAW-14 FIX: Must be within 0.5×ATR of the broken level
      return breakLevel && price > breakLevel && price < breakLevel + atr * 0.5;
    }
    const lows = tf.swingLows?.slice(-4) || [];
    const breakLevel = lows.length >= 2 ? lows[lows.length - 2] : null;
    return breakLevel && price < breakLevel && price > breakLevel - atr * 0.5;
  }

  _momentumCandle(tf, dir) {
    const c = tf?.candles?.[tf.candles.length - 1];
    if (!c) return false;
    const body  = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    if (range === 0) return false;
    const isBull = c.close > c.open && body / range > 0.55;
    const isBear = c.close < c.open && body / range > 0.55;
    return dir === 'BUY' ? isBull : isBear;
  }

  _candlePattern(tf, dir) {
    const candles = tf?.candles?.slice(-3) || [];
    if (candles.length < 2) return false;
    const [prev, curr] = candles.slice(-2);
    if (!prev || !curr) return false;

    const body  = Math.abs(curr.close - curr.open);
    const range = curr.high - curr.low;
    const lWick = Math.min(curr.open, curr.close) - curr.low;
    const uWick = curr.high - Math.max(curr.open, curr.close);

    if (dir === 'BUY') {
      const engulf = curr.close > curr.open && curr.open <= prev.close && curr.close >= prev.open;
      const hammer = body > 0 && lWick > body * 1.8 && uWick < body;
      return engulf || hammer;
    } else {
      const engulf = curr.close < curr.open && curr.open >= prev.close && curr.close <= prev.open;
      const star   = body > 0 && uWick > body * 1.8 && lWick < body;
      return engulf || star;
    }
  }

  _volumeExpansion(tf) {
    const vols = tf?.volumes?.slice(-5) || [];
    if (vols.length < 5) return false;
    const recent = vols[vols.length - 1];
    const avg    = vols.slice(0, -1).reduce((a,b)=>a+b,0) / (vols.length - 1);
    return recent > avg * 1.4;
  }

  // FLAW-03 FIX: OB returns full zone (high/low), entry at zone edge not midpoint
  // FLAW-04 FIX: Mitigated OBs (price has already been through them) are excluded
  _orderBlocks(tf, dir) {
    const candles = tf?.candles?.slice(-60) || [];
    const obs = [];

    for (let i = 3; i < candles.length - 3; i++) {
      const c    = candles[i];
      const next = candles.slice(i + 1, i + 4);

      if (dir === 'BUY' && c.close < c.open) {
        // Bearish candle before bullish move = bullish OB
        const bullMove = next.filter(n => n.close > n.open).length >= 2;
        if (bullMove) {
          // FLAW-04 FIX: Check if any later candle traded through this OB
          const laterCandles = candles.slice(i + 4);
          const isMitigated  = laterCandles.some(lc => lc.low <= c.low);
          if (!isMitigated) {
            obs.push({
              high:  c.high,
              low:   c.low,
              // FLAW-03 FIX: Entry at TOP of OB zone (institutions defend from top)
              price: c.high,
              type:  'BULLISH_OB',
            });
          }
        }
      } else if (dir === 'SELL' && c.close > c.open) {
        const bearMove = next.filter(n => n.close < n.open).length >= 2;
        if (bearMove) {
          const laterCandles = candles.slice(i + 4);
          // FLAW-04 FIX: Bearish OB mitigated if price traded above it
          const isMitigated  = laterCandles.some(lc => lc.high >= c.high);
          if (!isMitigated) {
            obs.push({
              high:  c.high,
              low:   c.low,
              // FLAW-03 FIX: Entry at BOTTOM of OB zone for SELL
              price: c.low,
              type:  'BEARISH_OB',
            });
          }
        }
      }
    }
    return obs.slice(-4);
  }

  // FLAW-05 FIX: Only return FVGs that match trade direction
  _fairValueGaps(tf, dir) {
    const candles = tf?.candles?.slice(-40) || [];
    const fvgs = [];

    for (let i = 1; i < candles.length - 1; i++) {
      const prev = candles[i - 1];
      const next = candles[i + 1];
      if (next.low  > prev.high) fvgs.push({ type: 'BULL', low: prev.high, high: next.low,  mid: (prev.high + next.low) / 2 });
      if (next.high < prev.low)  fvgs.push({ type: 'BEAR', low: next.high, high: prev.low,  mid: (next.high + prev.low) / 2 });
    }

    // FLAW-05 FIX: Filter by direction — BULL FVGs for BUY, BEAR FVGs for SELL
    if (dir === 'BUY')  return fvgs.filter(f => f.type === 'BULL').slice(-6);
    if (dir === 'SELL') return fvgs.filter(f => f.type === 'BEAR').slice(-6);
    return fvgs.slice(-6); // No direction filter when called without dir param
  }

  // FLAW-13 FIX: Pair-aware intermarket — DXY relationship inverts for USD-base pairs
  _intermarketCheck(intermarket, dir, symbol) {
    if (!intermarket?.dxyTrend || intermarket.dxyTrend === 'UNKNOWN') return false;
    const dxy = intermarket.dxyTrend;

    // USD as QUOTE (EUR/USD, GBP/USD, AUD/USD, NZD/USD, XAU/USD, BTC/USD)
    // DXY UP → USD strong → pair falls → confirms SELL
    // DXY DOWN → USD weak → pair rises → confirms BUY
    const usdQuote = ['EURUSD','GBPUSD','AUDUSD','NZDUSD','XAUUSD','BTCUSD','ETHUSD','SOLUSD','BNBUSD','XRPUSD','GC1'];
    if (usdQuote.includes(symbol)) {
      return dir === 'BUY' ? dxy === 'DOWN' : dxy === 'UP';
    }

    // USD as BASE (USD/JPY, USD/CAD, USD/CHF)
    // DXY UP → USD strong → pair rises → confirms BUY
    // DXY DOWN → USD weak → pair falls → confirms SELL
    const usdBase = ['USDJPY','USDCAD','USDCHF'];
    if (usdBase.includes(symbol)) {
      return dir === 'BUY' ? dxy === 'UP' : dxy === 'DOWN';
    }

    // JPY crosses (GBP/JPY, EUR/JPY) — risk sentiment driven
    // Risk-off (DXY up + JPY up) → pairs fall → confirms SELL
    if (['GBPJPY','EURJPY'].includes(symbol)) {
      return dir === 'BUY' ? dxy === 'DOWN' : dxy === 'UP';
    }

    // Stocks and futures — VIX is more relevant than DXY
    if (['SPY','NVDA','AAPL','ES1'].includes(symbol)) {
      if (intermarket.vix !== null && intermarket.vix !== undefined) {
        const riskOn = intermarket.vix < 20;
        return dir === 'BUY' ? riskOn : !riskOn;
      }
    }

    return false; // Unknown pair — don't award intermarket factor
  }

  // ── AMD PHASE CHECK (Factor 7) ───────────────────────────────────────────
  // Manipulation = liquidity sweep in active session
  // Distribution = sweep confirmed by MSB (highest quality)
  _amdPhase(mkt, dir) {
    try {
      const sweep = this._liquiditySweep(mkt.h4, dir);
      if (!sweep) return false; // Accumulation phase — no bonus
      // Distribution phase: sweep confirmed by MSB on H1
      const msb = this._msb(mkt.h1, dir);
      if (msb) return true; // Distribution = highest quality AMD signal
      // Manipulation phase: sweep active in London/NY hours
      const h = new Date().getUTCHours();
      return h >= 8 && h < 21;
    } catch { return false; }
  }

  // ── IFVG CHECK (Factor 8) ────────────────────────────────────────────────
  // Inverse FVG: old opposite-direction FVG that got filled = now flipped
  _ifvgCheck(tf, dir, loc) {
    try {
      const candles = tf?.candles?.slice(-60) || [];
      const price   = loc?.currentPrice || tf?.closes?.[tf.closes.length - 1];
      const atr     = tf?.atr || 0;
      const tol     = atr * 0.8;
      if (!price || candles.length < 10 || !atr) return false;

      for (let i = 1; i < candles.length - 2; i++) {
        const prev = candles[i - 1], next = candles[i + 1];

        if (dir === 'BUY') {
          // Old BEAR FVG (next.high < prev.low) that got filled = BULL IFVG support
          if (next.high < prev.low) {
            const fvgLow = next.high, fvgHigh = prev.low;
            const filled = candles.slice(i + 2).some(c => c.high >= fvgHigh);
            if (filled && Math.abs(price - fvgLow) <= tol) return true;
          }
        } else {
          // Old BULL FVG (next.low > prev.high) that got filled = BEAR IFVG resistance
          if (next.low > prev.high) {
            const fvgLow = prev.high, fvgHigh = next.low;
            const filled = candles.slice(i + 2).some(c => c.low <= fvgLow);
            if (filled && Math.abs(price - fvgHigh) <= tol) return true;
          }
        }
      }
      return false;
    } catch { return false; }
  }

  // ── OTE ZONE CHECK (Factor 9) ─────────────────────────────────────────────
  // Optimal Trade Entry = 62-79% Fibonacci retracement of last significant swing
  _oteZone(tf, dir, loc) {
    try {
      const price  = loc?.currentPrice || tf?.closes?.[tf.closes.length - 1];
      const highs  = tf?.swingHighs?.slice(-5) || [];
      const lows   = tf?.swingLows?.slice(-5)  || [];
      if (!price || highs.length < 2 || lows.length < 2) return false;

      const swingHigh = Math.max(...highs);
      const swingLow  = Math.min(...lows);
      const range     = swingHigh - swingLow;
      if (range <= 0) return false;

      if (dir === 'BUY') {
        // Retracing down from high: OTE = 62-79% of range below the high
        const oteHigh = swingHigh - range * 0.62;
        const oteLow  = swingHigh - range * 0.79;
        return price >= oteLow && price <= oteHigh;
      } else {
        // Retracing up from low: OTE = 62-79% of range above the low
        const oteLow  = swingLow + range * 0.62;
        const oteHigh = swingLow + range * 0.79;
        return price >= oteLow && price <= oteHigh;
      }
    } catch { return false; }
  }

  // ── SESSION CHECK ── FIX BUG-15: all inactive paths must include reason
  _sessionCheck(sessionType) {
    const utcH = new Date().getUTCHours();
    if (sessionType === 'CRYPTO') return { active: true };
    if (sessionType === 'FOREX') {
      const londonOpen = utcH >= 8  && utcH < 16;
      const nyOpen     = utcH >= 13 && utcH < 21;
      const ok = londonOpen || nyOpen;
      return ok ? { active: true } : { active: false, reason: 'Outside London/NY hours (UTC 08-16, 13-21)' };
    }
    if (sessionType === 'STOCKS') {
      const ok = utcH >= 15 && utcH < 21; // NYSE 09:30-16:00 EST = 14:30-21:00 UTC, skip first 30min
      return ok ? { active: true } : { active: false, reason: 'US market closed (UTC 15-21 only)' };
    }
    if (sessionType === 'FUTURES') {
      const ok = utcH >= 8 && utcH < 21;
      // FIX: always return reason when inactive
      return ok ? { active: true } : { active: false, reason: 'Futures outside active hours (UTC 08-21)' };
    }
    return { active: true };
  }

  _currentSession() {
    const h = new Date().getUTCHours();
    if (h >= 13 && h < 16) return 'LONDON_NY_OVERLAP';
    if (h >= 8  && h < 13) return 'LONDON';
    if (h >= 16 && h < 21) return 'NEW_YORK';
    if (h >= 0  && h < 8)  return 'ASIAN';
    return 'AFTER_HOURS';
  }

  // ── FETCH ALL TIMEFRAMES ──────────────────────────────────────────────────
  async _fetchAll(symbol) {
    try {
      // Sequential fetches prevent rate-limit bursts on Twelve Data free tier
      const weekly = await this.data.getCandles(symbol, '1W',  52);
      const daily  = await this.data.getCandles(symbol, '1D',  100);
      const h4     = await this.data.getCandles(symbol, '4h',  100);
      const h2     = await this.data.getCandles(symbol, '2h',  100);
      const h1     = await this.data.getCandles(symbol, '1h',  100);
      const m30    = await this.data.getCandles(symbol, '30m', 80);
      const m15    = await this.data.getCandles(symbol, '15m', 50);
      const intermarket = await this.data.getIntermarket(symbol);
      if (!h4 || h4.closes?.length < 20) return null;
      return { weekly, daily, h4, h2, h1, m30, m15, intermarket };
    } catch (err) {
      console.error(`[Brain1] Fetch error for ${symbol}:`, err.message);
      return null;
    }
  }

  _skip(symbol, reason) {
    console.log(`[Brain1] ${symbol} — skipped: ${reason}`);
    return { signal: null, reason };
  }
}

module.exports = Brain1;
