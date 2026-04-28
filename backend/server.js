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
const Backtester        = require('./backtest');
const { PAIRS }         = require('./utils/constants');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public')));

// ── SERVICE INIT ─────────────────────────────────────────────────────────────
const db         = new DatabaseService({ connectionString: process.env.DATABASE_URL });
const data       = new DataService({ taapiKey: process.env.TAAPI_API_KEY, twelveDataKey: process.env.TWELVE_DATA_API_KEY });
const news       = new NewsService();
const ctrader    = new MT45Service();
const telegram   = new TelegramService();
const subscriber = new SubscriberService({ db });
const ai         = new AiAnalyst({ db });
const brain3     = new Brain3({ aiAnalyst: ai, notifier: telegram, db });
const brain2     = new Brain2({ dataService: data, aiAnalyst: ai, brain3, notifier: telegram, db, newsService: news });
const brain1     = new Brain1({ dataService: data, newsService: news, db });
const learning   = new LearningEngine({ db });

// ── SESSION CONFIG ─────────────────────────────────────────────────────────────
// Defines which pairs trade in each session, risk multipliers, and allowed entry types
const SESSION_CONFIG = {
  ASIAN: {
    label: 'Asian', utcStart: 0, utcEnd: 8,
    pairs:        ['USDJPY', 'AUDUSD', 'NZDUSD', 'EURJPY'],
    allowedTypes: ['TYPE_B', 'TYPE_C'],
    diamondRisk: 0.50, goldRisk: 0.375, silverRisk: 0.25,
  },
  LONDON: {
    label: 'London', utcStart: 8, utcEnd: 16,
    pairs:        ['EURUSD', 'GBPUSD', 'USDCHF', 'EURGBP'],
    allowedTypes: ['TYPE_A', 'TYPE_B', 'TYPE_C', 'TYPE_D'],
    diamondRisk: 1.00, goldRisk: 0.75,  silverRisk: 0.50,
  },
  NEW_YORK: {
    label: 'New York', utcStart: 13, utcEnd: 21,
    pairs:        ['EURUSD', 'GBPUSD', 'USDCAD', 'XAUUSD'],
    allowedTypes: ['TYPE_A', 'TYPE_B', 'TYPE_C', 'TYPE_D'],
    diamondRisk: 1.00, goldRisk: 0.75,  silverRisk: 0.50,
  },
};

// All unique pairs across all sessions
const ALL_PAIRS = [...new Set(Object.values(SESSION_CONFIG).flatMap(s => s.pairs))];

function _getPairsForNow() {
  const h = new Date().getUTCHours();
  const pairs = new Set();
  for (const cfg of Object.values(SESSION_CONFIG)) {
    if (h >= cfg.utcStart && h < cfg.utcEnd) cfg.pairs.forEach(p => pairs.add(p));
  }
  return [...pairs];
}

function _getSessionForPair(pair) {
  const h = new Date().getUTCHours();
  // Overlap priority: NY > London > Asian
  for (const [, cfg] of [['NY', SESSION_CONFIG.NEW_YORK], ['L', SESSION_CONFIG.LONDON], ['A', SESSION_CONFIG.ASIAN]]) {
    if (h >= cfg.utcStart && h < cfg.utcEnd && cfg.pairs.includes(pair)) return cfg;
  }
  return null;
}

// Active pairs list — all sessions combined (server.js API and DB seeding)
let activePairs = ALL_PAIRS;

// Current scan state — read by /api/scan/state and /api/status
let scanState = {
  scanning:       false,
  brain:          null,       // 'Brain1' | 'Brain2' | 'Brain3' | null
  currentPair:    null,
  lastScanAt:     null,
  completedPairs: [],
  errorPairs:     [],
  totalPairs:     0,
  brain2Active:   false,
  brain3Active:   false,
};

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

// Backtest async job map
const backtestJobs = new Map(); // jobId → { status, progress, progressMsg, report, error, symbol, startedAt }

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

  // Ensure pairs table exists and all active pairs are seeded
  await db.query(`
    CREATE TABLE IF NOT EXISTS pairs (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(20) UNIQUE NOT NULL,
      market VARCHAR(20) DEFAULT 'forex',
      session_type VARCHAR(20) DEFAULT 'FOREX',
      active BOOLEAN DEFAULT true,
      pip_size DECIMAL(10,5)
    )
  `).catch(() => {});

  for (const sym of activePairs) {
    await db.query(
      `INSERT INTO pairs (symbol, session_type, active)
       VALUES ($1, 'FOREX', true)
       ON CONFLICT (symbol) DO UPDATE SET active = true`,
      [sym]
    ).catch(() => {});
  }

  // backtest_results table
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_results (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(20),
      years_back INTEGER DEFAULT 1,
      total_trades INTEGER,
      win_rate DECIMAL(5,2),
      total_r DECIMAL(10,2),
      avg_r DECIMAL(10,4),
      largest_win DECIMAL(10,4),
      largest_loss DECIMAL(10,4),
      max_consecutive_losses INTEGER,
      full_report_json JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});

  // trades_archived table
  await db.query(`
    CREATE TABLE IF NOT EXISTS trades_archived (
      id SERIAL PRIMARY KEY,
      session_label VARCHAR(100),
      session_start TIMESTAMP,
      session_end TIMESTAMP,
      total_trades INTEGER,
      win_rate DECIMAL(5,2),
      total_r DECIMAL(10,2),
      trades_json JSONB,
      archived_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});

  await ctrader.connect();
  await telegram.testConnection();
  sysLog('system', 'APEX V2 started');
  console.log(`[APEX V2] Running on port ${PORT}`);
}

// ── AI SIGNAL FILTER ─────────────────────────────────────────────────────────
const TIER_RANK = { SKIP: 0, BRONZE: 1, SILVER: 2, GOLD: 3, DIAMOND: 4 };

async function processSignal(signal, pair) {
  try {
    const aiResult = await ai.analyzeSignalFull(signal);
    if (!aiResult) return signal;
    if (aiResult.tier === 'SKIP') {
      sysLog('signal', `AI SKIP on ${pair} — ${aiResult.reason}`, pair, 'SKIP');
      return null;
    }
    const b1Rank = TIER_RANK[signal.confidence_tier] ?? 2;
    const aiRank = TIER_RANK[aiResult.tier] ?? 2;
    const finalTier = aiRank < b1Rank ? aiResult.tier : signal.confidence_tier;
    return { ...signal, confidence_tier: finalTier, ai_conviction: aiResult.conviction, ai_reason: aiResult.reason };
  } catch {
    return signal; // AI unavailable — proceed with Brain1 tier unchanged
  }
}

// ── CRON JOBS ─────────────────────────────────────────────────────────────────

// Every 15 min: scan pairs active in current session
cron.schedule('*/15 * * * *', async () => {
  const sessionPairs = _getPairsForNow();
  if (!sessionPairs.length) return; // No session active (UTC 21-00)

  scanState.scanning       = true;
  scanState.brain          = 'Brain1';
  scanState.lastScanAt     = new Date().toISOString();
  scanState.completedPairs = [];
  scanState.errorPairs     = [];
  scanState.totalPairs     = sessionPairs.length;
  scanState.currentPair    = null;

  for (const pair of sessionPairs) {
    scanState.currentPair = pair;
    const sessCfg = _getSessionForPair(pair);
    try {
      const result = await brain1.scan(pair);
      const signal = result?.signal;
      scanState.completedPairs.push(pair);
      if (signal && signal.direction && signal.direction !== 'NEUTRAL') {
        // Gate entry type to session rules
        if (sessCfg && !sessCfg.allowedTypes.includes(signal.entry_type)) {
          sysLog('system', `${pair} ${signal.entry_type} not allowed in ${sessCfg.label} (${sessCfg.allowedTypes.join(',')})`, pair);
          continue;
        }
        const finalSignal = await processSignal({ ...signal, session_label: sessCfg?.label || 'Unknown' }, pair);
        if (finalSignal) {
          sysLog('signal', `[${sessCfg?.label}] ${finalSignal.confidence_tier} ${finalSignal.direction} on ${pair}${finalSignal.ai_conviction ? ` (AI: ${finalSignal.ai_conviction}%)` : ''}`, pair, finalSignal.confidence_tier);
          await handleSignal(finalSignal, pair);
        }
      }
    } catch (err) {
      scanState.errorPairs.push(pair);
      scanState.completedPairs.push(pair);
      sysLog('error', `Brain1 scan error on ${pair}: ${err.message}`, pair);
    }
  }
  scanState.scanning    = false;
  scanState.brain       = null;
  scanState.currentPair = null;
});

// Every 5 min: monitor open positions
cron.schedule('*/5 * * * *', async () => {
  scanState.brain2Active = true;
  try { await brain2.monitorAll(); } catch (err) {
    sysLog('error', `Brain2 monitor error: ${err.message}`);
  }
  scanState.brain2Active = false;
});

// Every minute: check TP1/TP2/SL exits
cron.schedule('* * * * *', async () => {
  scanState.brain3Active = true;
  try { await brain3.checkExits(); } catch {}
  scanState.brain3Active = false;
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
      activePairs:       activePairs,
      scanning:          scanState.scanning,
      activeBrain:       scanState.brain,
      currentPair:       scanState.currentPair,
      lastScanAt:        scanState.lastScanAt,
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
  const sessionPairs = _getPairsForNow();
  const scanPairs = sessionPairs.length ? sessionPairs : ALL_PAIRS; // Outside hours: scan all for preview

  scanState.scanning       = true;
  scanState.brain          = 'Brain1';
  scanState.lastScanAt     = new Date().toISOString();
  scanState.completedPairs = [];
  scanState.errorPairs     = [];
  scanState.totalPairs     = scanPairs.length;
  const results = [];

  for (const pair of scanPairs) {
    scanState.currentPair = pair;
    const sessCfg = _getSessionForPair(pair);
    try {
      const result = await brain1.scan(pair);
      const signal = result?.signal;
      const reason = result?.reason;
      scanState.completedPairs.push(pair);
      if (signal && signal.direction && signal.direction !== 'NEUTRAL') {
        if (sessCfg && !sessCfg.allowedTypes.includes(signal.entry_type)) {
          results.push({ pair, signal: 'TYPE_BLOCKED', reason: `${signal.entry_type} not allowed in ${sessCfg.label}` });
          continue;
        }
        const finalSignal = await processSignal({ ...signal, session_label: sessCfg?.label || 'Unknown' }, pair);
        results.push({ pair, signal: finalSignal?.confidence_tier || 'SKIP', reason });
        if (finalSignal) {
          sysLog('signal', `[${sessCfg?.label}] Manual signal: ${finalSignal.confidence_tier} on ${pair}`, pair);
          await handleSignal(finalSignal, pair);
        }
      } else {
        results.push({ pair, signal: 'NONE', reason });
      }
    } catch (err) {
      scanState.errorPairs.push(pair);
      scanState.completedPairs.push(pair);
      results.push({ pair, error: err.message });
    }
  }
  scanState.scanning    = false;
  scanState.brain       = null;
  scanState.currentPair = null;
  res.json({ scanned: scanPairs, signals: results.filter(r => r.signal && r.signal !== 'NONE').length, results });
});

// GET /api/scan/state  — lightweight, polled every 4s by activity panel
app.get('/api/scan/state', (req, res) => {
  res.json({
    scanning:       scanState.scanning,
    brain:          scanState.brain,
    brain2Active:   scanState.brain2Active,
    brain3Active:   scanState.brain3Active,
    currentPair:    scanState.currentPair,
    completedPairs: scanState.completedPairs,
    errorPairs:     scanState.errorPairs,
    totalPairs:     scanState.totalPairs,
    lastScanAt:     scanState.lastScanAt,
    activePairs:    activePairs,
  });
});

// GET /api/signals/active
app.get('/api/signals/active', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT * FROM signals WHERE status = 'ACTIVE' ORDER BY created_at DESC LIMIT 20`
    );
    res.json(r.rows || []);
  } catch {
    res.json([]);
  }
});

// GET /api/analyzer
app.get('/api/analyzer', async (req, res) => {
  const result = [];
  for (const pair of activePairs) {
    try {
      const d = await data.getCandles(pair, '4h', 50);
      result.push({
        pair,
        status: 'OK',
        data: {
          regime:       d.adx > 25 ? 'TRENDING' : 'RANGING',
          session:      getSession(),
          newsBlackout: false,
          rsi:          d.rsi?.toFixed(1),
          adx:          d.adx?.toFixed(1),
          ema21:        d.ema21?.toFixed(5),
          ema50:        d.ema50?.toFixed(5),
        },
      });
    } catch (err) {
      result.push({ pair, status: 'ERROR', error: err.message });
    }
  }
  res.json(result);
});

function getSession() {
  const h = new Date().getUTCHours();
  if (h >= 8  && h < 13) return 'London';
  if (h >= 13 && h < 21) return 'New York';
  if (h >= 21 || h < 8)  return 'Asian (skipped)';
  return 'Off-hours';
}

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

// GET /api/debug/scan/:symbol — full Brain1 analysis bypassing session filter
app.get('/api/debug/scan/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const b = brain1;
  const steps = [];

  try {
    const mkt = await b._fetchAll(symbol);
    if (!mkt) return res.json({ symbol, error: 'Data unavailable — check API keys', steps });

    steps.push({
      step: 'DATA_FETCH', ok: true,
      msg: `H4: ${mkt.h4?.candles?.length || 0} bars | H1: ${mkt.h1?.candles?.length || 0} | W: ${mkt.weekly?.candles?.length || 0} | D: ${mkt.daily?.candles?.length || 0}`,
    });

    const regime = b._regime(mkt);
    steps.push({
      step: 'REGIME', ok: regime.signalAllowed,
      msg: `${regime.label} | ADX: ${mkt.h4?.adx?.toFixed(1)} | ATR ratio: ${regime.atrRatio?.toFixed(2) ?? 'N/A'}`,
    });

    // Detailed bias breakdown — expose exactly why each TF is NEUTRAL
    const diagBias = (tf, label, minSwings) => {
      if (!tf?.closes?.length) return `${label}: NO_DATA`;
      const price  = tf.closes[tf.closes.length - 1];
      const highs  = tf.swingHighs?.slice(-(minSwings + 1)) || [];
      const lows   = tf.swingLows?.slice(-(minSwings + 1))  || [];
      const hasSwings = highs.length >= minSwings && lows.length >= minSwings;
      const lh = highs.slice(-2), ll = lows.slice(-2);
      const isHHHL = hasSwings && lh.length===2 && ll.length===2 && lh[1]>lh[0] && ll[1]>ll[0];
      const isLHLL = hasSwings && lh.length===2 && ll.length===2 && lh[1]<lh[0] && ll[1]<ll[0];
      const aboveEMAs = tf.ema21 && tf.ema50 && price > tf.ema50 && tf.ema21 > tf.ema50;
      const belowEMAs = tf.ema21 && tf.ema50 && price < tf.ema50 && tf.ema21 < tf.ema50;
      const result = b._bias(tf, minSwings);
      return `${label}=${result} [swH:${tf.swingHighs?.length||0} swL:${tf.swingLows?.length||0} need:${minSwings} | HH:${isHHHL} LL:${isLHLL} | p:${price?.toFixed(4)} ema21:${tf.ema21?.toFixed(4)} ema50:${tf.ema50?.toFixed(4)} | aboveEMA:${aboveEMAs} belowEMA:${belowEMAs}]`;
    };

    const bias = b._topDownBias(mkt);
    steps.push({
      step: 'TOP_DOWN_BIAS', ok: bias.direction !== 'NEUTRAL',
      msg: `→ ${bias.direction}${bias.h2Conflicts ? ' ⚠H2 conflict' : ''}\n  ${diagBias(mkt.weekly,'W',3)}\n  ${diagBias(mkt.daily,'D',3)}\n  ${diagBias(mkt.h4,'H4',3)}\n  ${diagBias(mkt.h2,'H2',3)}`,
    });

    if (!regime.signalAllowed || bias.direction === 'NEUTRAL') {
      return res.json({ symbol, finalResult: 'SKIPPED', blockedAt: !regime.signalAllowed ? 'REGIME' : 'BIAS', steps });
    }

    const loc = b._locationCheck(mkt, bias.direction);
    steps.push({
      step: 'LOCATION', ok: loc.valid,
      msg: loc.valid
        ? `${loc.type} @ ${loc.price?.toFixed(5)} | current price: ${loc.currentPrice?.toFixed(5)}`
        : `No key level within ${(mkt.h4?.atr * 0.6)?.toFixed(5) ?? '?'} ATR tolerance`,
    });

    if (!loc.valid) return res.json({ symbol, finalResult: 'SKIPPED', blockedAt: 'LOCATION', steps });

    const entryType = b._entryType(mkt, bias.direction, loc);
    steps.push({
      step: 'ENTRY_TYPE', ok: !!entryType,
      msg: entryType || 'No pattern — sweep/MSB/FVG/OB/EMA conditions not met',
    });

    if (!entryType) return res.json({ symbol, finalResult: 'SKIPPED', blockedAt: 'ENTRY_TYPE', steps });

    const cf = b._confluence(mkt, bias.direction, loc, symbol, bias.h2Conflicts);
    const minReq = { TYPE_A: 5, TYPE_B: 4, TYPE_C: 4, TYPE_D: 5 }[entryType] || 4;
    steps.push({
      step: 'CONFLUENCE', ok: cf.score >= minReq,
      msg: `Score ${cf.score}/9 (need ${minReq}) | ` +
        Object.entries(cf.factors).map(([k, v]) => `${k}:${v ? '✓' : '✗'}`).join(' '),
    });

    const levels = b._levels(mkt, bias.direction, loc);
    steps.push({
      step: 'LEVELS', ok: levels.valid && levels.rr >= 2,
      msg: levels.valid
        ? `Entry:${levels.entry?.toFixed(5)} SL:${levels.sl?.toFixed(5)} TP1:${levels.tp1?.toFixed(5)} TP2:${levels.tp2?.toFixed(5)} | RR:${levels.rr} | ATR:${levels.atr?.toFixed(5)}`
        : 'Invalid — zero ATR or no structure level',
    });

    const tier  = b._tier(cf.score);
    const allOk = regime.signalAllowed && bias.direction !== 'NEUTRAL' && loc.valid && !!entryType && cf.score >= minReq && levels.valid && levels.rr >= 2;

    res.json({
      symbol,
      finalResult:  allOk ? 'SIGNAL' : 'SKIPPED',
      blockedAt:    allOk ? null : steps.find(s => !s.ok)?.step,
      direction:    bias.direction,
      tier:         tier.label,
      score:        cf.score,
      entryType,
      currentPrice: loc.currentPrice,
      levels:       levels.valid ? levels : null,
      sessionNow:   getSession(),
      sessionNote:  'Session filter bypassed — live scan would be blocked outside London/NY',
      steps,
    });
  } catch (err) {
    res.status(500).json({ symbol, error: err.message, steps });
  }
});

// POST /api/backtest — starts async backtest job
app.post('/api/backtest', async (req, res) => {
  const { symbol = 'EURUSD', yearsBack = 1 } = req.body || {};
  const jobId = `bt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    jobId, symbol, yearsBack,
    status: 'running', progress: 0, progressMsg: 'Starting…',
    report: null, error: null, startedAt: new Date().toISOString(),
  };
  backtestJobs.set(jobId, job);

  // Run async — Railway times out HTTP after ~30s so we detach
  (async () => {
    try {
      const bt = new Backtester({
        TWELVE_DATA_API_KEY: process.env.TWELVE_DATA_API_KEY,
      });
      const report = await bt.runBacktest(symbol, parseInt(yearsBack) || 1, (pct, msg) => {
        job.progress    = pct;
        job.progressMsg = msg;
      });
      job.status   = 'done';
      job.progress = 100;
      job.report   = report;
      await db.query(
        `INSERT INTO backtest_results
         (symbol, years_back, total_trades, win_rate, total_r, avg_r, largest_win, largest_loss, max_consecutive_losses, full_report_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [symbol, yearsBack, report.summary.totalTrades, report.summary.winRate,
         report.summary.totalR, report.summary.avgR, report.summary.largestWin,
         report.summary.largestLoss, report.summary.maxConsecutiveLosses, JSON.stringify(report)]
      ).catch(() => {});
      sysLog('system', `Backtest ${symbol}: ${report.summary.totalTrades} trades, ${report.summary.winRate}% WR, ${report.summary.totalR}R`);
    } catch (err) {
      job.status = 'error';
      job.error  = err.message;
      sysLog('error', `Backtest failed ${symbol}: ${err.message}`);
    }
  })();

  res.json({ jobId, status: 'running' });
});

// GET /api/backtest/result/:jobId — poll job status
app.get('/api/backtest/result/:jobId', (req, res) => {
  const job = backtestJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// GET /api/backtest/history
app.get('/api/backtest/history', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, symbol, years_back, total_trades, win_rate, total_r, avg_r, created_at
       FROM backtest_results ORDER BY created_at DESC LIMIT 20`
    );
    res.json(r.rows || []);
  } catch { res.json([]); }
});

// POST /api/reset — archive trades, clear session
app.post('/api/reset', async (req, res) => {
  try {
    const statsQ = await db.query(`
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN outcome='WIN'  THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses,
        COALESCE(SUM(pnl_r), 0)::numeric as total_r,
        MIN(created_at) as session_start,
        MAX(COALESCE(closed_at, NOW())) as session_end
      FROM trades WHERE outcome IS NOT NULL
    `).catch(() => ({ rows: [{}] }));

    const st   = statsQ.rows[0] || {};
    const total = parseInt(st.total_trades || 0);
    const wins  = parseInt(st.wins  || 0);
    const losses = parseInt(st.losses || 0);
    const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
    const totalR  = parseFloat(st.total_r || 0);

    // Grab all trade rows for archive
    const tradesQ = await db.query('SELECT * FROM trades').catch(() => ({ rows: [] }));

    // Archive
    await db.query(
      `INSERT INTO trades_archived
       (session_label, session_start, session_end, total_trades, win_rate, total_r, trades_json, archived_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
      [
        `Session ${new Date().toISOString().slice(0, 10)}`,
        st.session_start || new Date().toISOString(),
        st.session_end   || new Date().toISOString(),
        total, winRate, totalR,
        JSON.stringify(tradesQ.rows),
      ]
    ).catch(() => {});

    // Delete closed trades and non-active signals
    await db.query(`DELETE FROM trades WHERE outcome IS NOT NULL`).catch(() => {});
    await db.query(`DELETE FROM signals WHERE status != 'ACTIVE'`).catch(() => {});

    sysLog('system', `RESET — archived ${total} trades (${winRate}% WR, ${totalR}R)`);
    res.json({ success: true, archived: { trades: total, wins, losses, winRate, totalR } });
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
