'use strict';
// Sends signals and trade updates to a Telegram group

const https = require('https');

class TelegramService {
  constructor() {
    this.token     = process.env.TELEGRAM_BOT_TOKEN;
    this.groupId   = process.env.TELEGRAM_GROUP_ID;
    this.format    = process.env.TELEGRAM_FORMAT || 'full';
    this.connected = false;
  }

  async sendSignal(signal, pair, tier, entry, sl, tp1, tp2, reason) {
    const tierEmoji = tier === 'DIAMOND' ? '💎' : tier === 'GOLD' ? '🥇' : '🥈';
    const dir       = signal === 'BUY' ? '🟢' : '🔴';
    const score     = `${tier === 'DIAMOND' ? 6 : tier === 'GOLD' ? 5 : 4}/6`;

    let text;
    if (this.format === 'minimal') {
      text = `${dir} ${pair} ${signal} | ${tier} | Entry: ${entry} | SL: ${sl} | TP1: ${tp1}`;
    } else {
      text = [
        `${dir} *${pair} ${signal}* | ${tierEmoji} ${tier} ${score}`,
        `📍 Entry: \`${entry}\``,
        `🛑 SL: \`${sl}\``,
        `🎯 TP1: \`${tp1}\`  |  TP2: \`${tp2}\``,
        reason ? `📝 ${reason}` : null,
        `🕐 ${this._sydneyTime()}`,
      ].filter(Boolean).join('\n');
    }

    return this._send(text);
  }

  async sendTradeOpened(orderId, pair, direction, entry, size, accountBalance) {
    const dir = direction === 'BUY' ? '🟢' : '🔴';
    const text = [
      `${dir} *Trade Opened — ${pair}*`,
      `Order: \`${orderId}\``,
      `Entry: \`${entry}\`  |  Size: ${size} lots`,
      `Balance: $${accountBalance?.toFixed(2)}`,
      `🕐 ${this._sydneyTime()}`,
    ].join('\n');
    return this._send(text);
  }

  async sendTradeUpdate(orderId, status, closedAt, pnl, pnlR, reason) {
    const emoji = status === 'TP1' || status === 'TP2' ? '✅' : status === 'SL' ? '❌' : 'ℹ️';
    const pnlStr = pnl >= 0 ? `+$${Math.abs(pnl).toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const rStr   = pnlR >= 0 ? `+${pnlR.toFixed(1)}R` : `${pnlR.toFixed(1)}R`;

    const text = [
      `${emoji} *${reason || status} HIT* | ${rStr} | ${pnlStr}`,
      status === 'TP1' ? '40% closed — SL moved to breakeven' : '',
      status === 'TP2' ? '40% closed — trailing 20% remaining' : '',
      `Order: \`${orderId}\``,
      `🕐 ${this._sydneyTime()}`,
    ].filter(Boolean).join('\n');

    return this._send(text);
  }

  async sendDailyLossAlert(lossCount, maxLosses) {
    const text = `⚠️ *${lossCount}/${maxLosses} losses today.* Stop after next loss.`;
    return this._send(text);
  }

  async testConnection() {
    try {
      const r = await this._send('✅ APEX V2 — Telegram connected');
      this.connected = r.ok;
      return r.ok;
    } catch {
      this.connected = false;
      return false;
    }
  }

  _sydneyTime() {
    return new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour12: false });
  }

  async _send(text) {
    return new Promise((resolve, reject) => {
      if (!this.token || !this.groupId) {
        console.warn('[Telegram] No token/group configured');
        return resolve({ ok: false });
      }

      const payload = JSON.stringify({
        chat_id:    this.groupId,
        text,
        parse_mode: 'Markdown',
      });

      const options = {
        hostname: 'api.telegram.org',
        path:     `/bot${this.token}/sendMessage`,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      };

      const req = https.request(options, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const r = JSON.parse(data);
            this.connected = r.ok;
            resolve(r);
          } catch { resolve({ ok: false }); }
        });
      });

      req.on('error', err => { this.connected = false; reject(err); });
      req.write(payload);
      req.end();
    });
  }
}

module.exports = TelegramService;
