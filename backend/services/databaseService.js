// ═══════════════════════════════════════════════════════════════════════════
// DATABASE SERVICE
// Full mock mode when no DATABASE_URL — system works without any config
// ═══════════════════════════════════════════════════════════════════════════

const { PAIRS } = require('../utils/constants');

// ── IN-MEMORY STORE (mock mode) ───────────────────────────────────────────────
class MemoryStore {
  constructor() {
    this.signals = [];
    this.brain2Events = [];
    this.aiDecisions = [];
    this.notifications = [];
    this.dailyLosses = 0;
    this.dailyLossDate = null;

    // Seed pairs from constants
    this.pairs = Object.entries(PAIRS).map(([symbol, cfg]) => ({
      id: `pair-${symbol}`,
      symbol,
      market: cfg.market,
      tv_symbol: cfg.tvSymbol,
      pip_size: cfg.pipSize,
      session_type: cfg.session,
      active: cfg.active,
    }));

    this.config = {
      scan_interval_mins:     15,
      guardian_interval_mins: 5,
      max_concurrent_signals: 3,
      daily_loss_limit:       3,
      signal_validity_hrs:    4,
      paper_trade_mode:       true,
      telegram_enabled:       false,
      whatsapp_enabled:       false,
    };
  }
}

class DatabaseService {
  constructor({ connectionString } = {}) {
    this.connectionString = connectionString;
    this.pool = null;
    this.mock = !connectionString;
    this.store = new MemoryStore();
  }

  async connect() {
    if (this.mock) {
      console.log('[DB] No DATABASE_URL — running in memory mode (data resets on restart)');
      return;
    }
    try {
      const { Pool } = require('pg');
      this.pool = new Pool({
        connectionString: this.connectionString,
        ssl: { rejectUnauthorized: false },
        max: 10,
      });
      await this.pool.query('SELECT 1');
      console.log('[DB] PostgreSQL connected');
    } catch (err) {
      console.warn('[DB] PostgreSQL connection failed — falling back to memory mode:', err.message);
      this.mock = true;
    }
  }

  async query(sql, params = []) {
    if (this.mock) return { rows: [] };
    return this.pool.query(sql, params);
  }

  // ── PAIRS ─────────────────────────────────────────────────────────────────
  async getAllPairs() {
    if (this.mock) return this.store.pairs;
    const r = await this.query('SELECT * FROM pairs ORDER BY market, symbol');
    return r.rows;
  }

  async getActivePairs() {
    if (this.mock) return this.store.pairs.filter(p => p.active);
    const r = await this.query('SELECT * FROM pairs WHERE active = TRUE');
    return r.rows;
  }

  async getPair(symbol) {
    if (this.mock) return this.store.pairs.find(p => p.symbol === symbol);
    const r = await this.query('SELECT * FROM pairs WHERE symbol = $1', [symbol]);
    return r.rows[0];
  }

  async updatePairStatus(symbol, active) {
    if (this.mock) {
      const p = this.store.pairs.find(p => p.symbol === symbol);
      if (p) p.active = active;
      return;
    }
    await this.query('UPDATE pairs SET active = $1, updated_at = NOW() WHERE symbol = $2', [active, symbol]);
  }

  // ── SIGNALS ───────────────────────────────────────────────────────────────
  async saveSignal(signal) {
    const id = `sig-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const saved = { id, ...signal, created_at: new Date() };

    if (this.mock) {
      this.store.signals.unshift(saved);
      if (this.store.signals.length > 500) this.store.signals = this.store.signals.slice(0, 500);
      return saved;
    }

    const r = await this.query(`
      INSERT INTO signals (
        symbol, signal_type, entry_type, direction,
        entry_price, stop_loss, tp1, tp2, atr_value, rr_ratio,
        confluence_score, htf_trend_aligned, key_level_present,
        volume_confirmed, rsi_momentum_aligned, candle_pattern_found,
        intermarket_aligned, level_type, regime, adx_value, rsi_value,
        session, confidence_tier, risk_pct,
        ai_decision, ai_conviction, ai_reasoning, ai_risk_flags,
        news_clear, h2_conflict, dxy_direction, vix_level,
        status, valid_until
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
        $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34
      ) RETURNING *`,
      [
        signal.symbol, signal.signal_type, signal.entry_type, signal.direction,
        signal.entry_price, signal.stop_loss, signal.tp1, signal.tp2,
        signal.atr_value, signal.rr_ratio,
        signal.confluence_score, signal.htf_trend_aligned, signal.key_level_present,
        signal.volume_confirmed, signal.rsi_momentum_aligned, signal.candle_pattern_found,
        signal.intermarket_aligned, signal.level_type, signal.regime,
        signal.adx_value, signal.rsi_value, signal.session,
        signal.confidence_tier, signal.risk_pct,
        signal.ai_decision, signal.ai_conviction, signal.ai_reasoning,
        JSON.stringify(signal.ai_risk_flags || []),
        signal.news_clear !== false,
        signal.h2_conflict === true,  // Log H2 bridge conflict for learning
        signal.dxy_direction, signal.vix_level,
        signal.signal_type === 'NO_TRADE' ? 'CANCELLED' : 'ACTIVE',
        signal.valid_until,
      ]
    );
    return r.rows[0];
  }

  async getActiveSignals() {
    if (this.mock) {
      return this.store.signals.filter(s => ['ACTIVE','TP1','TP2','PARTIAL'].includes(s.status));
    }
    const r = await this.query(`
      SELECT * FROM signals WHERE status IN ('ACTIVE','TP1','TP2','PARTIAL') ORDER BY created_at DESC
    `);
    return r.rows;
  }

  async getActiveSignalForPair(symbol) {
    if (this.mock) {
      return this.store.signals.find(s =>
        s.symbol === symbol && ['ACTIVE','TP1','TP2'].includes(s.status)
      ) || null;
    }
    const r = await this.query(`
      SELECT * FROM signals WHERE symbol = $1 AND status IN ('ACTIVE','TP1','TP2') LIMIT 1
    `, [symbol]);
    return r.rows[0] || null;
  }

  async getSignalHistory({ symbol, limit = 50, offset = 0 } = {}) {
    if (this.mock) {
      let sigs = this.store.signals.filter(s => !['ACTIVE','TP1','TP2','PARTIAL'].includes(s.status));
      if (symbol) sigs = sigs.filter(s => s.symbol === symbol);
      return sigs.slice(offset, offset + limit);
    }
    // FIX BUG-04: params must match $1=limit, $2=offset, $3=symbol (if provided)
    // Previous bug: params=[limit, offset, symbol] but query used $3 for symbol
    // and $4 for offset — offset had no param, symbol was at wrong position
    if (symbol) {
      const r = await this.query(`
        SELECT * FROM signals
        WHERE status NOT IN ('ACTIVE','TP1','TP2','PARTIAL') AND symbol = $1
        ORDER BY created_at DESC LIMIT $2 OFFSET $3
      `, [symbol, limit, offset]);
      return r.rows;
    } else {
      const r = await this.query(`
        SELECT * FROM signals
        WHERE status NOT IN ('ACTIVE','TP1','TP2','PARTIAL')
        ORDER BY created_at DESC LIMIT $1 OFFSET $2
      `, [limit, offset]);
      return r.rows;
    }
  }

  async updateSignalSL(id, newSL) {
    if (this.mock) {
      const s = this.store.signals.find(s => s.id === id);
      if (s) s.stop_loss = newSL;
      return;
    }
    await this.query('UPDATE signals SET stop_loss = $1 WHERE id = $2', [newSL, id]);
  }

  async updateSignalStatus(id, status) {
    if (this.mock) {
      const s = this.store.signals.find(s => s.id === id);
      if (s) s.status = status;
      return;
    }
    await this.query('UPDATE signals SET status = $1 WHERE id = $2', [status, id]);
  }

  async closeSignal(id, exitPrice, exitReason, pnlR) {
    // NEW-02 FIX: null pnlR (emergency exits) = LOSS, not BREAKEVEN
    // null > 0 = false, null < 0 = false would incorrectly give BREAKEVEN
    let outcome;
    if (pnlR === null || pnlR === undefined) {
      outcome = 'LOSS'; // Unknown exit = assume loss for conservative accounting
    } else {
      const r = parseFloat(pnlR);
      outcome = r > 0 ? 'WIN' : r < 0 ? 'LOSS' : 'BREAKEVEN';
    }

    if (this.mock) {
      const s = this.store.signals.find(s => s.id === id);
      if (s) {
        s.status = 'CLOSED'; s.exit_price = exitPrice;
        s.exit_reason = exitReason; s.pnl_r = pnlR;
        s.outcome = outcome; s.closed_at = new Date();
        if (outcome === 'LOSS') this._trackDailyLoss();
      }
      return;
    }
    await this.query(`
      UPDATE signals SET status='CLOSED', exit_price=$1, exit_reason=$2,
        pnl_r=$3, outcome=$4, closed_at=NOW() WHERE id=$5
    `, [exitPrice, exitReason, pnlR, outcome, id]);
    if (outcome === 'LOSS') this._trackDailyLoss();
  }

  async expireOldSignals() {
    const now = new Date();
    if (this.mock) {
      this.store.signals.forEach(s => {
        if (s.status === 'ACTIVE' && s.valid_until && new Date(s.valid_until) < now) {
          s.status = 'EXPIRED'; s.outcome = 'EXPIRED';
        }
      });
      return;
    }
    await this.query(`
      UPDATE signals SET status='EXPIRED', outcome='EXPIRED'
      WHERE status='ACTIVE' AND valid_until < NOW()
    `);
  }

  // ── DAILY LOSS LIMIT ──────────────────────────────────────────────────────
  _trackDailyLoss() {
    const today = new Date().toDateString();
    if (this.store.dailyLossDate !== today) {
      this.store.dailyLosses = 0;
      this.store.dailyLossDate = today;
    }
    this.store.dailyLosses++;
  }

  async checkDailyLossLimit() {
    const limit = this.store.config.daily_loss_limit || 3;
    if (this.mock) {
      const today = new Date().toDateString();
      if (this.store.dailyLossDate !== today) return { limitHit: false, count: 0 };
      return { limitHit: this.store.dailyLosses >= limit, count: this.store.dailyLosses };
    }
    const r = await this.query(`
      SELECT COUNT(*) as c FROM signals
      WHERE outcome='LOSS' AND DATE(closed_at)=CURRENT_DATE
    `);
    const count = parseInt(r.rows[0]?.c || 0);
    return { limitHit: count >= limit, count };
  }

  // ── BRAIN 2 EVENTS ────────────────────────────────────────────────────────
  async saveBrain2Event(event) {
    if (this.mock) { this.store.brain2Events.unshift(event); return; }
    await this.query(`
      INSERT INTO brain2_events
        (signal_id, symbol, invalidation_level, description, action_taken, price_at_event, structure_level, alert_sent)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [event.signal_id, event.symbol, event.invalidation_level, event.description,
        event.action_taken, event.price_at_event, event.structure_level, event.alert_sent]);
  }

  // ── AI DECISIONS ──────────────────────────────────────────────────────────
  async saveAIDecision(d) {
    if (this.mock) { this.store.aiDecisions.unshift(d); return; }
    await this.query(`
      INSERT INTO ai_decisions
        (signal_id, symbol, brain_number, input_data, decision, conviction, reasoning, risk_flags, tokens_used, response_ms, passed_hard_rule, valid_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [d.signal_id, d.symbol, d.brain, JSON.stringify(d.input), d.decision,
        d.conviction, d.reasoning, JSON.stringify(d.riskFlags || []),
        d.tokensUsed || 0, d.responseMs || 0, d.passedHardRule !== false, d.validJson !== false]);
  }

  // FIX BUG-01: Patch AI decision log with real signal id after save
  // AI validates before save so signal_id is null initially — this corrects it
  // ISSUE-F6 FIX: PostgreSQL doesn't support ORDER BY in UPDATE — use subquery
  async patchAIDecisionSignalId(signalId, symbol) {
    if (this.mock) {
      const dec = this.store.aiDecisions.find(d => d.symbol === symbol && !d.signal_id);
      if (dec) dec.signal_id = signalId;
      return;
    }
    await this.query(`
      UPDATE ai_decisions SET signal_id = $1
      WHERE id = (
        SELECT id FROM ai_decisions
        WHERE symbol = $2 AND signal_id IS NULL AND brain_number = 1
        ORDER BY created_at DESC LIMIT 1
      )
    `, [signalId, symbol]).catch(() => {}); // Non-critical — best effort
  }

  // ── PERFORMANCE ───────────────────────────────────────────────────────────
  async getPerformanceStats({ symbol, days = 30 } = {}) {
    if (this.mock) {
      const cutoff = new Date(Date.now() - days * 86400000);
      let sigs = this.store.signals.filter(s =>
        s.outcome && ['WIN','LOSS','BREAKEVEN'].includes(s.outcome) &&
        new Date(s.created_at) > cutoff
      );
      if (symbol) sigs = sigs.filter(s => s.symbol === symbol);

      const bySymbol = {};
      sigs.forEach(s => {
        if (!bySymbol[s.symbol]) bySymbol[s.symbol] = { wins: 0, losses: 0, totalR: 0, trades: 0 };
        const b = bySymbol[s.symbol];
        b.trades++;
        b.totalR += s.pnl_r || 0;
        if (s.outcome === 'WIN') b.wins++;
        if (s.outcome === 'LOSS') b.losses++;
      });

      return Object.entries(bySymbol).map(([sym, b]) => ({
        symbol: sym,
        total_trades: b.trades,
        wins: b.wins,
        losses: b.losses,
        win_rate: b.trades > 0 ? ((b.wins / b.trades) * 100).toFixed(1) : 0,
        total_r: b.totalR.toFixed(2),
        avg_r: b.trades > 0 ? (b.totalR / b.trades).toFixed(2) : 0,
      }));
    }

    const symbolFilter = symbol ? 'AND symbol = $2' : '';
    const params = symbol ? [days, symbol] : [days];
    const r = await this.query(`
      SELECT symbol,
        COUNT(*) as total_trades,
        COUNT(CASE WHEN outcome='WIN' THEN 1 END) as wins,
        COUNT(CASE WHEN outcome='LOSS' THEN 1 END) as losses,
        ROUND(COUNT(CASE WHEN outcome='WIN' THEN 1 END)::float /
          NULLIF(COUNT(CASE WHEN outcome IN ('WIN','LOSS') THEN 1 END),0)*100,1) as win_rate,
        ROUND(SUM(pnl_r)::numeric,2) as total_r,
        ROUND(AVG(pnl_r)::numeric,2) as avg_r
      FROM signals
      WHERE outcome IS NOT NULL
        AND created_at > NOW() - ($1 || ' days')::INTERVAL
        ${symbolFilter}
      GROUP BY symbol ORDER BY total_r DESC
    `, params);
    return r.rows;
  }

  async getDailySummary() {
    if (this.mock) {
      const today = new Date().toDateString();
      const todaySigs = this.store.signals.filter(s =>
        new Date(s.created_at).toDateString() === today
      );
      const closed = todaySigs.filter(s => s.outcome);
      const wins = closed.filter(s => s.outcome === 'WIN').length;
      const dayR = closed.reduce((a, s) => a + (s.pnl_r || 0), 0);
      const totalR = this.store.signals.reduce((a, s) => a + (s.pnl_r || 0), 0);
      return {
        signals_sent: todaySigs.length,
        trades_taken: closed.length,
        win_rate: closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : 0,
        day_pnl_r: dayR.toFixed(2),
        total_r: totalR.toFixed(2),
      };
    }
    const r = await this.query(`
      SELECT
        COUNT(CASE WHEN DATE(created_at)=CURRENT_DATE THEN 1 END) as signals_sent,
        COUNT(CASE WHEN DATE(created_at)=CURRENT_DATE AND outcome IS NOT NULL THEN 1 END) as trades_taken,
        ROUND(COUNT(CASE WHEN DATE(created_at)=CURRENT_DATE AND outcome='WIN' THEN 1 END)::float /
          NULLIF(COUNT(CASE WHEN DATE(created_at)=CURRENT_DATE AND outcome IN ('WIN','LOSS') THEN 1 END),0)*100,1) as win_rate,
        ROUND(SUM(CASE WHEN DATE(created_at)=CURRENT_DATE THEN COALESCE(pnl_r,0) END)::numeric,2) as day_pnl_r,
        ROUND(SUM(COALESCE(pnl_r,0))::numeric,2) as total_r
      FROM signals
    `);
    return r.rows[0] || {};
  }

  async getHistoricalPerformance(symbol) {
    if (this.mock) {
      const closed = this.store.signals.filter(s => s.symbol === symbol && s.outcome);
      if (closed.length < 5) return null;
      const wins = closed.filter(s => s.outcome === 'WIN').length;
      return {
        sample_size: closed.length,
        win_rate: ((wins / closed.length) * 100).toFixed(1),
        avg_r: (closed.reduce((a,s) => a + (s.pnl_r||0), 0) / closed.length).toFixed(2),
      };
    }
    const r = await this.query(`
      SELECT COUNT(*) as sample_size,
        ROUND(COUNT(CASE WHEN outcome='WIN' THEN 1 END)::float /
          NULLIF(COUNT(CASE WHEN outcome IN ('WIN','LOSS') THEN 1 END),0)*100,1) as win_rate,
        ROUND(AVG(pnl_r)::numeric,2) as avg_r
      FROM signals WHERE symbol=$1 AND outcome IS NOT NULL
    `, [symbol]);
    return r.rows[0];
  }

  // ── CONFIG ────────────────────────────────────────────────────────────────
  async getConfig() {
    if (this.mock) return { ...this.store.config };
    const r = await this.query('SELECT key, value FROM system_config');
    return Object.fromEntries(r.rows.map(row => [row.key, row.value]));
  }

  async setConfig(key, value) {
    if (this.mock) { this.store.config[key] = value; return; }
    await this.query(`
      INSERT INTO system_config (key, value, updated_at) VALUES ($1,$2,NOW())
      ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()
    `, [key, JSON.stringify(value)]);
  }

  // ── NOTIFICATIONS ─────────────────────────────────────────────────────────
  async logNotification({ signal_id, channel, message_type, success, error_msg }) {
    if (this.mock) {
      this.store.notifications.unshift({ signal_id, channel, message_type, success, sent_at: new Date() });
      return;
    }
    await this.query(`
      INSERT INTO notification_log (signal_id, channel, message_type, success, error_msg)
      VALUES ($1,$2,$3,$4,$5)
    `, [signal_id, channel, message_type, success, error_msg]);
  }
}

module.exports = DatabaseService;
