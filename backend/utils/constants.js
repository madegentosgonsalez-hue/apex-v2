// ═══════════════════════════════════════════════════════════════════════════
// APEX SIGNAL SYSTEM — MASTER STRATEGY CONSTANTS
// THE DNA. Change here = changes everywhere.
// Re-audited against original strategy. Every rule verified.
// ═══════════════════════════════════════════════════════════════════════════

// ─── TIMEFRAME ROLES ─────────────────────────────────────────────────────────
// Each timeframe has ONE job. Never mix roles.
const TIMEFRAMES = {
  WEEKLY: { tf: '1W',  role: 'MACRO_BIAS',         required: false, weight: 3 },
  DAILY:  { tf: '1D',  role: 'STRUCTURAL_CONTEXT', required: false, weight: 3 },
  H4:     { tf: '4h',  role: 'SETUP_FORMATION',    required: true,  weight: 3 }, // REQUIRED
  H2:     { tf: '2h',  role: 'BRIDGE_CONFIRM',     required: false, weight: 2 }, // Hidden edge
  H1:     { tf: '1h',  role: 'ENTRY_REFINEMENT',   required: false, weight: 2 },
  M30:    { tf: '30m', role: 'TRIGGER_FORMATION',  required: false, weight: 1 },
  M15:    { tf: '15m', role: 'PRECISE_ENTRY',       required: true,  weight: 1 }, // REQUIRED
};

// ─── ENTRY TYPES ─────────────────────────────────────────────────────────────
const ENTRY_TYPES = {
  TYPE_A: {
    name:          'Liquidity Sweep + MSB + FVG',
    minConfluence: 5,
    priority:      1, // HIGHEST
    description:   'Stop hunt below swing low, market structure breaks up, FVG retest entry',
    requires:      ['liquiditySweep', 'marketStructureBreak', 'fairValueGap'],
  },
  TYPE_B: {
    name:          'Order Block Retest + Momentum',
    minConfluence: 4,
    priority:      2,
    description:   'Price returns to institutional order block with confirmation candle',
    requires:      ['orderBlock', 'momentumCandle'],
  },
  TYPE_C: {
    name:          'Trend Continuation EMA Pullback',
    minConfluence: 4,
    priority:      3,
    description:   'Pullback to EMA21 or EMA50 in established trend, ADX > 25',
    requires:      ['emaPullback', 'trendConfirmed'],
  },
  TYPE_D: {
    name:          'Breakout Retest + Volume',
    minConfluence: 5,
    priority:      2,
    description:   'Clean break of key level, retest with volume expansion',
    requires:      ['levelBreakout', 'retestCandle', 'volumeExpansion'],
  },
};

// ─── CONFLUENCE SCORING ───────────────────────────────────────────────────────
// 6 factors, 1 point each. Maximum 6. All equally weighted.
const CONFLUENCE_FACTORS = {
  HTF_TREND:      { label: 'HTF Trend Aligned',    description: 'Weekly AND Daily both agree with direction' },
  KEY_LEVEL:      { label: 'Price at Key Level',   description: 'OB / FVG / Swing Structure / POC' },
  VOLUME:         { label: 'Volume Confirms',       description: 'Volume above 20-period average on entry candle' },
  RSI_MOMENTUM:   { label: 'RSI Momentum',          description: 'RSI >50 for BUY (not overbought), <50 for SELL (not oversold)' },
  CANDLE_PATTERN: { label: 'Candle Pattern',        description: 'Engulfing / Pin Bar / Hammer / Shooting Star / MSB candle' },
  INTERMARKET:    { label: 'Intermarket Confirms',  description: 'DXY trend / BTC dominance / VIX level aligns' },
};

// ─── CONFIDENCE TIERS ─────────────────────────────────────────────────────────
// Tier is determined by BOTH confluence score AND AI conviction
// AI can only LOWER a tier. Never raise it.
const CONFIDENCE_TIERS = {
  DIAMOND: {
    label:           'DIAMOND',
    emoji:           '💎',
    minConfluence:   6,
    minAIConviction: 88,   // NEW-06 FIX: was 90, but AI is capped at 90 — unreachable. 88 is achievable.
    riskPct:         1.0,
    signalType:      'FULL_SIGNAL',
    tag:             'PRIME SETUP — MAXIMUM SIZE',
  },
  GOLD: {
    label:           'GOLD',
    emoji:           '🥇',
    minConfluence:   5,
    minAIConviction: 75,
    riskPct:         0.75,
    signalType:      'FULL_SIGNAL',
    tag:             'HIGH CONFIDENCE',
  },
  SILVER: {
    label:           'SILVER',
    emoji:           '🥈',
    minConfluence:   4,
    minAIConviction: 65,
    riskPct:         0.5,
    signalType:      'READY_ALERT',  // Ready — not yet full signal
    tag:             'WATCH CLOSELY',
  },
  BRONZE: {
    label:           'BRONZE',
    emoji:           '🥉',
    minConfluence:   3,
    minAIConviction: 0,
    riskPct:         0,
    signalType:      'WAIT',
    tag:             'SETUP FORMING',
  },
  SKIP: {
    label:           'SKIP',
    emoji:           '❌',
    minConfluence:   0,
    minAIConviction: 0,
    riskPct:         0,
    signalType:      'NO_TRADE',
    tag:             'NO SETUP',
  },
};

// ─── MARKET REGIMES ───────────────────────────────────────────────────────────
const REGIMES = {
  TRENDING: {
    label:         'TRENDING',
    adxMin:        25,
    strategy:      'Momentum bias. Favor Type A and D. Trail stops aggressively.',
    signalAllowed: true,
  },
  WEAK_TREND: {
    label:         'WEAK_TREND',
    adxMin:        15,
    adxMax:        25,
    strategy:      'Reduced size. Prefer Type B/C. Quick profits over runners.',
    signalAllowed: true,
  },
  RANGING: {
    label:         'RANGING',
    adxMax:        15,
    strategy:      'Fade extremes only. Tight exits. Type B at range boundaries.',
    signalAllowed: true,
  },
  HIGH_VOLATILITY: {
    label:         'HIGH_VOLATILITY',
    vixMin:        30,
    strategy:      'NO NEW SIGNALS. Manage existing trades only.',
    signalAllowed: false, // HARD BLOCK
  },
  CRISIS: {
    label:         'CRISIS',
    vixMin:        40,
    strategy:      'ALL SYSTEMS PAUSED. Cash is the position.',
    signalAllowed: false, // HARD BLOCK
  },
};

// ─── EXIT STRATEGY ────────────────────────────────────────────────────────────
// The 40/40/20 exit model. Non-negotiable.
const EXIT_STRATEGY = {
  TP1: {
    rrRatio:      2.0,
    closePercent: 40,       // Close 40% at TP1
    slMove:       'BREAKEVEN',
    label:        'TP1 HIT',
  },
  TP2: {
    rrRatio:      3.0,
    closePercent: 40,       // Close another 40%
    slMove:       'MOVE_TO_TP1',
    label:        'TP2 HIT',
  },
  RUNNER: {
    closePercent: 20,       // Let 20% run with ATR trail
    slMove:       'ATR_TRAIL',
    label:        'TRAILING RUNNER',
  },
};

// ─── ATR RULES ────────────────────────────────────────────────────────────────
const ATR = {
  SL_BUFFER:           0.5,  // SL = structure level ± (ATR × 0.5)
  TRAIL_MULTIPLIER:    1.5,  // Trailing stop distance = ATR × 1.5
  FLASH_CRASH_TRIGGER: 3.0,  // Candle range > ATR × 3 = emergency
  CANDLE_CLOSE_RULE:   true, // SL only triggers on candle CLOSE, never on wick
};

// ─── BRAIN 2 INVALIDATION LEVELS ─────────────────────────────────────────────
// Structure analysis, not price watching
const INVALIDATION = {
  LEVEL_1: {
    name:    'NOISE',
    trigger: 'Price within ATR range, no structure break',
    action:  'HOLD',
    alert:   false,
  },
  LEVEL_2: {
    name:    'WARNING',
    trigger: 'H1 structure softened, H4 still intact',
    action:  'MONITOR',
    alert:   true,
    message: '⚠️ MONITOR — H1 structure tested. H4 intact.',
  },
  LEVEL_3: {
    name:    'SOFT_INVALIDATION',
    trigger: 'H4 broke but on low volume (possible liquidity sweep)',
    action:  'MOVE_SL_BREAKEVEN',
    alert:   true,
    message: '🟡 THESIS WEAKENING — Moved SL to breakeven. Watching.',
  },
  LEVEL_4: {
    name:    'HARD_INVALIDATION',
    trigger: 'H4 candle CLOSED beyond structure with volume',
    action:  'ACTIVATE_BRAIN3',
    alert:   true,
    message: '🔴 HARD INVALIDATION — Brain 3 arbitrating exit.',
  },
  EMERGENCY: {
    name:    'EMERGENCY',
    trigger: 'Daily structure broken OR flash crash (candle > ATR×3)',
    action:  'IMMEDIATE_EXIT',
    alert:   true,
    message: '🚨 EMERGENCY EXIT — Structure destroyed.',
  },
};

// ─── NEWS BLACKOUT ────────────────────────────────────────────────────────────
const NEWS = {
  HIGH: {
    blockMinsBefore: 120,
    blockMinsAfter:  60,
    examples: ['NFP', 'FOMC Rate Decision', 'CPI', 'GDP', 'Unemployment Rate'],
  },
  MEDIUM: {
    blockMinsBefore: 30,
    blockMinsAfter:  30,
    examples: ['Retail Sales', 'PMI', 'PPI', 'Trade Balance', 'Consumer Confidence'],
  },
  LOW: {
    blockMinsBefore: 0,
    blockMinsAfter:  0,
    noteInSignal: true,
  },
  ALWAYS_BLOCK: [
    'central bank emergency rate cut',
    'market circuit breaker triggered',
    'flash crash',
    'geopolitical crisis',
  ],
};

// ─── TRADING SESSIONS ─────────────────────────────────────────────────────────
const SESSIONS = {
  FOREX: {
    LONDON:     { startUTC: 8,  endUTC: 16, priority: 1, label: 'LONDON' },
    NEW_YORK:   { startUTC: 13, endUTC: 21, priority: 1, label: 'NEW_YORK' },
    OVERLAP:    { startUTC: 13, endUTC: 16, priority: 0, label: 'OVERLAP' }, // BEST
    ASIAN:      { startUTC: 0,  endUTC: 8,  priority: 3, label: 'ASIAN' },  // Low priority
  },
  CRYPTO:  { allDay: true, lowLiqHours: [22, 6] },   // UTC
  STOCKS:  { startUTC: 14, endUTC: 21, skipMinutes: 30 }, // Skip first 30min
  FUTURES: { followUnderlying: true },
};

// ─── SIGNAL RULES ─────────────────────────────────────────────────────────────
const SIGNAL_RULES = {
  MIN_CONFLUENCE:          4,    // Absolute floor
  MIN_AI_CONVICTION:       65,   // Minimum for APPROVE
  MAX_AI_CONVICTION:       90,   // AI cap (prevents overconfidence)
  MIN_RR:                  2.0,  // Minimum reward:risk ratio
  MAX_DAILY_LOSSES:        3,    // Stop for the day after 3 losses
  MAX_CONCURRENT_PER_TYPE: 3,    // Max open signals per market type
  SIGNAL_VALIDITY_HRS:     4,    // Signal expires if price never reaches entry
  SCAN_INTERVAL_MINS:      15,   // Brain 1 scan frequency
  GUARDIAN_INTERVAL_MINS:  5,    // Brain 2 check frequency
};

// ─── AI LOCK RULES ────────────────────────────────────────────────────────────
// The AI judge sits in a locked courtroom.
// These are the bars of the cage — unbreakable.
const AI_LOCKS = {
  // These trigger INSTANT REJECT before even calling API
  HARD_REJECT_IF: [
    'confluence < 4',
    'htf_trend_not_aligned',
    'news_blackout_active',
    'regime_HIGH_VOLATILITY',
    'regime_CRISIS',
    'h4_not_confirmed',
    'rr_below_2',
    'daily_loss_limit_hit',
    'market_closed',
    'spread_3x_normal',
  ],
  MAX_CONVICTION:          90,   // AI cannot return above this
  MIN_CONVICTION_APPROVE:  65,
  MAX_RISK_FLAGS:          3,
  DRIFT_APPROVE_RATE_HIGH: 0.80, // Alert if approving >80% of signals
  DRIFT_APPROVE_RATE_LOW:  0.40, // Alert if approving <40%
  DRIFT_AVG_CONVICTION_HIGH: 84, // Alert if avg conviction drifts above
  WEEKLY_CONSISTENCY_TEST: true,
};

// ─── ALL 20 PAIRS ─────────────────────────────────────────────────────────────
const PAIRS = {
  // ── FOREX ──
  EURUSD: { market: 'FOREX',   active: true,  tvSymbol: 'FX:EURUSD',          pipSize: 0.0001, session: 'FOREX'   },
  XAUUSD: { market: 'FOREX',   active: true,  tvSymbol: 'TVC:GOLD',           pipSize: 0.01,   session: 'FOREX'   }, // GOLD
  GBPUSD: { market: 'FOREX',   active: false, tvSymbol: 'FX:GBPUSD',          pipSize: 0.0001, session: 'FOREX'   },
  USDJPY: { market: 'FOREX',   active: false, tvSymbol: 'FX:USDJPY',          pipSize: 0.01,   session: 'FOREX'   },
  AUDUSD: { market: 'FOREX',   active: false, tvSymbol: 'FX:AUDUSD',          pipSize: 0.0001, session: 'FOREX'   },
  USDCAD: { market: 'FOREX',   active: false, tvSymbol: 'FX:USDCAD',          pipSize: 0.0001, session: 'FOREX'   },
  GBPJPY: { market: 'FOREX',   active: true,  tvSymbol: 'FX:GBPJPY',          pipSize: 0.01,   session: 'FOREX'   },
  EURJPY: { market: 'FOREX',   active: true,  tvSymbol: 'FX:EURJPY',          pipSize: 0.01,   session: 'FOREX'   },
  NZDUSD: { market: 'FOREX',   active: false, tvSymbol: 'FX:NZDUSD',          pipSize: 0.0001, session: 'FOREX'   },
  USDCHF: { market: 'FOREX',   active: true,  tvSymbol: 'FX:USDCHF',          pipSize: 0.0001, session: 'FOREX'   },
  // ── CRYPTO ──
  BTCUSD: { market: 'CRYPTO',  active: false, tvSymbol: 'BINANCE:BTCUSDT',    pipSize: 1,      session: 'CRYPTO'  },
  ETHUSD: { market: 'CRYPTO',  active: false, tvSymbol: 'BINANCE:ETHUSDT',    pipSize: 0.1,    session: 'CRYPTO'  },
  SOLUSD: { market: 'CRYPTO',  active: false, tvSymbol: 'BINANCE:SOLUSDT',    pipSize: 0.01,   session: 'CRYPTO'  },
  BNBUSD: { market: 'CRYPTO',  active: false, tvSymbol: 'BINANCE:BNBUSDT',    pipSize: 0.1,    session: 'CRYPTO'  },
  XRPUSD: { market: 'CRYPTO',  active: false, tvSymbol: 'BINANCE:XRPUSDT',    pipSize: 0.0001, session: 'CRYPTO'  },
  // ── STOCKS ──
  SPY:    { market: 'STOCKS',  active: false, tvSymbol: 'AMEX:SPY',           pipSize: 0.01,   session: 'STOCKS'  },
  NVDA:   { market: 'STOCKS',  active: false, tvSymbol: 'NASDAQ:NVDA',        pipSize: 0.01,   session: 'STOCKS'  },
  AAPL:   { market: 'STOCKS',  active: false, tvSymbol: 'NASDAQ:AAPL',        pipSize: 0.01,   session: 'STOCKS'  },
  // ── FUTURES ──
  ES1:    { market: 'FUTURES', active: false, tvSymbol: 'CME_MINI:ES1!',      pipSize: 0.25,   session: 'FUTURES' },
  GC1:    { market: 'FUTURES', active: false, tvSymbol: 'COMEX:GC1!',         pipSize: 0.1,    session: 'FUTURES' },
};

// ─── PERFORMANCE THRESHOLDS ───────────────────────────────────────────────────
const PERFORMANCE = {
  MIN_WIN_RATE:        0.50, // Warn if pair drops below 50%
  MIN_EXPECTANCY:      0.30, // Minimum R expectancy per trade
  MIN_SAMPLE_SIZE:     20,   // Stats unreliable below 20 trades
  REVIEW_INTERVAL_DAYS: 7,
  AUTO_WARN_WIN_RATE:  0.40, // Warn if 40% over 50 trades
};

module.exports = {
  TIMEFRAMES, ENTRY_TYPES, CONFLUENCE_FACTORS, CONFIDENCE_TIERS,
  REGIMES, EXIT_STRATEGY, ATR, INVALIDATION, NEWS,
  SESSIONS, SIGNAL_RULES, AI_LOCKS, PAIRS, PERFORMANCE,
};
