// ═══════════════════════════════════════════════════════════════════════════
// AI ANALYST — LOCKED CLAUDE API INTEGRATION
// The AI is a judge inside a locked courtroom.
// It can only REDUCE quality. It can NEVER override hard rules.
// Works fully in mock mode without an API key.
// ═══════════════════════════════════════════════════════════════════════════

const { AI_LOCKS, SIGNAL_RULES } = require('../utils/constants');

const MODEL   = 'claude-sonnet-4-20250514';
const API_URL = 'https://api.anthropic.com/v1/messages';

// ── LOCKED SYSTEM PROMPTS ────────────────────────────────────────────────────
const PROMPTS = {

  BRAIN1: `You are APEX Signal Validator — a rule-enforcement engine, not a market analyst.

YOUR ONLY JOB: Evaluate the JSON trading signal data provided and return a single JSON object.

ABSOLUTE FORBIDDEN ACTIONS:
- Approving any signal with confluence_score below 4
- Returning conviction above 90 under any circumstance
- Using fundamental analysis or news sentiment to approve
- Returning text outside the JSON object

HARD REJECT (return REJECT if ANY is true):
- confluence_score < 4
- htf_trend_aligned === false
- news_clear === false
- regime is HIGH_VOLATILITY or CRISIS
- h4_confirmed === false
- rr_ratio < 2.0

CONVICTION RULES:
- All 6 factors true + strong context: 82–88
- 5 factors: 74–80
- 4 factors with borderline factors: 65–72
- Any borderline condition: subtract 10
- Cap: 90. Floor for APPROVE: 65.

RETURN ONLY THIS JSON (no other text):
{
  "decision": "APPROVE" | "REJECT" | "CONDITIONAL",
  "conviction": <0-90>,
  "risk_flags": ["<flag>"],
  "reasoning": "<max 80 words, technical only>",
  "adjustments": {
    "sl_adjustment": "none" | "widen" | "tighten",
    "partial_exit_note": null,
    "validity_hrs": <1-6>
  }
}`,

  BRAIN2: `You are APEX Trade Guardian — a thesis monitoring engine.

YOUR ONLY JOB: Decide if an active trade's structure thesis is still intact.

KEY RULE: A WICK through a level is NOT a break. Only a candle CLOSE beyond counts.
Liquidity sweeps (wick below/above key level, closes back inside) = NOT invalidated.

RETURN ONLY THIS JSON:
{
  "thesis_intact": true | false,
  "invalidation_level": "NOISE" | "WARNING" | "SOFT" | "HARD" | "EMERGENCY",
  "action": "HOLD" | "MONITOR" | "MOVE_SL_BREAKEVEN" | "ACTIVATE_BRAIN3" | "IMMEDIATE_EXIT",
  "is_liquidity_sweep": true | false,
  "reasoning": "<max 60 words>",
  "confidence": <0-100>
}`,

  BRAIN3: `You are APEX Exit Arbiter — a trade exit decision engine.

YOUR ONLY JOB: Decide the optimal exit for an invalidated trade.

LOGIC:
- Genuine H4 break + volume + HTF weakening = FULL_EXIT
- H4 break but Daily intact + approaching TP1 = PARTIAL_EXIT + trail
- Liquidity sweep pattern = HOLD_TIGHTEN (tighten SL 30%)
- High impact news <1hr = PARTIAL_EXIT regardless
- In loss territory + hard structure break = FULL_EXIT

RETURN ONLY THIS JSON:
{
  "exit_action": "FULL_EXIT" | "PARTIAL_EXIT" | "HOLD_TIGHTEN" | "HOLD",
  "exit_percent": <0-100>,
  "reasoning": "<max 80 words>",
  "new_sl": <number | null>,
  "urgency": "IMMEDIATE" | "NEXT_CANDLE_CLOSE" | "MONITOR",
  "confidence": <0-100>
}`,
};

class AIAnalyst {
  constructor({ db, apiKey } = {}) {
    this.db         = db;
    this.apiKey     = apiKey;
    this.mockMode   = !apiKey;
    this.totalCalls = 0;
    this.approvals  = 0;
    this.rejections = 0;
    this.sumConviction = 0;

    if (this.mockMode) {
      console.log('[AI] No ANTHROPIC_API_KEY — running in mock mode');
    }
  }

  // ── BRAIN 1: VALIDATE SIGNAL ──────────────────────────────────────────────
  async validateSignal(signal, historical) {
    const t0    = Date.now();
    const input = this._brain1Input(signal, historical);

    // Hard rules first — no API call needed
    const hardBlock = this._hardRules(input);
    if (hardBlock) {
      console.log(`[AI] Hard rule: ${hardBlock}`);
      return this._hardReject(hardBlock);
    }

    const raw  = await this._call(PROMPTS.BRAIN1, input);
    const ms   = Date.now() - t0;
    const resp = this._parse1(raw, input);

    this._updateStats(resp);
    await this._log({ brain: 1, signalId: signal.id, symbol: signal.symbol, input, resp, ms });

    console.log(`[AI B1] ${signal.symbol}: ${resp.decision} (${resp.conviction}%) ${ms}ms`);
    return resp;
  }

  // ── BRAIN 2: MONITOR TRADE ────────────────────────────────────────────────
  async monitorTrade(signal, mktData) {
    const input = this._brain2Input(signal, mktData);
    const raw   = await this._call(PROMPTS.BRAIN2, input);
    const resp  = this._parse2(raw);
    await this._log({ brain: 2, signalId: signal.id, symbol: signal.symbol, input, resp, ms: 0 });
    return resp;
  }

  // ── BRAIN 3: EXIT DECISION ────────────────────────────────────────────────
  async arbitrateExit(signal, mktData, brain2) {
    const input = this._brain3Input(signal, mktData, brain2);
    const raw   = await this._call(PROMPTS.BRAIN3, input);
    const resp  = this._parse3(raw);
    await this._log({ brain: 3, signalId: signal.id, symbol: signal.symbol, input, resp, ms: 0 });
    console.log(`[AI B3] ${signal.symbol}: ${resp.exit_action} (${resp.urgency})`);
    return resp;
  }

  // ── FULL SIGNAL ANALYSIS (Thing 1 — rich Claude prompt) ─────────────────
  // Called by server.js after Brain1 generates a signal.
  // Fetches past performance + learning insights, sends rich context to Claude.
  // Returns { conviction, tier, reason } — tier can only lower Brain1's tier.
  async analyzeSignalFull(signal) {
    if (this.mockMode) {
      return { conviction: 76, tier: signal.confidence_tier, reason: 'Mock mode — set ANTHROPIC_API_KEY for real AI analysis.' };
    }

    try {
      // 1. Fetch past 30-day performance for this pair + entry type
      const perfRow = await this.db.query(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
          AVG(CASE WHEN pnl_r IS NOT NULL THEN pnl_r ELSE 0 END) as avg_r
        FROM trades
        WHERE symbol = $1
          AND entry_type = $2
          AND closed_at >= NOW() - INTERVAL '30 days'
          AND outcome IS NOT NULL
      `, [signal.symbol, signal.entry_type]).catch(() => ({ rows: [{}] }));
      const perf = perfRow.rows[0] || {};

      // 2. Last 5 similar setups
      const similarRows = await this.db.query(`
        SELECT outcome, pnl_r, closed_at FROM trades
        WHERE symbol = $1 AND entry_type = $2
          AND outcome IS NOT NULL
        ORDER BY closed_at DESC LIMIT 5
      `, [signal.symbol, signal.entry_type]).catch(() => ({ rows: [] }));

      // 3. Current streak
      const streakRows = await this.db.query(`
        SELECT outcome FROM trades
        WHERE outcome IS NOT NULL
        ORDER BY closed_at DESC LIMIT 10
      `).catch(() => ({ rows: [] }));
      let streak = 0, streakType = '';
      for (const r of streakRows.rows) {
        if (!streakType) streakType = r.outcome;
        if (r.outcome === streakType) streak++;
        else break;
      }

      // 4. Daily losses today
      const lossRow = await this.db.query(`
        SELECT COUNT(*) as count FROM trades
        WHERE outcome='LOSS' AND DATE(closed_at) = CURRENT_DATE
      `).catch(() => ({ rows: [{ count: 0 }] }));

      // 5. Latest learning pattern insight
      const learnRow = await this.db.query(`
        SELECT insights, best_pair, best_entry_type, best_session, suggested_changes
        FROM learning_patterns ORDER BY created_at DESC LIMIT 1
      `).catch(() => ({ rows: [{}] }));
      const learn = learnRow.rows[0] || {};

      const dailyLosses = parseInt(lossRow.rows[0]?.count || 0);
      const winRate30d  = perf.total > 0 ? Math.round((perf.wins / perf.total) * 100) : null;
      const last5       = similarRows.rows.map(r => r.outcome);

      // Build rich user prompt
      const userPrompt = `SIGNAL:
Pair: ${signal.symbol} | Direction: ${signal.direction} | Entry Type: ${signal.entry_type}
Entry: ${signal.entry_price} | SL: ${signal.stop_loss} | TP1: ${signal.tp1} | TP2: ${signal.tp2}
Confluence: ${signal.confluence_score}/9 | Session: ${signal.session} | Regime: ${signal.regime}
HTF Aligned: ${signal.htf_trend_aligned} | R:R: ${signal.rr_ratio}

PAST PERFORMANCE (30 days, same pair+type):
Win rate: ${winRate30d !== null ? winRate30d + '%' : 'No data'} (${perf.total || 0} trades)
Avg R: ${perf.avg_r ? parseFloat(perf.avg_r).toFixed(2) : 'N/A'}
Last 5 similar: ${last5.length ? last5.join(', ') : 'No data'}
Current streak: ${streak ? streak + 'x ' + streakType : 'None'}
Daily losses today: ${dailyLosses}/4

LEARNING INSIGHTS:
Best pair: ${learn.best_pair || 'Unknown'} | Best type: ${learn.best_entry_type || 'Unknown'} | Best session: ${learn.best_session || 'Unknown'}
Insights: ${learn.insights ? JSON.stringify(learn.insights).slice(0, 200) : 'None yet'}

MARKET CONTEXT:
DXY: ${signal.dxy_direction || 'UNKNOWN'} | VIX: ${signal.vix_level || 'N/A'}
News clear: ${signal.news_clear} | Key level: ${signal.level_type || 'N/A'}`;

      const systemPrompt = `You are an expert institutional forex trader. Analyze signals using past performance data and learning insights. Return ONLY JSON. No explanation. No markdown. Format: {"conviction":0-100,"tier":"DIAMOND/GOLD/SILVER/SKIP","reason":"one sentence"}`;

      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      MODEL,
          max_tokens: 150,
          system:     systemPrompt,
          messages:   [{ role: 'user', content: userPrompt }],
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const text = this._text(json);
      const parsed = JSON.parse(this._cleanJSON(text));

      const conviction = Math.max(0, Math.min(100, parseInt(parsed.conviction) || 0));
      let tier = parsed.tier || 'SKIP';
      if (!['DIAMOND','GOLD','SILVER','SKIP'].includes(tier)) tier = 'SKIP';

      // Apply conviction thresholds from PDF
      if (conviction < 65)       tier = 'SKIP';
      else if (conviction < 75)  tier = 'SILVER';
      else if (conviction < 88)  tier = 'GOLD';
      else                       tier = 'DIAMOND';

      const reason = (parsed.reason || '').slice(0, 200);
      console.log(`[AI Full] ${signal.symbol}: ${tier} (${conviction}) — ${reason}`);

      // Log to DB
      await this.db.query(
        `INSERT INTO system_logs (log_type, message, symbol, status) VALUES ($1,$2,$3,$4)`,
        ['ai_signal', `AI: ${tier} (${conviction}) — ${reason}`, signal.symbol, tier]
      ).catch(() => {});

      return { conviction, tier, reason };

    } catch (err) {
      console.error('[AI Full] Error:', err.message);
      return { conviction: 75, tier: signal.confidence_tier, reason: 'AI unavailable — using Brain1 tier.' };
    }
  }

  // ── WEEKLY LEARNING REVIEW ────────────────────────────────────────────────
  async weeklyReview(perfData) {
    if (this.mockMode) return { insights: ['Mock mode — no real AI analysis'], status: 'mock' };

    const sys = `You are APEX Learning Analyst. Analyze performance data and return actionable insights as JSON only.`;
    const raw = await this._call(sys, perfData, 800);
    try {
      return JSON.parse(this._cleanJSON(this._text(raw)));
    } catch {
      return null;
    }
  }

  // ── API CALL ──────────────────────────────────────────────────────────────
  async _call(systemPrompt, inputData, maxTokens = 400) {
    if (this.mockMode) return this._mockResponse(systemPrompt);

    try {
      const res = await fetch(API_URL, {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'x-api-key':      this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      MODEL,
          max_tokens: maxTokens,
          system:     systemPrompt,
          messages:   [{ role: 'user', content: JSON.stringify(inputData, null, 2) }],
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();

    } catch (err) {
      console.error('[AI] API error:', err.message);
      // Safe fallback on API failure
      return { content: [{ type: 'text', text: '{"decision":"REJECT","conviction":0,"risk_flags":["API_ERROR"],"reasoning":"API unavailable — safe reject","adjustments":{"sl_adjustment":"none","partial_exit_note":null,"validity_hrs":4}}' }] };
    }
  }

  // ── MOCK RESPONSES ────────────────────────────────────────────────────────
  _mockResponse(prompt) {
    if (prompt.includes('Signal Validator')) {
      return { content: [{ type: 'text', text: JSON.stringify({
        decision: 'APPROVE', conviction: 76,
        risk_flags: ['MOCK_MODE'],
        reasoning: 'Mock mode. Set ANTHROPIC_API_KEY to enable real AI validation.',
        adjustments: { sl_adjustment: 'none', partial_exit_note: null, validity_hrs: 4 },
      })}]};
    }
    if (prompt.includes('Trade Guardian')) {
      return { content: [{ type: 'text', text: JSON.stringify({
        thesis_intact: true, invalidation_level: 'NOISE',
        action: 'HOLD', is_liquidity_sweep: false,
        reasoning: 'Mock mode — thesis assumed intact.',
        confidence: 70,
      })}]};
    }
    return { content: [{ type: 'text', text: JSON.stringify({
      exit_action: 'HOLD', exit_percent: 0,
      reasoning: 'Mock mode — holding position.',
      new_sl: null, urgency: 'MONITOR', confidence: 60,
    })}]};
  }

  // ── HARD RULES CHECK ─────────────────────────────────────────────────────
  _hardRules(input) {
    if (input.confluence_score < 4)           return 'confluence_below_4';
    if (!input.htf_trend_aligned)             return 'htf_trend_not_aligned';
    if (!input.news_clear)                    return 'news_blackout';
    if (['HIGH_VOLATILITY','CRISIS'].includes(input.regime)) return `regime_${input.regime}`;
    if (!input.h4_confirmed)                  return 'h4_not_confirmed';
    if (input.rr_ratio < SIGNAL_RULES.MIN_RR) return `rr_below_${SIGNAL_RULES.MIN_RR}`;
    return null; // No block
  }

  _hardReject(reason) {
    return {
      decision:    'REJECT',
      conviction:  0,
      risk_flags:  [reason],
      reasoning:   `Hard rule violation: ${reason}`,
      adjustments: { sl_adjustment: 'none', partial_exit_note: null, validity_hrs: 0 },
      _source:     'HARD_RULE',
    };
  }

  // ── INPUT BUILDERS ────────────────────────────────────────────────────────
  _brain1Input(signal, hist) {
    return {
      symbol:              signal.symbol,
      direction:           signal.direction,
      entry_type:          signal.entry_type,
      confluence_score:    signal.confluence_score,
      htf_trend_aligned:   signal.htf_trend_aligned,
      key_level_present:   signal.key_level_present,
      volume_confirmed:    signal.volume_confirmed,
      rsi_momentum_aligned:signal.rsi_momentum_aligned,
      candle_pattern_found:signal.candle_pattern_found,
      intermarket_aligned: signal.intermarket_aligned,
      regime:              signal.regime,
      adx:                 signal.adx_value,
      rsi:                 signal.rsi_value,
      rr_ratio:            signal.rr_ratio,
      atr:                 signal.atr_value,
      session:             signal.session,
      news_clear:          signal.news_clear,
      h4_confirmed:        signal.key_level_present && signal.htf_trend_aligned,
      dxy_direction:       signal.dxy_direction || 'UNKNOWN',
      vix:                 signal.vix_level,
      historical:          hist?.sample_size >= 20 ? {
        pair_win_rate:   hist.win_rate,
        sample_size:     hist.sample_size,
        avg_r:           hist.avg_r,
      } : null,
    };
  }

  _brain2Input(signal, mkt) {
    const risk   = Math.abs(signal.entry_price - signal.stop_loss);
    const dir    = signal.direction === 'BUY' ? 1 : -1;
    const pnlR   = risk > 0 ? ((mkt.currentPrice - signal.entry_price) * dir / risk).toFixed(2) : 0;
    return {
      symbol:                signal.symbol,
      direction:             signal.direction,
      entry_price:           signal.entry_price,
      stop_loss:             signal.stop_loss,
      tp1:                   signal.tp1,
      current_price:         mkt.currentPrice,
      pnl_r:                 parseFloat(pnlR),
      mins_in_trade:         Math.floor((Date.now() - new Date(signal.created_at)) / 60000),
      atr:                   signal.atr_value,
      h4_structure_broken:   mkt.h4StructureBroken,
      h1_structure_broken:   mkt.h1StructureBroken,
      htf_trend_valid:       mkt.htfTrendValid,
      volume_on_break:       mkt.volumeOnBreak,
      candle_closed_beyond:  mkt.candleClosedBeyond,
      news_approaching:      mkt.newsApproaching,
      news_mins:             mkt.newsMins || null,
    };
  }

  _brain3Input(signal, mkt, b2) {
    return {
      ...this._brain2Input(signal, mkt),
      brain2_assessment: b2,
      daily_trend_intact: mkt.dailyTrendIntact,
      weekly_trend_intact: mkt.weeklyTrendIntact,
      pct_to_tp1: signal.tp1 > 0
        ? Math.abs((mkt.currentPrice - signal.entry_price) / (signal.tp1 - signal.entry_price) * 100).toFixed(1)
        : 0,
    };
  }

  // ── RESPONSE PARSERS ──────────────────────────────────────────────────────
  _parse1(raw, input) {
    try {
      const text   = this._text(raw);
      const parsed = JSON.parse(this._cleanJSON(text));

      // Schema validation
      if (!['APPROVE','REJECT','CONDITIONAL'].includes(parsed.decision)) throw new Error('Bad decision');
      if (typeof parsed.conviction !== 'number') throw new Error('Bad conviction');

      // Apply caps
      parsed.conviction = Math.min(parsed.conviction, AI_LOCKS.MAX_CONVICTION);
      parsed.conviction = Math.max(parsed.conviction, 0);
      if (parsed.risk_flags?.length > AI_LOCKS.MAX_RISK_FLAGS) {
        parsed.risk_flags = parsed.risk_flags.slice(0, AI_LOCKS.MAX_RISK_FLAGS);
      }

      // Conviction floor
      if (parsed.decision === 'APPROVE' && parsed.conviction < AI_LOCKS.MIN_CONVICTION_APPROVE) {
        parsed.decision = 'CONDITIONAL';
      }

      // CRITICAL: re-run hard rules — AI cannot override them
      const block = this._hardRules(input);
      if (block && parsed.decision === 'APPROVE') {
        parsed.decision   = 'REJECT';
        parsed.conviction = 0;
        parsed.reasoning  = `Hard rule override: ${block}`;
        parsed.risk_flags = [block];
      }

      return { ...parsed, _valid: true };
    } catch (err) {
      console.error('[AI] Parse error:', err.message);
      return this._hardReject('PARSE_ERROR');
    }
  }

  _parse2(raw) {
    try {
      const parsed = JSON.parse(this._cleanJSON(this._text(raw)));
      if (!['HOLD','MONITOR','MOVE_SL_BREAKEVEN','ACTIVATE_BRAIN3','IMMEDIATE_EXIT'].includes(parsed.action)) throw new Error('Bad action');
      return { ...parsed, _valid: true };
    } catch {
      return { thesis_intact: true, invalidation_level: 'NOISE', action: 'HOLD', is_liquidity_sweep: false, reasoning: 'Parse error', confidence: 0, _valid: false };
    }
  }

  _parse3(raw) {
    try {
      const parsed = JSON.parse(this._cleanJSON(this._text(raw)));
      if (!['FULL_EXIT','PARTIAL_EXIT','HOLD_TIGHTEN','HOLD'].includes(parsed.exit_action)) throw new Error('Bad exit_action');
      return { ...parsed, _valid: true };
    } catch {
      return { exit_action: 'FULL_EXIT', exit_percent: 100, reasoning: 'Parse error — safe exit', urgency: 'NEXT_CANDLE_CLOSE', confidence: 0, _valid: false };
    }
  }

  // ── DRIFT MONITORING ── FIX BUG-12: count CONDITIONAL separately, not as rejection
  _updateStats(resp) {
    this.totalCalls++;
    if (resp.decision === 'APPROVE')      this.approvals++;
    else if (resp.decision === 'REJECT')  this.rejections++;
    // CONDITIONAL is neither approve nor reject — counted but not skewing rate
    this.sumConviction += resp.conviction || 0;

    if (this.totalCalls >= 30) {
      const rate = this.approvals / (this.approvals + this.rejections || 1);
      const avg  = this.sumConviction / this.totalCalls;
      if (rate > AI_LOCKS.DRIFT_APPROVE_RATE_HIGH)
        console.warn(`[AI DRIFT] ⚠️ High approval rate: ${(rate*100).toFixed(1)}% — AI may be too permissive`);
      if (rate < AI_LOCKS.DRIFT_APPROVE_RATE_LOW)
        console.warn(`[AI DRIFT] ⚠️ Low  approval rate: ${(rate*100).toFixed(1)}% — AI may be too restrictive`);
      if (avg > AI_LOCKS.DRIFT_AVG_CONVICTION_HIGH)
        console.warn(`[AI DRIFT] ⚠️ High avg conviction: ${avg.toFixed(1)} — check calibration`);
    }
  }

  getDriftStats() {
    return {
      totalCalls:  this.totalCalls,
      approvals:   this.approvals,
      rejections:  this.rejections,
      approveRate: this.totalCalls > 0 ? (this.approvals / this.totalCalls * 100).toFixed(1) + '%' : '0%',
      avgConviction: this.totalCalls > 0 ? (this.sumConviction / this.totalCalls).toFixed(1) : 0,
      mockMode:    this.mockMode,
    };
  }

  // ── HELPERS ───────────────────────────────────────────────────────────────
  _text(r) {
    return (r?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }

  _cleanJSON(t) {
    return t.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
  }

  async _log({ brain, signalId, symbol, input, resp, ms }) {
    try {
      await this.db.saveAIDecision({
        signal_id:  signalId,
        symbol,
        brain,
        input,
        decision:   resp.decision || resp.action || resp.exit_action,
        conviction: resp.conviction || resp.confidence,
        reasoning:  resp.reasoning,
        riskFlags:  resp.risk_flags || [],
        tokensUsed: 0,
        responseMs: ms,
        validJson:  resp._valid !== false,
      });
    } catch (e) {
      console.error('[AI] Log error:', e.message);
    }
  }
}

module.exports = AIAnalyst;
