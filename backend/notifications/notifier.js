// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS — Telegram (live) + WhatsApp (built, dormant)
// Works without any keys — logs to console
// ═══════════════════════════════════════════════════════════════════════════

class TelegramNotifier {
  constructor({ botToken, chatId } = {}) {
    this.token   = botToken;
    this.chatId  = chatId;
    this.base    = botToken ? `https://api.telegram.org/bot${botToken}` : null;
    this.active  = !!(botToken && chatId);
  }

  async send(text, type = 'MESSAGE') {
    if (!this.active) {
      console.log(`\n[Telegram — NOT CONFIGURED] ${type}:\n${text}\n`);
      return { sent: false, reason: 'Not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID' };
    }
    try {
      const res = await fetch(`${this.base}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      const r = await res.json();
      if (!r.ok) throw new Error(r.description);
      console.log(`[Telegram] ✅ Sent: ${type}`);
      return { sent: true, messageId: r.result?.message_id };
    } catch (err) {
      console.error('[Telegram] Error:', err.message);
      return { sent: false, error: err.message };
    }
  }

  formatFullSignal(signal, ai) {
    const tierEmoji = { DIAMOND:'💎', GOLD:'🥇', SILVER:'🥈' }[signal.confidence_tier] || '📊';
    const dirEmoji  = signal.direction === 'BUY' ? '🟢' : '🔴';
    const fmt = (v) => this._fmtPrice(v, signal.symbol);
    const bar = '▰'.repeat(signal.confluence_score) + '▱'.repeat(6 - signal.confluence_score);

    const reasons = this._buildReasons(signal);

    return `🚨 <b>APEX — ${signal.symbol}</b>
━━━━━━━━━━━━━━━━━━━━━━━
${dirEmoji} <b>${signal.direction}</b>  |  ${tierEmoji} ${signal.confidence_tier}
━━━━━━━━━━━━━━━━━━━━━━━
📍 Entry     : <b>${fmt(signal.entry_price)}</b>
🛑 Stop Loss : ${fmt(signal.stop_loss)}
🎯 TP1 (1:2) : ${fmt(signal.tp1)}
🎯 TP2 (1:3) : ${fmt(signal.tp2)}
━━━━━━━━━━━━━━━━━━━━━━━
📊 Confluence : ${bar} ${signal.confluence_score}/6
🤖 AI         : ${ai?.conviction || 0}% conviction
📈 Regime     : ${signal.regime}
⏰ Session    : ${signal.session?.replace('_',' ')}
━━━━━━━━━━━━━━━━━━━━━━━
📌 Why:
${reasons}
━━━━━━━━━━━━━━━━━━━━━━━
🤖 AI note: <i>${ai?.reasoning || 'Rule engine validated'}</i>
${ai?.risk_flags?.length ? `⚠️ Flags: ${ai.risk_flags.join(', ')}` : ''}
━━━━━━━━━━━━━━━━━━━━━━━
⏱ Valid 4h  |  Type: ${signal.entry_type}  |  Risk: ${signal.risk_pct}%`;
  }

  formatReadyAlert(signal) {
    const dir = signal.direction === 'BUY' ? '🟢' : '🔴';
    return `👁 <b>GET READY — ${signal.symbol}</b>
━━━━━━━━━━━━━━━━━━━━━━━
${dir} Setup forming: ${signal.direction}
Confluence: ${signal.confluence_score}/6
Wait for final trigger
━━━━━━━━━━━━━━━━━━━━━━━
Watch: ${this._fmtPrice(signal.entry_price, signal.symbol)}
<i>Not a signal yet</i>`;
  }

  formatDailySummary(stats) {
    const emoji = parseFloat(stats.win_rate) >= 60 ? '🟢' : parseFloat(stats.win_rate) >= 50 ? '🟡' : '🔴';
    return `📊 <b>APEX DAILY SUMMARY</b>
━━━━━━━━━━━━━━━━━━━━━━━
${new Date().toDateString()}
━━━━━━━━━━━━━━━━━━━━━━━
Signals   : ${stats.signals_sent || 0}
Trades    : ${stats.trades_taken || 0}
${emoji} Win Rate : ${stats.win_rate || 0}%
Day P&L   : ${stats.day_pnl_r > 0 ? '+' : ''}${stats.day_pnl_r}R
All-Time  : ${stats.total_r > 0 ? '+' : ''}${stats.total_r}R`;
  }

  _fmtPrice(v, sym) {
    if (!v) return '—';
    if (sym === 'XAUUSD' || sym === 'GC1') return v.toFixed(2);
    if (sym?.includes('JPY'))              return v.toFixed(3);
    if (['BTCUSD','ETHUSD'].includes(sym)) return v.toLocaleString(undefined, { minimumFractionDigits: 2 });
    return v.toFixed(5);
  }

  _buildReasons(signal) {
    const r = [];
    if (signal.htf_trend_aligned)    r.push('• HTF trend aligned (W+D)');
    if (signal.key_level_present)    r.push(`• Price at ${signal.level_type?.replace('_',' ') || 'key level'}`);
    if (signal.volume_confirmed)     r.push('• Volume confirms move');
    if (signal.rsi_momentum_aligned) r.push('• RSI momentum aligned');
    if (signal.candle_pattern_found) r.push('• Candle pattern confirmed');
    if (signal.intermarket_aligned)  r.push('• Intermarket confirms direction');
    return r.join('\n') || '• Technical confluence confirmed';
  }
}

// ── WHATSAPP (built, dormant) ─────────────────────────────────────────────────
class WhatsAppNotifier {
  constructor({ accountSid, authToken, from, to } = {}) {
    this.active = !!(accountSid && authToken && from && to);
    this.from   = from;
    this.to     = to;
    // Twilio client would be initialized here when activated
  }

  async send(text) {
    if (!this.active) {
      console.log('[WhatsApp] DORMANT — configure Twilio credentials to activate');
      return { sent: false };
    }
    // Twilio integration ready to activate:
    // const client = require('twilio')(accountSid, authToken);
    // await client.messages.create({ from: `whatsapp:${this.from}`, to: `whatsapp:${this.to}`, body: text });
    return { sent: false, reason: 'Dormant — activate Twilio' };
  }
}

// ── ORCHESTRATOR ──────────────────────────────────────────────────────────────
class Notifier {
  constructor({ telegram, whatsapp, db } = {}) {
    this.tg  = telegram;
    this.wa  = whatsapp; // dormant
    this.db  = db;
  }

  async sendSignal(signal, ai) {
    const msg = this.tg.formatFullSignal(signal, ai);
    const r   = await this.tg.send(msg, 'FULL_SIGNAL');
    await this.db.logNotification({ signal_id: signal.id, channel: 'TELEGRAM', message_type: 'SIGNAL', success: r.sent });
    // wa dormant: if (this.wa?.active) await this.wa.send(msg);
    return r;
  }

  async sendReadyAlert(signal) {
    const msg = this.tg.formatReadyAlert(signal);
    return this.tg.send(msg, 'READY');
  }

  async sendDailySummary(stats) {
    return this.tg.send(this.tg.formatDailySummary(stats), 'SUMMARY');
  }

  async send(msg, type) {
    return this.tg.send(msg, type);
  }
}

module.exports = { TelegramNotifier, WhatsAppNotifier, Notifier };
