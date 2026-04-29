// ═══════════════════════════════════════════════════════════════════════════
// APEX SIGNAL SYSTEM — MAIN SERVER v1.0
// ═══════════════════════════════════════════════════════════════════════════

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });
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

const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDist));

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
    chatId:   process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_GROUP_ID,
  });
  await telegram.validate();
  const whatsapp = new WhatsAppNotifier({
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken:  process.env.TWILIO_AUTH_TOKEN,
    from:       process.env.TWILIO_WHATSAPP_FROM,
    to:         process.env.WHATSAPP_TO,
  });
  const notifier = new Notifier({ telegram, whatsapp, db, dataService: data });

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
  const livePolicyName = process.env.LIVE_POLICY || process.env.RESEARCH_POLICY || 'target_growth_v6';
  const livePolicy = getPairPolicy(livePolicyName);
  const livePairs = (process.env.LIVE_PAIRS || 'EURUSD,USDCHF,GBPJPY,EURJPY,XAUUSD')
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
  const scanQueueEnabled = String(process.env.SCAN_QUEUE_ENABLED || 'true').toLowerCase() !== 'false';
  const scanCadenceMs = Math.max(5000, Number(process.env.SCAN_CADENCE_MS || 15000));
  const scanBudgetPerMinute = Math.max(1, Number(process.env.SCAN_BUDGET_PER_MINUTE || 8));
  const scanCostPerPair = Math.max(1, Number(process.env.SCAN_COST_PER_PAIR || 2));
  const scanErrorBackoffMs = Math.max(scanCadenceMs, Number(process.env.SCAN_ERROR_BACKOFF_MS || 30000));
  const scanIdleMs = Math.max(5000, Number(process.env.SCAN_IDLE_MS || scanCadenceMs));
  const scanState = {
    enabled: scanQueueEnabled,
    running: false,
    timer: null,
    queue: [],
    cursor: 0,
    currentSymbol: null,
    lastSymbol: null,
    lastOutcome: null,
    lastError: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastDurationMs: null,
    nextDueAt: null,
    cycleCount: 0,
    minuteWindowStartedAt: Date.now(),
    minuteBudgetUsed: 0,
  };

  async function syncLivePairs() {
    if (String(process.env.SYNC_LIVE_PAIRS || 'true').toLowerCase() === 'false') return;
    const pairs = await db.getAllPairs();
    const known = new Set(pairs.map((p) => p.symbol));
    for (const pair of pairs) {
      const shouldBeActive = livePairs.includes(pair.symbol);
      if (known.has(pair.symbol) && pair.active !== shouldBeActive) {
        await db.updatePairStatus(pair.symbol, shouldBeActive).catch(() => {});
      }
    }
  }

  function policyDecision(signal) {
    const policy = livePolicy[signal.symbol];
    if (!policy) return { allowed: true };

    if (policy.disabled) return { allowed: false, reason: `${signal.symbol} disabled by ${livePolicyName}` };
    if (policy.sessions && !policy.sessions.includes(signal.session)) return { allowed: false, reason: `${signal.symbol} session ${signal.session} blocked` };
    if (Array.isArray(policy.blockedRegimes) && policy.blockedRegimes.includes(signal.regime)) return { allowed: false, reason: `${signal.symbol} regime ${signal.regime} blocked` };
    if (Array.isArray(policy.allowedEntryTypes) && policy.allowedEntryTypes.length && !policy.allowedEntryTypes.includes(signal.entry_type)) return { allowed: false, reason: `${signal.symbol} entry ${signal.entry_type} blocked` };
    if (Array.isArray(policy.blockedDirections) && policy.blockedDirections.includes(signal.direction)) return { allowed: false, reason: `${signal.symbol} direction ${signal.direction} blocked` };
    if (Array.isArray(policy.blockedHoursUTC) && policy.blockedHoursUTC.includes(new Date().getUTCHours())) return { allowed: false, reason: `${signal.symbol} UTC hour blocked` };
    if (policy.blockedLevelRegimes && Array.isArray(policy.blockedLevelRegimes[signal.level_type]) && policy.blockedLevelRegimes[signal.level_type].includes(signal.regime)) {
      return { allowed: false, reason: `${signal.symbol} ${signal.level_type}/${signal.regime} blocked` };
    }
    return { allowed: true };
  }

  function timeStatus() {
    const now = new Date();
    return {
      iso: now.toISOString(),
      utc: now.toLocaleString('en-AU', { timeZone: 'UTC', hour12: false }),
      sydney: now.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour12: false }),
      timezone: 'Australia/Sydney',
    };
  }

  await syncLivePairs();

  function telegramStatus() {
    if (!telegram.active) return 'NOT_CONFIGURED';
    return telegram.authState || 'PENDING';
  }

  function refreshScanBudget(now = Date.now()) {
    if (now - scanState.minuteWindowStartedAt >= 60000) {
      scanState.minuteWindowStartedAt = now;
      scanState.minuteBudgetUsed = 0;
    }
  }

  function snapshotScanState() {
    return {
      enabled: scanState.enabled,
      running: scanState.running,
      currentSymbol: scanState.currentSymbol,
      lastSymbol: scanState.lastSymbol,
      lastOutcome: scanState.lastOutcome,
      lastError: scanState.lastError,
      lastStartedAt: scanState.lastStartedAt,
      lastFinishedAt: scanState.lastFinishedAt,
      lastDurationMs: scanState.lastDurationMs,
      nextDueAt: scanState.nextDueAt,
      cycleCount: scanState.cycleCount,
      queue: [...scanState.queue],
      queueLength: scanState.queue.length,
      cursor: scanState.cursor,
      cadenceMs: scanCadenceMs,
      idleMs: scanIdleMs,
      budgetPerMinute: scanBudgetPerMinute,
      costPerPair: scanCostPerPair,
      minuteBudgetUsed: scanState.minuteBudgetUsed,
      minuteWindowStartedAt: new Date(scanState.minuteWindowStartedAt).toISOString(),
    };
  }

  function scheduleScanTick(delayMs) {
    if (!scanState.enabled) return;
    if (scanState.timer) clearTimeout(scanState.timer);
    const waitMs = Math.max(1000, Number(delayMs) || scanCadenceMs);
    scanState.nextDueAt = new Date(Date.now() + waitMs).toISOString();
    scanState.timer = setTimeout(() => {
      scanState.timer = null;
      runScanLoop().catch((err) => console.error('[ScanQueue]', err));
    }, waitMs);
  }

  async function runScanLoop() {
    if (!scanState.enabled || scanState.running) return;
    scanState.running = true;
    let nextDelay = scanCadenceMs;

    try {
      const pairs = await db.getActivePairs();
      const symbols = pairs
        .filter((pair) => pair.active)
        .map((pair) => String(pair.symbol || '').toUpperCase())
        .filter(Boolean);

      scanState.queue = symbols;

      if (!symbols.length) {
        scanState.currentSymbol = null;
        scanState.lastOutcome = 'IDLE_NO_PAIRS';
        nextDelay = scanIdleMs;
        return;
      }

      if (scanState.cursor >= symbols.length) scanState.cursor = 0;

      const now = Date.now();
      refreshScanBudget(now);

      if (scanState.minuteBudgetUsed + scanCostPerPair > scanBudgetPerMinute) {
        const waitForBudgetMs = Math.max(1000, 60000 - (now - scanState.minuteWindowStartedAt) + 250);
        scanState.currentSymbol = null;
        scanState.lastOutcome = 'WAITING_API_BUDGET';
        nextDelay = waitForBudgetMs;
        console.log(`[ScanQueue] Holding for API budget (${scanState.minuteBudgetUsed}/${scanBudgetPerMinute} used). Next tick in ${Math.ceil(waitForBudgetMs / 1000)}s.`);
        return;
      }

      const symbol = symbols[scanState.cursor];
      scanState.cursor = (scanState.cursor + 1) % symbols.length;
      scanState.currentSymbol = symbol;
      scanState.lastSymbol = symbol;
      scanState.lastStartedAt = new Date().toISOString();
      scanState.minuteBudgetUsed += scanCostPerPair;

      const startedAt = Date.now();
      const result = await processPipeline(symbol);
      scanState.lastFinishedAt = new Date().toISOString();
      scanState.lastDurationMs = Date.now() - startedAt;
      scanState.lastOutcome = result?.stage || result?.reason || 'completed';
      scanState.lastError = null;
      scanState.cycleCount += 1;

      console.log(`[ScanQueue] ${symbol} -> ${scanState.lastOutcome} (${scanState.lastDurationMs}ms, budget ${scanState.minuteBudgetUsed}/${scanBudgetPerMinute})`);
      nextDelay = scanCadenceMs;
    } catch (err) {
      scanState.lastFinishedAt = new Date().toISOString();
      scanState.lastDurationMs = scanState.lastStartedAt ? Date.now() - new Date(scanState.lastStartedAt).getTime() : null;
      scanState.lastOutcome = 'ERROR';
      scanState.lastError = err.message;
      nextDelay = scanErrorBackoffMs;
      console.error('[ScanQueue] Tick failed:', err.message);
    } finally {
      scanState.running = false;
      scanState.currentSymbol = null;
      scheduleScanTick(nextDelay);
    }
  }

  function parseStoredValue(value) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed.length) return '';
    try { return JSON.parse(trimmed); } catch { return trimmed; }
  }

  async function getParsedConfig() {
    const raw = await db.getConfig();
    return Object.fromEntries(
      Object.entries(raw || {}).map(([key, value]) => [key, parseStoredValue(value)])
    );
  }

  function getRiskDistance(signal) {
    const entry = Number(signal.entry_price);
    const tp1 = Number(signal.tp1);
    const stop = Number(signal.stop_loss);
    const fromTp1 = Number.isFinite(entry) && Number.isFinite(tp1) ? Math.abs(tp1 - entry) / 2 : 0;
    const fromStop = Number.isFinite(entry) && Number.isFinite(stop) ? Math.abs(entry - stop) : 0;
    return fromTp1 > 0 ? fromTp1 : fromStop;
  }

  function getQuote(symbol = '') {
    return symbol.length === 6 ? symbol.slice(3) : 'USD';
  }

  async function getCandleSnapshot(symbol, interval = '15m', size = 80) {
    const candles = await data.getCandles(symbol, interval, size);
    const close = candles?.closes?.[candles.closes.length - 1];
    return {
      symbol,
      interval,
      source: `${interval}_close`,
      price: Number.isFinite(close) ? close : null,
      candles,
    };
  }

  async function getUsdConversionMap(symbols = []) {
    const quotes = [...new Set(symbols.map(getQuote).filter((quote) => quote && quote !== 'USD'))];
    const pairs = quotes.map((quote) => `USD${quote}`);
    const rows = await Promise.all(pairs.map(async (pair) => {
      try {
        const snapshot = await getCandleSnapshot(pair, '15m', 2);
        return [pair, Number(snapshot.price) || null];
      } catch {
        return [pair, null];
      }
    }));
    return Object.fromEntries(rows);
  }

  function usdPerQuoteUnit(symbol, conversionMap) {
    const quote = getQuote(symbol);
    if (quote === 'USD') return 1;
    const rate = Number(conversionMap[`USD${quote}`]);
    if (Number.isFinite(rate) && rate > 0) return 1 / rate;
    return null;
  }

  function calculateLots(signal, accountBalance, conversionMap) {
    const balance = Number(accountBalance);
    const riskPct = Number(signal.risk_pct || 0);
    const riskDistance = getRiskDistance(signal);
    if (!Number.isFinite(balance) || balance <= 0 || !Number.isFinite(riskPct) || riskPct <= 0 || !Number.isFinite(riskDistance) || riskDistance <= 0) {
      return null;
    }

    const riskAmount = balance * (riskPct / 100);
    const symbol = signal.symbol || '';
    let lossPerLotUsd = null;

    if (symbol === 'XAUUSD') {
      lossPerLotUsd = riskDistance * 100;
    } else if (symbol.length === 6) {
      const usdQuote = usdPerQuoteUnit(symbol, conversionMap);
      if (!Number.isFinite(usdQuote) || usdQuote <= 0) return null;
      lossPerLotUsd = riskDistance * 100000 * usdQuote;
    }

    if (!Number.isFinite(lossPerLotUsd) || lossPerLotUsd <= 0) return null;
    const lots = riskAmount / lossPerLotUsd;
    return Number.isFinite(lots) ? Number(lots.toFixed(2)) : null;
  }

  function calculateCurrentR(signal, currentPrice) {
    const price = Number(currentPrice);
    const entry = Number(signal.entry_price);
    const riskDistance = getRiskDistance(signal);
    if (!Number.isFinite(price) || !Number.isFinite(entry) || !Number.isFinite(riskDistance) || riskDistance <= 0) return null;
    const dir = signal.direction === 'BUY' ? 1 : -1;
    return Number((((price - entry) * dir) / riskDistance).toFixed(2));
  }

  async function buildDashboard(days = 120, historyLimit = 220) {
    const [pairs, activeSignals, history, performance, dailySummary, config] = await Promise.all([
      db.getAllPairs(),
      db.getActiveSignals(),
      db.getSignalHistory({ limit: historyLimit, offset: 0 }),
      db.getPerformanceStats({ days }),
      db.getDailySummary(),
      getParsedConfig(),
    ]);

    const baseBalance = Number(config.demo_account_size || process.env.DEMO_ACCOUNT_SIZE || 50000);
    const scanIntervalMins = scanQueueEnabled
      ? Number((scanCadenceMs / 60000).toFixed(2))
      : Number(config.scan_interval_mins || 15);
    const guardianIntervalMins = Number(config.guardian_interval_mins || 5);
    const trackedSymbols = [...new Set([...livePairs, ...activeSignals.map((signal) => signal.symbol)].filter(Boolean))];
    const trackedPrices = await Promise.all(trackedSymbols.map((symbol) => getCandleSnapshot(symbol, '15m', 2).catch(() => ({ symbol, price: null, source: 'unavailable' }))));
    const priceMap = Object.fromEntries(trackedPrices.map((row) => [row.symbol, { symbol: row.symbol, price: row.price, source: row.source }]));
    const conversionMap = await getUsdConversionMap([...trackedSymbols, ...livePairs]);

    const executedClosed = history
      .filter((signal) => signal.outcome && ['WIN', 'LOSS', 'BREAKEVEN'].includes(signal.outcome))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const openTrades = [...activeSignals].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    let realizedBalance = baseBalance;
    let wins = 0;
    let losses = 0;
    let breakevens = 0;
    let netR = 0;
    let grossWinsR = 0;
    let grossLossesR = 0;

    const closedLedger = executedClosed.map((signal) => {
      const startBalance = realizedBalance;
      const riskPct = Number(signal.risk_pct || 0);
      const riskAmount = startBalance * (riskPct / 100);
      const pnlR = Number(signal.pnl_r || 0);
      const pnlAmount = Number((riskAmount * pnlR).toFixed(2));
      realizedBalance = Number((realizedBalance + pnlAmount).toFixed(2));
      if (signal.outcome === 'WIN') wins++;
      if (signal.outcome === 'LOSS') losses++;
      if (signal.outcome === 'BREAKEVEN') breakevens++;
      netR += pnlR;
      if (pnlR > 0) grossWinsR += pnlR;
      if (pnlR < 0) grossLossesR += Math.abs(pnlR);

      return {
        ...signal,
        state: 'CLOSED',
        start_balance: Number(startBalance.toFixed(2)),
        end_balance: Number(realizedBalance.toFixed(2)),
        risk_amount: Number(riskAmount.toFixed(2)),
        pnl_amount: pnlAmount,
        pnl_percent: Number(((pnlAmount / startBalance) * 100).toFixed(2)),
        lots: calculateLots(signal, startBalance, conversionMap),
      };
    });

    const activeLedger = openTrades.map((signal) => {
      const entryBalance = realizedBalance;
      const riskPct = Number(signal.risk_pct || 0);
      const riskAmount = entryBalance * (riskPct / 100);
      const currentPrice = priceMap[signal.symbol]?.price ?? null;
      const currentR = calculateCurrentR(signal, currentPrice);
      const floatingAmount = Number.isFinite(currentR) ? Number((riskAmount * currentR).toFixed(2)) : null;

      return {
        ...signal,
        state: 'OPEN',
        current_price: currentPrice,
        price_source: priceMap[signal.symbol]?.source || 'unavailable',
        current_r: currentR,
        floating_amount: floatingAmount,
        floating_percent: Number.isFinite(floatingAmount) ? Number(((floatingAmount / entryBalance) * 100).toFixed(2)) : null,
        risk_amount: Number(riskAmount.toFixed(2)),
        entry_balance: Number(entryBalance.toFixed(2)),
        lots: calculateLots(signal, entryBalance, conversionMap),
      };
    });

    const floatingPnL = activeLedger.reduce((sum, signal) => sum + (Number(signal.floating_amount) || 0), 0);
    const floatingWinners = activeLedger.filter((signal) => Number(signal.current_r) > 0).length;
    const floatingLosers = activeLedger.filter((signal) => Number(signal.current_r) < 0).length;
    const closedTrades = closedLedger.length;
    const decisiveTrades = wins + losses;
    const winRate = decisiveTrades > 0 ? Number(((wins / decisiveTrades) * 100).toFixed(1)) : 0;
    const totalBalance = Number((realizedBalance + floatingPnL).toFixed(2));
    const growthPct = Number((((totalBalance - baseBalance) / baseBalance) * 100).toFixed(2));
    const realizedGrowthPct = Number((((realizedBalance - baseBalance) / baseBalance) * 100).toFixed(2));
    const avgR = closedTrades > 0 ? Number((netR / closedTrades).toFixed(2)) : 0;
    const profitFactor = grossLossesR > 0 ? Number((grossWinsR / grossLossesR).toFixed(2)) : null;
    const equityCurve = [
      { at: null, label: 'Start', balance: Number(baseBalance.toFixed(2)), delta: 0, symbol: null },
      ...closedLedger.map((signal) => ({
        at: signal.closed_at || signal.created_at,
        label: signal.symbol,
        balance: signal.end_balance,
        delta: signal.pnl_amount,
        symbol: signal.symbol,
        outcome: signal.outcome,
      })),
      { at: new Date().toISOString(), label: 'Live', balance: totalBalance, delta: Number(floatingPnL.toFixed(2)), symbol: 'LIVE', outcome: floatingPnL >= 0 ? 'WIN' : 'LOSS' },
    ];

    return {
      baseBalance: Number(baseBalance.toFixed(2)),
      realizedBalance: Number(realizedBalance.toFixed(2)),
      totalBalance,
      realizedGrowthPct,
      growthPct,
      floatingPnL: Number(floatingPnL.toFixed(2)),
      floatingWinners,
      floatingLosers,
      scanIntervalMins,
      guardianIntervalMins,
      summary: {
        tradesTaken: closedTrades + activeLedger.length,
        closedTrades,
        openTrades: activeLedger.length,
        wins,
        losses,
        breakevens,
        winRate,
        netR: Number(netR.toFixed(2)),
        avgR,
        profitFactor,
        dayR: Number(dailySummary.day_pnl_r || 0),
        totalR: Number(dailySummary.total_r || 0),
      },
      activeSignals: activeLedger.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
      recentClosed: [...closedLedger].sort((a, b) => new Date(b.closed_at || b.created_at) - new Date(a.closed_at || a.created_at)).slice(0, 20),
      performance,
      equityCurve,
      priceMap,
      scanQueue: snapshotScanState(),
      config,
      pairs,
    };
  }

  // ─── SIGNAL PIPELINE ──────────────────────────────────────────────────────
  async function executionGate(signal, sigType) {
    if (!['BUY', 'SELL'].includes(sigType)) return { allowed: true };

    const config = await getParsedConfig();
    const maxOpenTrades = Number(config.max_open_trades || process.env.MAX_OPEN_TRADES || 5);
    const maxEntriesPerPair = Number(config.max_entries_per_pair || process.env.MAX_ENTRIES_PER_PAIR || 1);
    const maxPortfolioRiskPct = Number(config.max_portfolio_risk_pct || process.env.MAX_PORTFOLIO_RISK_PCT || 5);
    const activeSignals = await db.getActiveSignals();
    const liveTrades = activeSignals.filter((row) => ['BUY', 'SELL'].includes(row.signal_type));
    const activeForPair = liveTrades.filter((row) => row.symbol === signal.symbol);
    const openRiskPct = liveTrades.reduce((sum, row) => sum + Number(row.risk_pct || 0), 0);
    const nextRiskPct = Number(signal.risk_pct || 0);

    if (liveTrades.length >= maxOpenTrades) {
      return { allowed: false, reason: `Max open trades ${maxOpenTrades} reached` };
    }
    if (activeForPair.length >= maxEntriesPerPair) {
      return { allowed: false, reason: `${signal.symbol} already has ${activeForPair.length} open trade(s)` };
    }
    if (openRiskPct + nextRiskPct > maxPortfolioRiskPct) {
      return { allowed: false, reason: `Portfolio risk ${openRiskPct.toFixed(2)}% + ${nextRiskPct.toFixed(2)}% exceeds ${maxPortfolioRiskPct}%` };
    }
    return { allowed: true };
  }

  async function processPipeline(symbol) {
    const scan = await brain1.scan(symbol);
    if (!scan.signal) return { sent: false, symbol, stage: 'brain1', reason: scan.reason || 'No signal' };

    const { signal } = scan;
    signal.detected_at = new Date().toISOString();
    signal.live_policy = livePolicyName;

    const liveGate = policyDecision(signal);
    if (!liveGate.allowed) {
      signal.signal_type = 'NO_TRADE';
      signal.ai_decision = 'REJECT';
      signal.ai_conviction = 0;
      signal.ai_reasoning = `Live policy ${livePolicyName}: ${liveGate.reason}`;
      signal.ai_risk_flags = ['LIVE_POLICY_FILTER'];
      await db.saveSignal(signal).catch(() => {});
      console.log(`[Pipeline] ${symbol}: live policy skipped - ${liveGate.reason}`);
      return { sent: false, symbol, stage: 'policy', reason: liveGate.reason, signal };
    }

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

    const gate = await executionGate(signal, sigType);
    if (!gate.allowed) {
      signal.signal_type = 'NO_TRADE';
      signal.ai_decision = 'REJECT';
      signal.ai_reasoning = `${signal.ai_reasoning || 'Execution blocked.'} Execution gate: ${gate.reason}`;
      signal.ai_risk_flags = [...new Set([...(signal.ai_risk_flags || []), 'EXECUTION_GATE'])];
      const savedBlocked = await db.saveSignal(signal);
      console.log(`[Pipeline] ${symbol}: execution gate blocked - ${gate.reason}`);
      return { sent: false, symbol, stage: 'execution-gate', reason: gate.reason, signal: savedBlocked, ai: aiResp };
    }

    // Save FIRST — now signal gets a real DB id
    const saved = await db.saveSignal(signal);

    // FIX BUG-01: Patch the AI decision log with the real signal id now we have it
    if (saved?.id) {
      await db.patchAIDecisionSignalId(saved.id, symbol).catch(() => {}); // best-effort
    }

    // REJECT → stop here after saving for learning records
    if (sigType === 'NO_TRADE') {
      console.log(`[Pipeline] ${symbol}: AI rejected — ${aiResp.reasoning?.slice(0,60)}`);
      return { sent: false, symbol, stage: 'ai', reason: aiResp.reasoning, signal: saved, ai: aiResp };
    }

    // Send notifications using saved object (has real id)
    if (['BUY','SELL'].includes(sigType)) {
      const notify = await notifier.sendSignal(saved, aiResp);
      return { sent: notify.sent, symbol, stage: 'signal', type: sigType, signal: saved, ai: aiResp, notify };
    } else if (sigType === 'READY') {
      const notify = await notifier.sendReadyAlert(saved);
      return { sent: notify.sent, symbol, stage: 'ready', type: sigType, signal: saved, ai: aiResp, notify };
    }

    return { sent: false, symbol, stage: 'wait', type: sigType, signal: saved, ai: aiResp };
  }

  // ─── ROUTES ───────────────────────────────────────────────────────────────

  app.get('/health', (req, res) => res.json({
    status:  'ONLINE',
    time:    timeStatus(),
    version: '3.0.0-demo',
    mode:    process.env.PAPER_TRADE === 'false' ? 'LIVE' : 'PAPER',
    ai:      ai.mockMode ? 'MOCK' : 'LIVE',
    telegram: telegramStatus(),
    marketData: process.env.MARKET_DATA_PROVIDER || 'auto',
    livePolicy: livePolicyName,
    livePairs,
    scanQueue: snapshotScanState(),
    uptimeSec: Math.round(process.uptime()),
  }));

  app.get('/api/status', async (req, res) => {
    try {
      const pairs = await db.getAllPairs();
      res.json({
        success: true,
        status: 'ONLINE',
        time: timeStatus(),
        mode: process.env.PAPER_TRADE === 'false' ? 'LIVE' : 'PAPER',
        ai: ai.mockMode ? 'MOCK' : 'LIVE',
        telegram: telegramStatus(),
        telegramError: telegram.authError,
        marketDataProvider: process.env.MARKET_DATA_PROVIDER || 'auto',
        livePolicy: livePolicyName,
        livePairs,
        activePairs: pairs.filter((p) => p.active).map((p) => p.symbol),
        scanQueue: snapshotScanState(),
        uptimeSec: Math.round(process.uptime()),
      });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/dashboard', async (req, res) => {
    try {
      const days = Math.max(30, Math.min(parseInt(req.query.days || '120', 10) || 120, 3650));
      const historyLimit = Math.max(50, Math.min(parseInt(req.query.limit || '220', 10) || 220, 500));
      const dashboard = await buildDashboard(days, historyLimit);
      res.json({
        success: true,
        time: timeStatus(),
        status: {
          mode: process.env.PAPER_TRADE === 'false' ? 'LIVE' : 'PAPER',
          ai: ai.mockMode ? 'MOCK' : 'LIVE',
          telegram: telegramStatus(),
          telegramError: telegram.authError,
          marketDataProvider: process.env.MARKET_DATA_PROVIDER || 'auto',
          livePolicy: livePolicyName,
          livePairs,
          scanQueue: snapshotScanState(),
        },
        dashboard,
      });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/market/:symbol', async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const price = await data.getCurrentPrice(symbol);
      const h4 = await data.getCandles(symbol, '4h', 80);
      res.json({
        success: true,
        symbol,
        price,
        live: price.source !== 'mock',
        provider: price.source,
        time: timeStatus(),
        context: {
          ema21: h4.ema21,
          ema50: h4.ema50,
          rsi: h4.rsi,
          atr: h4.atr,
          adx: h4.adx,
        },
      });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/chart/:symbol', async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const interval = String(req.query.interval || '15m');
      const size = Math.max(24, Math.min(parseInt(req.query.size || '72', 10) || 72, 240));
      const chart = await getCandleSnapshot(symbol, interval, size);
      const candles = chart.candles?.candles || [];
      res.json({
        success: true,
        symbol,
        interval,
        source: chart.source,
        time: timeStatus(),
        currentPrice: chart.price,
        ema21: chart.candles?.ema21 ?? null,
        ema50: chart.candles?.ema50 ?? null,
        rsi: chart.candles?.rsi ?? null,
        adx: chart.candles?.adx ?? null,
        atr: chart.candles?.atr ?? null,
        candles,
      });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/telegram/test', async (req, res) => {
    try {
      const symbol = String(req.body?.symbol || req.query?.symbol || 'EURUSD').toUpperCase();
      const price = await data.getCurrentPrice(symbol);
      const now = timeStatus();
      const msg = [
        '<b>APEX DEMO CHECK</b>',
        'System is online and Telegram is connected.',
        '',
        `<b>${symbol}</b> price: ${price.price}`,
        `Data source: ${price.source}`,
        `UTC: ${now.utc}`,
        `Sydney: ${now.sydney}`,
        `Policy: ${livePolicyName}`,
        `Mode: ${process.env.PAPER_TRADE === 'false' ? 'LIVE' : 'PAPER'}`,
      ].join('\n');
      const sent = await telegram.send(msg, 'DEMO_CHECK');
      res.json({ success: sent.sent, sent, symbol, price, time: now });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/pipeline/:symbol', async (req, res) => {
    try {
      const result = await processPipeline(req.params.symbol.toUpperCase());
      res.json({ success: true, result, time: timeStatus() });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

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

  if (scanQueueEnabled) {
    scheduleScanTick(2000);
  } else {
    // Fallback for explicit cron mode.
    cron.schedule('*/15 * * * *', async () => {
      const pairs = await db.getActivePairs();
      console.log(`\n[Cron] Brain1 scan — ${pairs.length} pairs`);
      for (const p of pairs) {
        await processPipeline(p.symbol).catch(console.error);
      }
    });
  }

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
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/webhook') || req.path === '/health') return next();
    res.sendFile(path.join(frontendDist, 'index.html'), (err) => {
      if (err) res.status(404).send('APEX dashboard has not been built yet. Run npm run build in frontend.');
    });
  });

  app.listen(PORT, () => {
    console.log(`✅ APEX Server running on port ${PORT}`);
    console.log('');
    console.log(`   Database   : ${process.env.DATABASE_URL ? '✅ PostgreSQL' : '⚠️  Memory (set DATABASE_URL)'}`);
    console.log(`   AI         : ${process.env.ANTHROPIC_API_KEY ? '✅ Claude API' : '⚠️  Mock mode (set ANTHROPIC_API_KEY)'}`);
    const tgLine =
      telegramStatus() === 'AUTHORIZED'
        ? '✅ Authorized'
        : telegramStatus() === 'AUTH_FAILED'
          ? `❌ Auth failed (${telegram.authError})`
          : '⚠️  Not configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)';
    console.log(`   Telegram   : ${tgLine}`);
    console.log(`   Market Data: ${process.env.TAAPI_API_KEY || process.env.TWELVE_DATA_API_KEY || process.env.POLYGON_API_KEY ? `✅ Live (${process.env.MARKET_DATA_PROVIDER || 'auto'})` : '⚠️  Mock data (set TAAPI_API_KEY, TWELVE_DATA_API_KEY, or POLYGON_API_KEY)'}`);
    console.log(`   Mode       : ${process.env.PAPER_TRADE === 'false' ? '🔴 LIVE' : '📋 PAPER'}`);
    console.log('');
    console.log(`   Scan Loop  : ${scanQueueEnabled ? `Queue ${Math.round(scanCadenceMs / 1000)}s cadence | ${scanCostPerPair}/${scanBudgetPerMinute} budget` : 'Cron 15min burst'}`);
    console.log('   Crons      : Brain2 5min | News 30min');
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log(' All systems ready. Watching markets...');
    console.log('═══════════════════════════════════════\n');
  });
}

process.on('SIGTERM', () => process.exit(0));
process.on('unhandledRejection', err => console.error('[Fatal]', err));
boot().catch(err => { console.error('[Boot failed]', err); process.exit(1); });
