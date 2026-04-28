// ═══════════════════════════════════════════════════════════════════════════
// NEWS SERVICE — Economic calendar blackout system
// Works without API keys using mock calendar
// ═══════════════════════════════════════════════════════════════════════════

const { NEWS } = require('../utils/constants');

class NewsService {
  constructor({ finnhubKey, db } = {}) {
    this.finnhubKey  = finnhubKey;
    this.finnhubBase = 'https://finnhub.io/api/v1';
    this.db          = db;
    this.calendar    = [];
    this.lastRefresh = null;
  }

  // ── CHECK BLACKOUT ─────────────────────────────────────────────────────────
  async checkBlackout(symbol) {
    await this._ensureFresh();
    const now = new Date();
    const currency = symbol.slice(0, 3); // EURUSD → EUR

    for (const ev of this.calendar) {
      const evTime    = new Date(ev.event_time);
      const blockStart = new Date(ev.block_start);
      const blockEnd   = new Date(ev.block_end);

      // Affects this pair?
      const relevant = ev.currency === currency ||
                        ev.currency === 'USD' ||
                        (ev.affects_pairs || []).includes(symbol);

      if (!relevant) continue;

      // Inside blackout window?
      if (now >= blockStart && now <= blockEnd) {
        return {
          blocked: true,
          event:   ev.title,
          impact:  ev.impact,
          minutesUntil: Math.max(0, Math.floor((evTime - now) / 60000)),
        };
      }

      // Pre-block warning for HIGH impact (30 min advance)
      if (ev.impact === 'HIGH') {
        const minsUntil = (evTime - now) / 60000;
        if (minsUntil > 0 && minsUntil <= 30) {
          return {
            blocked: true,
            event: ev.title,
            impact: ev.impact,
            minutesUntil: Math.floor(minsUntil),
          };
        }
      }
    }

    return { blocked: false };
  }

  // ── GET UPCOMING ──────────────────────────────────────────────────────────
  async getUpcoming(hours = 24) {
    await this._ensureFresh();
    const cutoff = new Date(Date.now() + hours * 3600000);
    return this.calendar
      .filter(ev => new Date(ev.event_time) > new Date() && new Date(ev.event_time) < cutoff)
      .sort((a, b) => new Date(a.event_time) - new Date(b.event_time))
      .slice(0, 15);
  }

  // ── REFRESH CALENDAR ──────────────────────────────────────────────────────
  async refresh() {
    try {
      if (!this.finnhubKey) {
        this.calendar  = this._mockCalendar();
        this.lastRefresh = Date.now();
        return;
      }

      const res = await fetch(`${this.finnhubBase}/calendar/economic?token=${this.finnhubKey}`);
      const data = await res.json();

      this.calendar = (data.economicCalendar || []).map(ev => {
        const impact    = this._mapImpact(ev.impact);
        const evTime    = new Date(ev.time * 1000);
        const before    = NEWS[impact]?.blockMinsBefore || 0;
        const after     = NEWS[impact]?.blockMinsAfter  || 0;

        return {
          title:        ev.event,
          impact,
          currency:     (ev.country || '').toUpperCase(),
          event_time:   evTime,
          actual:       ev.actual,
          forecast:     ev.estimate,
          previous:     ev.prev,
          affects_pairs: this._getPairsForCurrency((ev.country || '').toUpperCase()),
          block_start:  new Date(evTime.getTime() - before * 60000),
          block_end:    new Date(evTime.getTime() + after  * 60000),
        };
      });

      this.lastRefresh = Date.now();
      console.log(`[NewsService] Calendar refreshed: ${this.calendar.length} events`);

    } catch (err) {
      console.error('[NewsService] Refresh error:', err.message);
      if (!this.lastRefresh) {
        this.calendar    = this._mockCalendar();
        this.lastRefresh = Date.now();
      }
    }
  }

  async _ensureFresh() {
    if (!this.lastRefresh || Date.now() - this.lastRefresh > 30 * 60000) {
      await this.refresh();
    }
  }

  _mapImpact(raw) {
    if (!raw) return 'LOW';
    const s = String(raw).toLowerCase();
    if (s.includes('high') || s === '3') return 'HIGH';
    if (s.includes('med') || s === '2') return 'MEDIUM';
    return 'LOW';
  }

  _getPairsForCurrency(currency) {
    const map = {
      USD: ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','NZDUSD','USDCHF','XAUUSD','BTCUSD','ES1','GC1'],
      EUR: ['EURUSD','EURJPY','GBPUSD'],
      GBP: ['GBPUSD','GBPJPY'],
      JPY: ['USDJPY','GBPJPY','EURJPY'],
      AUD: ['AUDUSD'],
      CAD: ['USDCAD'],
      NZD: ['NZDUSD'],
      CHF: ['USDCHF'],
    };
    return map[currency] || [];
  }

  _mockCalendar() {
    const now = new Date();
    const add = (h) => new Date(now.getTime() + h * 3600000);

    return [
      {
        title: 'US Non-Farm Payrolls',
        impact: 'HIGH', currency: 'USD',
        event_time: add(48),
        affects_pairs: ['EURUSD','GBPUSD','XAUUSD','USDJPY'],
        block_start: add(48 - 2), block_end: add(48 + 1),
      },
      {
        title: 'ECB Interest Rate Decision',
        impact: 'HIGH', currency: 'EUR',
        event_time: add(72),
        affects_pairs: ['EURUSD','EURJPY'],
        block_start: add(72 - 2), block_end: add(72 + 1),
      },
      {
        title: 'US CPI',
        impact: 'HIGH', currency: 'USD',
        event_time: add(96),
        affects_pairs: ['EURUSD','XAUUSD','GBPUSD'],
        block_start: add(96 - 2), block_end: add(96 + 1),
      },
      {
        title: 'UK PMI Manufacturing',
        impact: 'MEDIUM', currency: 'GBP',
        event_time: add(12),
        affects_pairs: ['GBPUSD','GBPJPY'],
        block_start: add(12 - 0.5), block_end: add(12 + 0.5),
      },
    ];
  }
}

module.exports = NewsService;
