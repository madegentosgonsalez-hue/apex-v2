// ═══════════════════════════════════════════════════════════════════════════
// APEX SIGNAL SYSTEM — MAIN SERVER v1.0
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const DatabaseService              = require('./services/databaseService');
const DataService                  = require('./services/dataService');
const NewsService                  = require('./services/newsService');
const Brain1                       = require('./engines/brain1-signal');
const { Brain2, Brain3 }           = require('./engines/brain23');
const AIAnalyst                    = require('./engines/aiAnalyst');
const LearningEngine               = require('./engines/learningEngine');
const Backtester                   = require('./backtest');
const { getPairPolicy }            = require('./overlays/pairSessionPolicies');
const { TelegramNotifier, WhatsAppNotifier, Notifier } = require('./notifications/notifier');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─── BOOT ─────────────────────────────────────────────────────────────────────
async function boot() {
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║      APEX SIGNAL SYSTEM v1.0          ║');
  console.log('╚═══════════════════════════════════════╝\n');

  // Services
  const db   = new DatabaseService({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const data = new DataService({
    taapiKey:     process.env.TAAPI_API_KEY,
    twelveDataKey: process.env.TWELVE_DATA_API_KEY,
    polygonKey: process.env.POLYGON_API_KEY,
    marketDataProvider: process.env.MARKET_DATA_PROVIDER,
  });

  const news = new NewsService({
    finnhubKey: process.env.FINNHUB_API_KEY,
    db,
  });
  await news.refresh();

  // Notifications
  const telegram = new TelegramNotifier({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId:   process.env.TELEGRAM_CHAT_ID,
  });
  const whatsapp = new WhatsAppNotifier({
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken:  process.env.TWILIO_AUTH_TOKEN,
    from:       process.env.TWILIO_WHATSAPP_FROM,
    to:         process.env.WHATSAPP_TO,
  });
  const notifier = new Notifier({ telegram, whatsapp, db });

  // AI
  const ai = new AIAnalyst({ db, apiKey: process.env.ANTHROPIC_API_KEY });

  // Brains
  const brain3 = new Brain3({ aiAnalyst: ai, notifier, db });
  // NEW-04 FIX: pass newsService to Brain2 so it can check news approaching
  const brain2 = new Brain2({ dataService: data, aiAnalyst: ai, brain3, notifier, db, newsService: news });
  const brain1 = new Brain1({ dataService: data, newsService: news, db });

  // Learning engine
  const learning = new LearningEngine({ aiAnalyst: ai, db, notifier });
  const backtestJobs = new Map();

  // ─── SIGNAL PIPELINE ──────────────────────────────────────────────────────
  async function processPipeline(symbol) {
    const scan = await brain1.scan(symbol);
    if (!scan.signal) return;

    const { signal } = scan;

    // Historical context for AI
    const hist = await db.getHistoricalPerformance(symbol);

    // AI validation — signal has no DB id yet, that's expected here
    // AI _log() handles null signalId gracefully; id is patched after save
    const aiResp = await ai.validateSignal(signal, hist);

    // Attach AI response to signal before saving
    signal.ai_decision    = aiResp.decision;
    signal.ai_conviction  = aiResp.conviction;
    signal.ai_reasoning   = aiResp.reasoning;
    signal.ai_risk_flags  = aiResp.risk_flags;
    signal.ai_adjustments = aiResp.adjustments;

    // ── TIER PROTECTION LAYER ────────────────────────────────────────────────
    // AI conviction must justify the tier. Brain1 assigns tier by confluence score alone.
    // AI can only REDUCE the tier — never increase it.
    // This is the professional position-sizing gate.
    //
    // Diamond: 6/6 + AI ≥88% → 2.0% risk  (exceptional — max size)
    // Gold:    5/6 + AI ≥75% → 1.5% risk  (high confidence)
    // Silver:  4/6 + AI ≥65% → 1.0% risk  (ready alert, standard size)
    //
    if (aiResp.decision !== 'REJECT') {
      const conviction = aiResp.conviction || 0;

      if (signal.confidence_tier === 'DIAMOND' && conviction < 88) {
        // 6/6 confluence but AI not at max confidence → downgrade to Gold
        signal.confidence_tier = 'GOLD';
        signal.risk_pct = 1.5;
        console.log(`[Pipeline] ${symbol}: 💎→🥇 tier downgraded (conviction ${conviction}% < 88% required for Diamond)`);
      }

      if (signal.confidence_tier === 'GOLD' && conviction < 75) {
        // 5/6 or downgraded Diamond but AI not confident enough → Silver
        signal.confidence_tier = 'SILVER';
        signal.risk_pct = 1.0;
        console.log(`[Pipeline] ${symbol}: 🥇→🥈 tier downgraded (conviction ${conviction}% < 75% required for Gold)`);
      }

      if (signal.confidence_tier === 'SILVER' && conviction < 65) {
        // Should not happen (hard rule), but if AI barely approved → WAIT
        signal.confidence_tier = 'BRONZE';
        signal.risk_pct = 0;
        console.log(`[Pipeline] ${symbol}: 🥈→🥉 tier downgraded (conviction ${conviction}% < 65%)`);
        aiResp.decision = 'REJECT'; // Force reject — not worth trading
      }
    }

    // Determine signal type based on FINAL (post-protection) tier
    let sigType;
    if (aiResp.decision === 'REJECT') {
      sigType = 'NO_TRADE';
    } else if (signal.confidence_tier === 'DIAMOND' || signal.confidence_tier === 'GOLD') {
      sigType = signal.direction;  // 'BUY' or 'SELL' — full signal
    } else if (aiResp.decision === 'CONDITIONAL' || signal.confidence_tier === 'SILVER') {
      sigType = 'READY';           // Alert only — confirm before entering
    } else {
      sigType = 'WAIT';
    }

    signal.signal_type = sigType;

    // Save FIRST — now signal gets a real DB id
    const saved = await db.saveSignal(signal);

    // FIX BUG-01: Patch the AI decision log with the real signal id now we have it
    if (saved?.id) {
      await db.patchAIDecisionSignalId(saved.id, symbol).catch(() => {}); // best-effort
    }

    // REJECT → stop here after saving for learning records
    if (sigType === 'NO_TRADE') {
      console.log(`[Pipeline] ${symbol}: AI rejected — ${aiResp.reasoning?.slice(0,60)}`);
      return;
    }

    // Send notifications using saved object (has real id)
    if (['BUY','SELL'].includes(sigType)) {
      await notifier.sendSignal(saved, aiResp);
    } else if (sigType === 'READY') {
      await notifier.sendReadyAlert(saved);
    }
  }

  // ─── ROUTES ───────────────────────────────────────────────────────────────

  app.get('/health', (req, res) => res.json({
    status:  'ONLINE',
    time:    new Date(),
    version: '1.0.0',
    mode:    process.env.PAPER_TRADE === 'false' ? 'LIVE' : 'PAPER',
    ai:      ai.mockMode ? 'MOCK' : 'LIVE',
    telegram: telegram.active ? 'CONNECTED' : 'NOT_CONFIGURED',
  }));

  app.get('/api/pairs', async (req, res) => {
    try { res.json({ success: true, pairs: await db.getAllPairs() }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/pairs/:symbol/toggle', async (req, res) => {
    try {
      const { symbol } = req.params;
      const { active } = req.body;
      await db.updatePairStatus(symbol, active);
      console.log(`[API] ${symbol} → ${active ? 'ACTIVE' : 'INACTIVE'}`);
      res.json({ success: true, symbol, active });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/signals/active', async (req, res) => {
    try { res.json({ success: true, signals: await db.getActiveSignals() }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/signals/history', async (req, res) => {
    try {
      const { symbol, limit = 50, offset = 0 } = req.query;
      res.json({ success: true, signals: await db.getSignalHistory({ symbol, limit: +limit, offset: +offset }) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/performance', async (req, res) => {
    try {
      const { symbol, days = 30 } = req.query;
      res.json({ success: true, stats: await db.getPerformanceStats({ symbol, days: +days }) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/news', async (req, res) => {
    try { res.json({ success: true, events: await news.getUpcoming() }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/config', async (req, res) => {
    try { res.json({ success: true, config: await db.getConfig() }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.put('/api/config/:key', async (req, res) => {
    try {
      const { key } = req.params;
      await db.setConfig(key, req.body.value);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/ai/stats', (req, res) => res.json({ success: true, stats: ai.getDriftStats() }));

  app.post('/api/backtest/:symbol', async (req, res) => {
    const { symbol } = req.params;
    const yearsBack = Math.max(1, Math.min(parseInt(req.body?.yearsBack || req.query?.yearsBack || '2', 10) || 2, 10));
    const mode = String(req.body?.mode || req.query?.mode || 'baseline').toLowerCase();
    const policyName = String(req.body?.policy || req.query?.policy || 'none').toLowerCase();
    const jobId = `${symbol}-${Date.now()}`;

    backtestJobs.set(jobId, {
      id: jobId,
      symbol,
      yearsBack,
      mode,
      policy: policyName,
      status: 'queued',
      progress: 0,
      progressMsg: 'Queued',
      startedAt: new Date().toISOString(),
      report: null,
      error: null,
    });

    res.json({ success: true, jobId, symbol, yearsBack, mode, policy: policyName });

    setImmediate(async () => {
      const job = backtestJobs.get(jobId);
      if (!job) return;

      try {
        job.status = 'running';
        job.progress = 5;
        job.progressMsg = 'Preparing backtest';

        const overlayAi = mode === 'ai' ? ai : null;
        const backtester = new Backtester({
          dataService: data,
          aiAnalyst: overlayAi,
          pairPolicy: getPairPolicy(policyName),
        });
        const report = await backtester.runBacktest(symbol, yearsBack, (progress, msg) => {
          job.progress = progress;
          job.progressMsg = msg;
        });

        job.status = 'completed';
        job.progress = 100;
        job.progressMsg = 'Backtest complete';
        job.report = report;
      } catch (err) {
        job.status = 'failed';
        job.error = err.message;
        job.progressMsg = 'Backtest failed';
      }
    });
  });

  app.get('/api/backtest/jobs/:jobId', async (req, res) => {
    const job = backtestJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    res.json({ success: true, job });
  });

  // TradingView webhook
  app.post('/webhook/tradingview', async (req, res) => {
    const secret = req.headers['x-webhook-secret'] || req.body?.secret;
    const expectedSecret = process.env.WEBHOOK_SECRET;

    // NEW-03 FIX: Block if secret not configured OR if mismatch
    // Prevents unauthenticated access when env var not set
    if (!expectedSecret || !secret || secret !== expectedSecret) {
      console.warn('[Webhook] Unauthorized attempt from', req.ip);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { symbol } = req.body;
    res.json({ received: true });
    if (symbol) processPipeline(symbol).catch(console.error);
  });

  // Manual scan
  app.post('/api/scan/:symbol', async (req, res) => {
    const { symbol } = req.params;
    try {
      const r = await brain1.scan(symbol);
      res.json({ success: true, scan: r });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ─── CRON JOBS ────────────────────────────────────────────────────────────

  // Brain 1: every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    const pairs = await db.getActivePairs();
    console.log(`\n[Cron] Brain1 scan — ${pairs.length} pairs`);
    for (const p of pairs) {
      await processPipeline(p.symbol).catch(console.error);
    }
  });

  // Brain 2: every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await brain2.monitorAll().catch(console.error);
  });

  // News refresh: every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    await news.refresh().catch(console.error);
  });

  // Expire old signals: every hour
  cron.schedule('0 * * * *', async () => {
    await db.expireOldSignals().catch(console.error);
  });

  // Daily summary: 21:00 UTC Mon-Fri
  cron.schedule('0 21 * * 1-5', async () => {
    const stats = await db.getDailySummary();
    await notifier.sendDailySummary(stats).catch(console.error);
  });

  // Weekly learning review: every Sunday 22:00 UTC
  cron.schedule('0 22 * * 0', async () => {
    console.log('[Cron] Weekly learning review starting...');
    await learning.runWeeklyReview().catch(console.error);
  });

  // Manual learning review trigger (for testing)
  app.post('/api/learning/review', async (req, res) => {
    try {
      res.json({ success: true, message: 'Learning review triggered — check logs' });
      await learning.runWeeklyReview();
    } catch (e) { console.error('[Learning]', e.message); }
  });

  // Get latest learning insights
  app.get('/api/learning/insights', async (req, res) => {
    try {
      const config  = await db.getConfig();
      const insights = config.latest_learning_insights;
      res.json({ success: true, insights: insights || null });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ─── LISTEN ───────────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`✅ APEX Server running on port ${PORT}`);
    console.log('');
    console.log(`   Database   : ${process.env.DATABASE_URL ? '✅ PostgreSQL' : '⚠️  Memory (set DATABASE_URL)'}`);
    console.log(`   AI         : ${process.env.ANTHROPIC_API_KEY ? '✅ Claude API' : '⚠️  Mock mode (set ANTHROPIC_API_KEY)'}`);
    console.log(`   Telegram   : ${telegram.active ? '✅ Connected' : '⚠️  Not configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)'}`);
    console.log(`   Market Data: ${process.env.TAAPI_API_KEY || process.env.TWELVE_DATA_API_KEY || process.env.POLYGON_API_KEY ? `✅ Live (${process.env.MARKET_DATA_PROVIDER || 'auto'})` : '⚠️  Mock data (set TAAPI_API_KEY, TWELVE_DATA_API_KEY, or POLYGON_API_KEY)'}`);
    console.log(`   Mode       : ${process.env.PAPER_TRADE === 'false' ? '🔴 LIVE' : '📋 PAPER'}`);
    console.log('');
    console.log('   Crons: Brain1 15min | Brain2 5min | News 30min');
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log(' All systems ready. Watching markets...');
    console.log('═══════════════════════════════════════\n');
  });
}

process.on('SIGTERM', () => process.exit(0));
process.on('unhandledRejection', err => console.error('[Fatal]', err));
boot().catch(err => { console.error('[Boot failed]', err); process.exit(1); });
