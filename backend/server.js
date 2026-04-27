'use strict';
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');

const DatabaseService   = require('./services/databaseService');
const DataService       = require('./services/dataService');
const NewsService       = require('./services/newsService');
const MT45Service       = require('./services/mt45Service');
const TelegramService   = require('./services/telegramService');
const SubscriberService = require('./services/subscriberService');
const Brain1            = require('./engines/brain1-signal');
const { Brain2, Brain3 }= require('./engines/brain23');
const AiAnalyst         = require('./engines/aiAnalyst');
const LearningEngine    = require('./engines/learningEngine');
const { PAIRS }         = require('./utils/constants');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public')));

// ── SERVICE INIT ─────────────────────────────────────────────────────────────
const db         = new DatabaseService({ connectionString: process.env.DATABASE_URL });
const data       = new DataService();
const news       = new NewsService();
const ctrader    = new MT45Service();
const telegram   = new TelegramService();
const subscriber = new SubscriberService({ db });
const ai         = new AiAnalyst({ db });
const brain3     = new Brain3({ aiAnalyst: ai, notifier: telegram, db });
const brain2     = new Brain2({ dataService: data, aiAnalyst: ai, brain3, notifier: telegram, db, newsService: news });
const brain1     = new Brain1({ dataService: data, newsService: news, db });
const learning   = new LearningEngine({ db });

// Active pairs list (can be toggled from settings)
let activePairs = ['EURUSD', 'XAUUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD'];

// Runtime settings
let settings = {
  autoExecute:        process.env.AUTO_EXECUTE === 'true',
  manualReview:       process.env.MANUAL_REVIEW !== 'false',
  liveMode:           process.env.LIVE_MODE === 'true',
  diamondRisk:        1.0,
  goldRisk:           0.75,
  silverRisk:         0.5,
  dailyLossLimit:     4,
  diamondConviction:  88,
  goldConviction:     75,
  silverConviction:   65,
};

// System log buffer (last 50 events)
const sysLogs = [];
function sysLog(type, message, symbol = null, status = null) {
  sysLogs.unshift({ timestamp: new Date().toISOString(), type, message, symbol, status });
  if (sysLogs.length > 50) sysLogs.pop();
  db.query(
    `INSERT INTO system_logs (log_type, message, symbol, status) VALUES ($1,$2,$3,$4)`,
    [type, message, symbol, status]
  ).catch(() => {});
}

// ── STARTUP ───────────────────────────────────────────────────────────────────
async function startup() {
  await db.connect();
  await ctrader.connect();
  await telegram.testConnection();
  sysLog('system', 'APEX V2 started');
  console.log(`[APEX V2] Running on port ${PORT}`);
}

// ── CRON JOBS ─────────────────────────────────────────────────────────────────

// Every 15 min: scan all pairs
cron.schedule('*/15 * * * *', async () => {
  for (const pair of activePairs) {
    try {
      const signal = await brain1.scan(pair);
      if (signal && signal.direction && signal.direction !== 'NEUTRAL') {
        sysLog('signal', `Signal: ${signal.confidence_tier} ${signal.direction} on ${pair}`, pair, signal.confidence_tier);
        await handleSignal(signal, pair);
      }
    } catch (err) {
      sysLog('error', `Brain1 scan error on ${pair}: ${err.message}`, pair);
    }
  }
});

// Every 5 min: monitor open positions
cron.schedule('*/5 * * * *', async () => {
  try { await brain2.monitorAll(); } catch (err) {
    sysLog('error', `Brain2 monitor error: ${err.message}`);
  }
});

// Every minute: check TP1/TP2/SL exits
cron.schedule('* * * * *', async () => {
  try { await brain3.checkExits(); } catch {}
});

// Daily 00:00 Sydney (14:00 UTC winter / 13:00 UTC summer): reset daily loss counter
cron.schedule('0 14 * * *', async () => {
  try {
    await db.query(`UPDATE system_logs SET status = 'RESET' WHERE log_type = 'daily_loss' AND DATE(timestamp) < CURRENT_DATE`);
    sysLog('system', 'Daily loss counter reset');
  } catch {}
});

// Monday 08:00 UTC = Monday 16:00 Sydney (winter): run learning engine
cron.schedule('0 8 * * 1', async () => {
  try {
    sysLog('learning', 'Weekly learning cycle started');
    await learning.analyze();
    sysLog('learning', 'Weekly learning cycle complete');
  } catch (err) {
    sysLog('error', `Learning engine error: ${err.message}`);
  }
});

// Every hour: auto-reconnect cTrader if disconnected
cron.schedule('0 * * * *', async () => {
  if (!ctrader.isConnected()) {
    sysLog('system', 'MT4/MT5 disconnected — reconnecting...');
    await ctrader.reconnect();
  }
});

// ── SIGNAL HANDLER ────────────────────────────────────────────────────────────
async function handleSignal(signal, pair) {
  // Always send to Telegram
  await telegram.sendSignal(
    signal.direction, pair, signal.confidence_tier,
    signal.entry_price, signal.stop_loss, signal.tp1, signal.tp2,
    signal.regime
  );

  if (!settings.autoExecute) return;

  // Auto-execute on cTrader
  const riskMap = { DIAMOND: settings.diamondRisk, GOLD: settings.goldRisk, SILVER: settings.silverRisk };
  const risk = riskMap[signal.confidence_tier] || 0.5;

  try {
    const order = await ctrader.placeOrder(
      pair, signal.type, signal.entry, signal.sl, signal.tp1, signal.tp2, risk
    );

    // Save to trades table
    await db.query(
      `INSERT INTO trades (signal_id, ctrader_order_id, symbol, direction, entry_price, entry_time, stop_loss, tp1, tp2, size, tier)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,$10)`,
      [signal.id, order.orderId, pair, signal.type, order.executedPrice, signal.sl, signal.tp1, signal.tp2, order.size, signal.tier]
    );

    const bal = await ctrader.getBalance();
    await telegram.sendTradeOpened(order.orderId, pair, signal.type, order.executedPrice, order.size, bal?.balance);
    sysLog('trade', `Order placed: ${order.orderId} — ${pair} ${signal.type}`, pair, 'OPEN');
  } catch (err) {
    sysLog('error', `Auto-execute failed for ${pair}: ${err.message}`, pair, 'FAILED');
    await telegram.sendDailyLossAlert(0, settings.dailyLossLimit);
  }
}

// ── API ROUTES ────────────────────────────────────────────────────────────────

// POST /api/signal/fire
app.post('/api/signal/fire', async (req, res) => {
  const signal = req.body;
  if (!signal?.type || !signal?.tier) return res.status(400).json({ error: 'Invalid signal' });

  try {
    await handleSignal(signal, signal.symbol || signal.pair);
    res.json({ success: true, status: settings.autoExecute ? 'EXECUTED' : 'TELEGRAM_ONLY' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/status
app.get('/api/status', async (req, res) => {
  try {
    const bal     = await ctrader.getBalance().catch(() => null);
    const signals = await db.getActiveSignals().catch(() => []);
    const last    = signals[0];

    // 7-day win rate
    const wr = await db.query(
      `SELECT COUNT(*) as total, SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins
       FROM trades WHERE closed_at >= NOW() - INTERVAL '7 days' AND outcome IS NOT NULL`
    ).catch(() => ({ rows: [{ total: 0, wins: 0 }] }));
    const wrRow  = wr.rows?.[0] || {};
    const winPct = wrRow.total > 0 ? Math.round((wrRow.wins / wrRow.total) * 100) : null;

    // Daily loss count
    const losses = await db.query(
      `SELECT COUNT(*) as count FROM trades WHERE outcome='LOSS' AND DATE(closed_at) = CURRENT_DATE`
    ).catch(() => ({ rows: [{ count: 0 }] }));

    res.json({
      balance:           bal?.balance    || null,
      equity:            bal?.equity     || null,
      todayPnL:          bal?.pnl        || null,
      openPositions:     signals.filter(s => s.status === 'ACTIVE').length,
      dailyLosses:       parseInt(losses.rows?.[0]?.count || 0),
      dailyLossLimit:    settings.dailyLossLimit,
      winRate7d:         winPct,
      lastSignal:        last ? { pair: last.symbol, direction: last.direction, tier: last.confidence_tier, timestamp: last.created_at } : null,
      brokerConnected:   ctrader.isConnected(),
      brokerPlatform:    process.env.MT_PLATFORM || 'mt5',
      telegramConnected: telegram.connected,
      autoExecute:       settings.autoExecute,
      manualReview:      settings.manualReview,
      timezone:          'Australia/Sydney',
      sydneyTime:        new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trades/recent
app.get('/api/trades/recent', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT t.*, s.tier, s.entry_type, s.confluence_score
       FROM trades t LEFT JOIN signals s ON t.signal_id = s.id
       WHERE t.closed_at IS NOT NULL
       ORDER BY t.closed_at DESC LIMIT 20`
    );
    res.json(r.rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trades/open
app.get('/api/trades/open', async (req, res) => {
  try {
    const positions = await ctrader.getOpenPositions();
    res.json(positions);
  } catch {
    res.json([]);
  }
});

// POST /api/scan/manual
app.post('/api/scan/manual', async (req, res) => {
  const results = [];
  for (const pair of activePairs) {
    try {
      const signal = await brain1.scan(pair);
      results.push({ pair, signal: signal?.confidence_tier || 'NONE' });
      if (signal && signal.direction && signal.direction !== 'NEUTRAL') {
        sysLog('signal', `Manual scan signal: ${signal.confidence_tier} on ${pair}`, pair);
        await handleSignal(signal, pair);
      }
    } catch (err) {
      results.push({ pair, error: err.message });
    }
  }
  res.json({ scanned: activePairs, signals: results.filter(r => r.signal && r.signal !== 'NONE').length, results });
});

// GET /api/analyzer
app.get('/api/analyzer', async (req, res) => {
  const result = [];
  for (const pair of activePairs) {
    try {
      const d = await data.getMarketData(pair, '4h');
      result.push({ pair, status: 'OK', data: d });
    } catch {
      result.push({ pair, status: 'ERROR' });
    }
  }
  res.json(result);
});

// GET /api/pairs
app.get('/api/pairs', (req, res) => {
  res.json(activePairs.map(p => ({ pair: p, active: true })));
});

// POST /api/pairs/update
app.post('/api/pairs/update', (req, res) => {
  const { pairs } = req.body;
  if (Array.isArray(pairs)) {
    activePairs = pairs;
    sysLog('system', `Pairs updated: ${pairs.join(', ')}`);
  }
  res.json({ success: true, activePairs });
});

// POST /api/settings/update
app.post('/api/settings/update', (req, res) => {
  const s = req.body;
  const clamp = (v, min, max) => Math.min(max, Math.max(min, parseFloat(v) || 0));

  if (s.diamondRisk     !== undefined) settings.diamondRisk     = clamp(s.diamondRisk, 0.5, 2);
  if (s.goldRisk        !== undefined) settings.goldRisk        = clamp(s.goldRisk, 0.5, 2);
  if (s.silverRisk      !== undefined) settings.silverRisk      = clamp(s.silverRisk, 0.5, 2);
  if (s.dailyLossLimit  !== undefined) settings.dailyLossLimit  = clamp(s.dailyLossLimit, 1, 6);
  if (s.autoExecute     !== undefined) settings.autoExecute     = !!s.autoExecute;
  if (s.manualReview    !== undefined) settings.manualReview    = !!s.manualReview;
  if (s.liveMode        !== undefined) settings.liveMode        = !!s.liveMode;

  sysLog('system', `Settings updated: autoExecute=${settings.autoExecute}`);
  res.json({ success: true, appliedSettings: settings });
});

// GET /api/settings
app.get('/api/settings', (req, res) => res.json(settings));

// GET /api/learning/results
app.get('/api/learning/results', async (req, res) => {
  try {
    const results = await learning.getLastResults();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/learning/approve
app.post('/api/learning/approve', async (req, res) => {
  const { patternId, approved } = req.body;
  try {
    await learning.applyApproval(patternId, approved);
    sysLog('learning', `User ${approved ? 'approved' : 'rejected'} learning suggestion #${patternId}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/learning/run — manual trigger
app.post('/api/learning/run', async (req, res) => {
  try {
    sysLog('learning', 'Manual learning cycle triggered');
    const result = await learning.analyze();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/subscribers
app.get('/api/subscribers', async (req, res) => {
  try {
    const list = await subscriber.getSubscribers();
    const rev  = await subscriber.getTotalRevenue();
    res.json({ total: rev.count, revenue: rev.monthly, subscribers: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/subscribers/add
app.post('/api/subscribers/add', async (req, res) => {
  const { email, tier } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const sub = await subscriber.addSubscriber(email, tier || 'free');
    sysLog('system', `Subscriber added: ${email} (${tier})`);
    res.json({ success: true, subscriber: sub });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/subscribers/:id
app.delete('/api/subscribers/:id', async (req, res) => {
  try {
    await subscriber.removeSubscriber(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs
app.get('/api/logs', (req, res) => {
  const { type } = req.query;
  const filtered = type && type !== 'all' ? sysLogs.filter(l => l.type === type) : sysLogs;
  res.json(filtered.slice(0, 50));
});

// GET /api/broker/status
app.get('/api/broker/status', async (req, res) => {
  try {
    const bal = await ctrader.getBalance().catch(() => null);
    res.json({
      connected:  ctrader.isConnected(),
      platform:   process.env.MT_PLATFORM || 'mt5',
      accountId:  process.env.META_API_ACCOUNT_ID || null,
      balance:    bal?.balance || null,
      equity:     bal?.equity  || null,
      lastSync:   new Date().toISOString(),
    });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// POST /api/broker/reconnect
app.post('/api/broker/reconnect', async (req, res) => {
  try {
    const ok = await ctrader.reconnect();
    res.json({ success: ok, connected: ctrader.isConnected() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/telegram/test
app.post('/api/telegram/test', async (req, res) => {
  try {
    const ok = await telegram.testConnection();
    res.json({ success: ok, connected: telegram.connected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
startup().then(() => {
  app.listen(PORT, () => console.log(`[APEX V2] Listening on port ${PORT}`));
}).catch(err => {
  console.error('[APEX V2] Startup error:', err.message);
  process.exit(1);
});
