-- APEX V2 SCHEMA

CREATE TABLE IF NOT EXISTS signals (
  id               SERIAL PRIMARY KEY,
  symbol           VARCHAR(20),
  direction        VARCHAR(5),
  tier             VARCHAR(20),
  confluence_score INT,
  entry_type       VARCHAR(10),
  entry_price      DECIMAL(10,5),
  stop_loss        DECIMAL(10,5),
  tp1              DECIMAL(10,5),
  tp2              DECIMAL(10,5),
  reason           TEXT,
  ai_conviction    INT,
  h4_closed        BOOLEAN,
  valid_until      TIMESTAMP,
  created_at       TIMESTAMP DEFAULT NOW(),
  status           VARCHAR(20) DEFAULT 'ACTIVE'
);

CREATE TABLE IF NOT EXISTS trades (
  id                SERIAL PRIMARY KEY,
  signal_id         INT REFERENCES signals(id),
  ctrader_order_id  VARCHAR(50),
  symbol            VARCHAR(20),
  direction         VARCHAR(5),
  entry_price       DECIMAL(10,5),
  entry_time        TIMESTAMP,
  stop_loss         DECIMAL(10,5),
  tp1               DECIMAL(10,5),
  tp2               DECIMAL(10,5),
  size              DECIMAL(10,2),
  exit_price        DECIMAL(10,5),
  exit_time         TIMESTAMP,
  exit_reason       VARCHAR(50),
  pnl               DECIMAL(10,2),
  pnl_r             DECIMAL(10,2),
  tier              VARCHAR(20),
  outcome           VARCHAR(10),
  closed_at         TIMESTAMP,
  created_at        TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscribers (
  id                SERIAL PRIMARY KEY,
  email             VARCHAR(255) UNIQUE,
  tier              VARCHAR(20) DEFAULT 'free',
  joined_date       TIMESTAMP DEFAULT NOW(),
  last_payment_date TIMESTAMP,
  status            VARCHAR(20) DEFAULT 'active',
  created_at        TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS learning_patterns (
  id               SERIAL PRIMARY KEY,
  analysis_date    TIMESTAMP,
  pair             VARCHAR(20),
  win_rate_pct     DECIMAL(5,2),
  total_trades     INT,
  avg_r_earned     DECIMAL(10,2),
  best_entry_type  VARCHAR(10),
  best_session     VARCHAR(20),
  insights         TEXT,
  suggested_changes TEXT,
  user_approval    BOOLEAN,
  applied_at       TIMESTAMP,
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_logs (
  id         SERIAL PRIMARY KEY,
  log_type   VARCHAR(50),
  message    TEXT,
  symbol     VARCHAR(20),
  status     VARCHAR(50),
  timestamp  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ctrader_accounts (
  id          SERIAL PRIMARY KEY,
  account_id  VARCHAR(50),
  api_key     VARCHAR(255),
  connected   BOOLEAN DEFAULT false,
  balance     DECIMAL(15,2),
  equity      DECIMAL(15,2),
  last_sync   TIMESTAMP,
  created_at  TIMESTAMP DEFAULT NOW()
);
