-- ═══════════════════════════════════════════════════════════════════════════
-- APEX SIGNAL SYSTEM — COMPLETE DATABASE SCHEMA
-- PostgreSQL / Supabase compatible
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── PAIRS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pairs (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  symbol       VARCHAR(20) UNIQUE NOT NULL,
  market       VARCHAR(20) NOT NULL CHECK (market IN ('FOREX','CRYPTO','STOCKS','FUTURES')),
  tv_symbol    VARCHAR(50) NOT NULL,
  pip_size     DECIMAL(10,6) NOT NULL,
  session_type VARCHAR(20) NOT NULL,
  active       BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── SIGNALS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  symbol               VARCHAR(20) NOT NULL,
  signal_type          VARCHAR(20) NOT NULL CHECK (signal_type IN ('BUY','SELL','READY','WAIT','NO_TRADE')),
  entry_type           VARCHAR(10) CHECK (entry_type IN ('TYPE_A','TYPE_B','TYPE_C','TYPE_D')),
  direction            VARCHAR(4)  CHECK (direction IN ('BUY','SELL')),
  entry_price          DECIMAL(20,8),
  stop_loss            DECIMAL(20,8),
  tp1                  DECIMAL(20,8),
  tp2                  DECIMAL(20,8),
  atr_value            DECIMAL(20,8),
  rr_ratio             DECIMAL(6,2),
  confluence_score     INTEGER CHECK (confluence_score BETWEEN 0 AND 6),
  htf_trend_aligned    BOOLEAN,
  key_level_present    BOOLEAN,
  volume_confirmed     BOOLEAN,
  rsi_momentum_aligned BOOLEAN,
  candle_pattern_found BOOLEAN,
  intermarket_aligned  BOOLEAN,
  level_type           VARCHAR(30),
  regime               VARCHAR(20),
  adx_value            DECIMAL(8,2),
  rsi_value            DECIMAL(8,2),
  session              VARCHAR(30),
  confidence_tier      VARCHAR(10),
  risk_pct             DECIMAL(4,2),
  ai_decision          VARCHAR(20) CHECK (ai_decision IN ('APPROVE','REJECT','CONDITIONAL','HARD_RULE')),
  ai_conviction        INTEGER,
  ai_reasoning         TEXT,
  ai_risk_flags        JSONB DEFAULT '[]',
  ai_adjustments       JSONB DEFAULT '{}',
  news_clear           BOOLEAN DEFAULT TRUE,
  h2_conflict          BOOLEAN DEFAULT FALSE,  -- H2 bridge contradicted H4 (logged for learning)
  dxy_direction        VARCHAR(10),
  vix_level            DECIMAL(6,2),
  btc_dominance        DECIMAL(6,2),
  status               VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','TP1','TP2','PARTIAL','CLOSED','EXPIRED','CANCELLED')),
  valid_until          TIMESTAMPTZ,
  sent_telegram        BOOLEAN DEFAULT FALSE,
  outcome              VARCHAR(12) CHECK (outcome IN ('WIN','LOSS','BREAKEVEN','PARTIAL','EXPIRED')),
  exit_price           DECIMAL(20,8),
  exit_reason          VARCHAR(50),
  pnl_r                DECIMAL(8,3),
  pnl_pips             DECIMAL(10,2),
  duration_minutes     INTEGER,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  closed_at            TIMESTAMPTZ
);

-- ─── BRAIN2 EVENTS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brain2_events (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  signal_id           UUID REFERENCES signals(id),
  symbol              VARCHAR(20),
  invalidation_level  VARCHAR(20),
  description         TEXT,
  action_taken        VARCHAR(50),
  price_at_event      DECIMAL(20,8),
  structure_level     DECIMAL(20,8),
  alert_sent          BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── AI DECISIONS LOG ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_decisions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  signal_id        UUID REFERENCES signals(id),
  symbol           VARCHAR(20),
  brain_number     INTEGER CHECK (brain_number IN (1,2,3)),
  input_data       JSONB,
  decision         VARCHAR(20),
  conviction       INTEGER,
  reasoning        TEXT,
  risk_flags       JSONB DEFAULT '[]',
  tokens_used      INTEGER,
  response_ms      INTEGER,
  passed_hard_rule BOOLEAN DEFAULT TRUE,
  valid_json       BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─── PERFORMANCE ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS performance (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  symbol         VARCHAR(20),
  period_start   DATE,
  period_end     DATE,
  total_signals  INTEGER DEFAULT 0,
  total_trades   INTEGER DEFAULT 0,
  wins           INTEGER DEFAULT 0,
  losses         INTEGER DEFAULT 0,
  win_rate       DECIMAL(5,2),
  avg_rr         DECIMAL(5,2),
  total_r        DECIMAL(8,2),
  max_drawdown   DECIMAL(8,2),
  expectancy     DECIMAL(5,2),
  best_type      VARCHAR(10),
  best_session   VARCHAR(20),
  ai_accuracy    DECIMAL(5,2),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ─── LEARNING PATTERNS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS learning_patterns (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  symbol           VARCHAR(20),
  pattern_type     VARCHAR(50),
  entry_type       VARCHAR(10),
  regime           VARCHAR(20),
  session          VARCHAR(20),
  confluence_score INTEGER,
  sample_size      INTEGER DEFAULT 0,
  win_rate         DECIMAL(5,2),
  avg_r            DECIMAL(5,2),
  confidence       DECIMAL(5,2),
  active           BOOLEAN DEFAULT TRUE,
  last_updated     TIMESTAMPTZ DEFAULT NOW(),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─── NEWS EVENTS CACHE ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS news_events (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title        TEXT,
  impact       VARCHAR(10) CHECK (impact IN ('HIGH','MEDIUM','LOW')),
  currency     VARCHAR(10),
  event_time   TIMESTAMPTZ,
  actual       VARCHAR(20),
  forecast     VARCHAR(20),
  previous     VARCHAR(20),
  affects_pairs TEXT[],
  block_start  TIMESTAMPTZ,
  block_end    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ─── SYSTEM CONFIG ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_config (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key         VARCHAR(100) UNIQUE NOT NULL,
  value       JSONB NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── NOTIFICATION LOG ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  signal_id     UUID REFERENCES signals(id),
  channel       VARCHAR(20) CHECK (channel IN ('TELEGRAM','WHATSAPP','CONSOLE')),
  message_type  VARCHAR(30),
  success       BOOLEAN DEFAULT FALSE,
  error_msg     TEXT,
  sent_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─── INDEXES ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_signals_symbol  ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_status  ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_outcome ON signals(outcome);
CREATE INDEX IF NOT EXISTS idx_b2_signal       ON brain2_events(signal_id);
CREATE INDEX IF NOT EXISTS idx_ai_signal       ON ai_decisions(signal_id);
CREATE INDEX IF NOT EXISTS idx_perf_symbol     ON performance(symbol);
CREATE INDEX IF NOT EXISTS idx_news_time       ON news_events(event_time);

-- ─── SEED: ALL 20 PAIRS ──────────────────────────────────────────────────────
INSERT INTO pairs (symbol, market, tv_symbol, pip_size, session_type, active) VALUES
('EURUSD','FOREX',  'FX:EURUSD',         0.0001,  'FOREX',   TRUE),
('XAUUSD','FOREX',  'TVC:GOLD',          0.01,    'FOREX',   TRUE),
('GBPUSD','FOREX',  'FX:GBPUSD',         0.0001,  'FOREX',   FALSE),
('USDJPY','FOREX',  'FX:USDJPY',         0.01,    'FOREX',   FALSE),
('AUDUSD','FOREX',  'FX:AUDUSD',         0.0001,  'FOREX',   FALSE),
('USDCAD','FOREX',  'FX:USDCAD',         0.0001,  'FOREX',   FALSE),
('GBPJPY','FOREX',  'FX:GBPJPY',         0.01,    'FOREX',   FALSE),
('EURJPY','FOREX',  'FX:EURJPY',         0.01,    'FOREX',   FALSE),
('NZDUSD','FOREX',  'FX:NZDUSD',         0.0001,  'FOREX',   FALSE),
('USDCHF','FOREX',  'FX:USDCHF',         0.0001,  'FOREX',   FALSE),
('BTCUSD','CRYPTO', 'BINANCE:BTCUSDT',   1.0,     'CRYPTO',  FALSE),
('ETHUSD','CRYPTO', 'BINANCE:ETHUSDT',   0.1,     'CRYPTO',  FALSE),
('SOLUSD','CRYPTO', 'BINANCE:SOLUSDT',   0.01,    'CRYPTO',  FALSE),
('BNBUSD','CRYPTO', 'BINANCE:BNBUSDT',   0.1,     'CRYPTO',  FALSE),
('XRPUSD','CRYPTO', 'BINANCE:XRPUSDT',   0.0001,  'CRYPTO',  FALSE),
('SPY',   'STOCKS', 'AMEX:SPY',          0.01,    'STOCKS',  FALSE),
('NVDA',  'STOCKS', 'NASDAQ:NVDA',       0.01,    'STOCKS',  FALSE),
('AAPL',  'STOCKS', 'NASDAQ:AAPL',       0.01,    'STOCKS',  FALSE),
('ES1',   'FUTURES','CME_MINI:ES1!',     0.25,    'FUTURES', FALSE),
('GC1',   'FUTURES','COMEX:GC1!',        0.1,     'FUTURES', FALSE)
ON CONFLICT (symbol) DO NOTHING;

-- ─── SEED: SYSTEM CONFIG ─────────────────────────────────────────────────────
INSERT INTO system_config (key, value, description) VALUES
('scan_interval_mins',    '15',    'Brain 1 scan frequency in minutes'),
('guardian_interval_mins','5',     'Brain 2 monitoring frequency in minutes'),
('max_concurrent_signals','3',     'Max open signals per market type'),
('daily_loss_limit',      '3',     'Stop scanning after N losses in a day'),
('signal_validity_hrs',   '4',     'Hours before unactivated signal expires'),
('paper_trade_mode',      'true',  'Paper trading mode active'),
('telegram_enabled',      'false', 'Telegram notifications'),
('whatsapp_enabled',      'false', 'WhatsApp notifications (activate when ready)')
ON CONFLICT (key) DO NOTHING;
