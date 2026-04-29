'use strict';

class TelegramNotifier {
  constructor({ botToken, chatId } = {}) {
    this.token = botToken;
    this.chatId = chatId;
    this.base = botToken ? `https://api.telegram.org/bot${botToken}` : null;
    this.active = Boolean(botToken && chatId);
    this.authState = this.active ? 'PENDING' : 'NOT_CONFIGURED';
    this.authError = null;
  }

  async validate() {
    if (!this.active) {
      this.authState = 'NOT_CONFIGURED';
      this.authError = null;
      return { ok: false, reason: 'not_configured' };
    }

    try {
      const res = await fetch(`${this.base}/getMe`);
      const body = await res.json();
      if (!body.ok) throw new Error(body.description || 'Telegram auth failed');
      this.authState = 'AUTHORIZED';
      this.authError = null;
      return { ok: true, bot: body.result?.username || body.result?.id };
    } catch (err) {
      this.authState = 'AUTH_FAILED';
      this.authError = err.message;
      return { ok: false, error: err.message };
    }
  }

  async send(text, type = 'MESSAGE') {
    if (!this.active) {
      console.log(`\n[Telegram NOT CONFIGURED] ${type}:\n${text}\n`);
      return { sent: false, reason: 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID or TELEGRAM_GROUP_ID' };
    }

    try {
      const res = await fetch(`${this.base}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.description);
      this.authState = 'AUTHORIZED';
      this.authError = null;
      console.log(`[Telegram] Sent: ${type}`);
      return { sent: true, messageId: body.result?.message_id };
    } catch (err) {
      this.authState = err.message === 'Unauthorized' ? 'AUTH_FAILED' : this.authState;
      this.authError = err.message;
      console.error('[Telegram] Error:', err.message);
      return { sent: false, error: err.message };
    }
  }

  formatFullSignal(signal, ai) {
    const time = this._fmtTime(signal.detected_at || signal.created_at || new Date());
    const fmt = (value) => this._fmtPrice(value, signal.symbol);
    const reasons = this._buildReasons(signal);

    return [
      `<b>APEX SIGNAL - ${signal.symbol}</b>`,
      '------------------------------',
      `<b>${signal.direction}</b> | ${signal.confidence_tier} | ${signal.entry_type}`,
      `UTC: ${time.utc}`,
      `Sydney: ${time.sydney}`,
      `Policy: ${signal.live_policy || 'target_growth_v6'}`,
      '------------------------------',
      `Entry: <b>${fmt(signal.entry_price)}</b>`,
      `Stop Loss: ${fmt(signal.stop_loss)}`,
      `TP1 (1:2): ${fmt(signal.tp1)}`,
      `TP2 (1:3): ${fmt(signal.tp2)}`,
      `Risk: ${signal.risk_pct}%`,
      '------------------------------',
      `Confluence: ${signal.confluence_score}/6`,
      `Claude AI: ${ai?.conviction || 0}% conviction`,
      `Regime: ${signal.regime}`,
      `Session: ${signal.session}`,
      `Level: ${signal.level_type || 'N/A'}`,
      '------------------------------',
      '<b>Why</b>',
      reasons,
      '------------------------------',
      `<i>${ai?.reasoning || 'Rule engine validated'}</i>`,
      ai?.risk_flags?.length ? `Risk flags: ${ai.risk_flags.join(', ')}` : '',
      'Valid for 4 hours unless Brain2/Brain3 updates it.',
    ].filter(Boolean).join('\n');
  }

  formatReadyAlert(signal) {
    const time = this._fmtTime(signal.detected_at || signal.created_at || new Date());
    return [
      `<b>APEX READY ALERT - ${signal.symbol}</b>`,
      '------------------------------',
      `Setup forming: ${signal.direction}`,
      `UTC: ${time.utc}`,
      `Sydney: ${time.sydney}`,
      `Confluence: ${signal.confluence_score}/6`,
      `Entry watch: ${this._fmtPrice(signal.entry_price, signal.symbol)}`,
      'Not a full signal yet. Wait for final trigger.',
    ].join('\n');
  }

  formatDailySummary(stats) {
    const time = this._fmtTime(new Date());
    return [
      '<b>APEX DAILY SUMMARY</b>',
      '------------------------------',
      `UTC: ${time.utc}`,
      `Sydney: ${time.sydney}`,
      `Signals: ${stats.signals_sent || 0}`,
      `Trades: ${stats.trades_taken || 0}`,
      `Win Rate: ${stats.win_rate || 0}%`,
      `Day PnL: ${stats.day_pnl_r > 0 ? '+' : ''}${stats.day_pnl_r || 0}R`,
      `All-Time: ${stats.total_r > 0 ? '+' : ''}${stats.total_r || 0}R`,
    ].join('\n');
  }

  _fmtPrice(value, symbol) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    if (symbol === 'XAUUSD' || symbol === 'GC1') return n.toFixed(2);
    if (symbol?.includes('JPY')) return n.toFixed(3);
    if (['BTCUSD', 'ETHUSD'].includes(symbol)) {
      return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return n.toFixed(5);
  }

  _fmtTime(value) {
    const date = new Date(value);
    return {
      utc: date.toLocaleString('en-AU', { timeZone: 'UTC', hour12: false }),
      sydney: date.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour12: false }),
    };
  }

  _buildReasons(signal) {
    const reasons = [];
    if (signal.htf_trend_aligned) reasons.push('- HTF trend aligned');
    if (signal.key_level_present) reasons.push(`- Price at ${signal.level_type || 'key level'}`);
    if (signal.volume_confirmed) reasons.push('- Volume confirms move');
    if (signal.rsi_momentum_aligned) reasons.push('- RSI momentum aligned');
    if (signal.candle_pattern_found) reasons.push('- Candle pattern confirmed');
    if (signal.intermarket_aligned) reasons.push('- Intermarket confirms direction');
    return reasons.join('\n') || '- Technical confluence confirmed';
  }
}

class WhatsAppNotifier {
  constructor({ accountSid, authToken, from, to } = {}) {
    this.active = Boolean(accountSid && authToken && from && to);
    this.from = from;
    this.to = to;
  }

  async send() {
    if (!this.active) {
      console.log('[WhatsApp] Dormant - configure Twilio credentials to activate');
      return { sent: false };
    }
    return { sent: false, reason: 'Dormant - activate Twilio client before use' };
  }
}

class Notifier {
  constructor({ telegram, whatsapp, db } = {}) {
    this.tg = telegram;
    this.wa = whatsapp;
    this.db = db;
  }

  async sendSignal(signal, ai) {
    const msg = this.tg.formatFullSignal(signal, ai);
    const result = await this.tg.send(msg, 'FULL_SIGNAL');
    await this.db.logNotification({
      signal_id: signal.id,
      channel: 'TELEGRAM',
      message_type: 'SIGNAL',
      success: result.sent,
      error_msg: result.error,
    });
    return result;
  }

  async sendReadyAlert(signal) {
    const result = await this.tg.send(this.tg.formatReadyAlert(signal), 'READY');
    await this.db.logNotification({
      signal_id: signal.id,
      channel: 'TELEGRAM',
      message_type: 'READY',
      success: result.sent,
      error_msg: result.error,
    });
    return result;
  }

  async sendDailySummary(stats) {
    return this.tg.send(this.tg.formatDailySummary(stats), 'SUMMARY');
  }

  async send(msg, type) {
    return this.tg.send(msg, type);
  }
}

module.exports = { TelegramNotifier, WhatsAppNotifier, Notifier };
