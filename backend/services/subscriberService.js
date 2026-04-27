'use strict';
// Manages signal subscribers and $10/month billing tracking

class SubscriberService {
  constructor({ db }) {
    this.db = db;
  }

  async addSubscriber(email, tier = 'free') {
    const nextInvoice = new Date();
    nextInvoice.setMonth(nextInvoice.getMonth() + 1);

    const result = await this.db.query(
      `INSERT INTO subscribers (email, tier, joined_date, status)
       VALUES ($1, $2, NOW(), 'active')
       ON CONFLICT (email) DO UPDATE SET tier = $2, status = 'active'
       RETURNING *`,
      [email, tier]
    );

    const row = result.rows?.[0];
    return {
      id:          row?.id,
      email:       row?.email,
      tier:        row?.tier,
      joinedDate:  row?.joined_date,
      nextInvoice: nextInvoice.toISOString(),
    };
  }

  async removeSubscriber(id) {
    await this.db.query(
      `UPDATE subscribers SET status = 'inactive' WHERE id = $1`,
      [id]
    );
  }

  async getSubscribers() {
    const r = await this.db.query(
      `SELECT * FROM subscribers ORDER BY joined_date DESC`
    );
    return r.rows || [];
  }

  async recordPayment(email, amount, date) {
    await this.db.query(
      `UPDATE subscribers SET last_payment_date = $1, status = 'active' WHERE email = $2`,
      [date || new Date(), email]
    );
  }

  async getTotalSubscribers() {
    const r = await this.db.query(
      `SELECT COUNT(*) as count FROM subscribers WHERE status = 'active'`
    );
    return parseInt(r.rows?.[0]?.count || 0);
  }

  async getTotalRevenue() {
    const count = await this.getTotalSubscribers();
    return { count, monthly: count * 10 };
  }

  // Sends invoice summary — email integration can be wired later
  async sendInvoice(email, amount, month) {
    const trades = await this.db.query(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
              SUM(pnl_r) as total_r
       FROM trades
       WHERE closed_at >= date_trunc('month', $1::date)
         AND closed_at < date_trunc('month', $1::date) + interval '1 month'`,
      [month || new Date()]
    );

    const stats = trades.rows?.[0] || {};
    const total  = parseInt(stats.total  || 0);
    const wins   = parseInt(stats.wins   || 0);
    const totalR = parseFloat(stats.total_r || 0).toFixed(1);
    const wr     = total > 0 ? Math.round((wins / total) * 100) : 0;

    console.log(`[Subscriber] Invoice for ${email}: ${total} trades, ${wr}% WR, +${totalR}R — $${amount}`);
    return { email, amount, total, wins, wr, totalR };
  }
}

module.exports = SubscriberService;
