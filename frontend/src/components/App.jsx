import { useEffect, useMemo, useState } from "react";

const DEFAULT_PAIR = "EURUSD";
const CHART_INTERVALS = ["15m", "1h", "4h"];

const api = async (path, options = {}) => {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed: ${res.status}`);
  return json;
};

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const fmtPrice = (value, symbol) => {
  const n = toNumber(value);
  if (n === null) return "-";
  if (symbol === "XAUUSD") return n.toFixed(2);
  if (symbol?.includes("JPY")) return n.toFixed(3);
  return n.toFixed(5);
};

const fmtMoney = (value) => {
  const n = toNumber(value);
  if (n === null) return "-";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
};

const fmtCompact = (value) => {
  const n = toNumber(value);
  if (n === null) return "-";
  return new Intl.NumberFormat("en-AU", {
    maximumFractionDigits: 2,
    notation: Math.abs(n) >= 1000 ? "compact" : "standard",
  }).format(n);
};

const fmtPercent = (value) => {
  const n = toNumber(value);
  if (n === null) return "-";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
};

const fmtR = (value) => {
  const n = toNumber(value);
  if (n === null) return "-";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}R`;
};

const fmtDate = (value) => {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

const countdownToInterval = (date, intervalMins) => {
  const now = new Date(date);
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(Math.floor(now.getMinutes() / intervalMins) * intervalMins + intervalMins);
  const diffMs = Math.max(0, next.getTime() - now.getTime());
  const total = Math.floor(diffMs / 1000);
  const mins = String(Math.floor(total / 60)).padStart(2, "0");
  const secs = String(total % 60).padStart(2, "0");
  return `${mins}:${secs}`;
};

function Pill({ label, value, tone = "neutral" }) {
  return (
    <div className={`pill pill-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HeroMetric({ label, value, detail, tone = "default" }) {
  return (
    <article className={`hero-metric tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </article>
  );
}

function PairButton({ symbol, snapshot, active, selected, onSelect }) {
  const price = snapshot?.price;
  return (
    <button className={`pair-button ${selected ? "selected" : ""}`} onClick={() => onSelect(symbol)}>
      <div>
        <strong>{symbol}</strong>
        <small>{active ? "live pair" : "idle"}</small>
      </div>
      <div className="pair-button-right">
        <span>{price !== null && price !== undefined ? fmtPrice(price, symbol) : "-"}</span>
        <em>{snapshot?.source || "waiting"}</em>
      </div>
    </button>
  );
}

function ActionButton({ children, onClick, disabled, tone = "default" }) {
  return (
    <button className={`action-button ${tone}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

function EquityChart({ curve, totalBalance }) {
  const points = curve || [];
  if (!points.length) {
    return <div className="empty-state tight">No closed trades yet, so the equity curve is waiting for its first mark.</div>;
  }

  const width = 760;
  const height = 240;
  const pad = 22;
  const balances = points.map((point) => Number(point.balance) || 0);
  const min = Math.min(...balances);
  const max = Math.max(...balances);
  const range = Math.max(max - min, 1);

  const path = points.map((point, index) => {
    const x = pad + (index * (width - pad * 2)) / Math.max(points.length - 1, 1);
    const y = height - pad - ((Number(point.balance) - min) / range) * (height - pad * 2);
    return `${index === 0 ? "M" : "L"} ${x} ${y}`;
  }).join(" ");

  const area = `${path} L ${width - pad} ${height - pad} L ${pad} ${height - pad} Z`;
  const latest = points[points.length - 1];

  return (
    <div className="chart-shell">
      <div className="chart-caption">
        <div>
          <span className="section-kicker">ASSUMED EQUITY</span>
          <strong>{fmtMoney(totalBalance)}</strong>
        </div>
        <small>{points.length - 1} closed points plus live mark</small>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="equity-chart" aria-label="Equity curve">
        <defs>
          <linearGradient id="equity-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(47, 129, 247, 0.42)" />
            <stop offset="100%" stopColor="rgba(47, 129, 247, 0.02)" />
          </linearGradient>
        </defs>
        <rect width={width} height={height} rx="18" fill="transparent" />
        {[0, 0.25, 0.5, 0.75, 1].map((step) => {
          const y = pad + step * (height - pad * 2);
          return <line key={step} x1={pad} y1={y} x2={width - pad} y2={y} className="grid-line" />;
        })}
        <path d={area} fill="url(#equity-fill)" />
        <path d={path} className="equity-line" />
        {points.map((point, index) => {
          const x = pad + (index * (width - pad * 2)) / Math.max(points.length - 1, 1);
          const y = height - pad - ((Number(point.balance) - min) / range) * (height - pad * 2);
          return <circle key={`${point.label}-${index}`} cx={x} cy={y} r={index === points.length - 1 ? 4.5 : 3} className="equity-dot" />;
        })}
        <text x={pad} y={18} className="axis-label">{fmtMoney(max)}</text>
        <text x={pad} y={height - 8} className="axis-label">{fmtMoney(min)}</text>
        <text x={width - pad} y={18} textAnchor="end" className="axis-label">{latest?.label || "Live"}</text>
      </svg>
    </div>
  );
}

function CandleChart({ chart, symbol, interval }) {
  const candles = chart?.candles || [];
  if (!candles.length) {
    return <div className="empty-state tight">Chart data is still loading for {symbol}.</div>;
  }

  const width = 900;
  const height = 320;
  const padX = 28;
  const padY = 20;
  const lows = candles.map((candle) => Number(candle.low));
  const highs = candles.map((candle) => Number(candle.high));
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const range = Math.max(max - min, 0.00001);
  const innerWidth = width - padX * 2;
  const innerHeight = height - padY * 2;
  const candleSlot = innerWidth / candles.length;
  const candleWidth = Math.max(3, candleSlot * 0.62);

  const pointY = (price) => height - padY - ((price - min) / range) * innerHeight;
  const emaPath = (key) => {
    const values = chart[key];
    if (!Number.isFinite(values)) return "";
    const flat = candles.map(() => values);
    return flat.map((price, index) => {
      const x = padX + index * candleSlot + candleSlot / 2;
      const y = pointY(price);
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    }).join(" ");
  };

  return (
    <div className="chart-shell">
      <div className="chart-caption">
        <div>
          <span className="section-kicker">PAIR CHART</span>
          <strong>{symbol} {interval}</strong>
        </div>
        <small>{chart?.source || "15m close"} | RSI {chart?.rsi?.toFixed?.(1) ?? "-"} | ADX {chart?.adx?.toFixed?.(1) ?? "-"}</small>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="candle-chart" aria-label={`${symbol} chart`}>
        {[0, 0.25, 0.5, 0.75, 1].map((step) => {
          const y = padY + step * innerHeight;
          return <line key={step} x1={padX} y1={y} x2={width - padX} y2={y} className="grid-line" />;
        })}
        {candles.map((candle, index) => {
          const open = Number(candle.open);
          const high = Number(candle.high);
          const low = Number(candle.low);
          const close = Number(candle.close);
          const bullish = close >= open;
          const x = padX + index * candleSlot + candleSlot / 2;
          const bodyTop = pointY(Math.max(open, close));
          const bodyBottom = pointY(Math.min(open, close));
          const bodyHeight = Math.max(1.5, bodyBottom - bodyTop);
          return (
            <g key={`${index}-${open}-${close}`}>
              <line x1={x} y1={pointY(high)} x2={x} y2={pointY(low)} className={`wick ${bullish ? "up" : "down"}`} />
              <rect
                x={x - candleWidth / 2}
                y={bodyTop}
                width={candleWidth}
                height={bodyHeight}
                rx="1.5"
                className={`body ${bullish ? "up" : "down"}`}
              />
            </g>
          );
        })}
        <path d={emaPath("ema21")} className="ema-line fast" />
        <path d={emaPath("ema50")} className="ema-line slow" />
        <text x={padX} y={16} className="axis-label">{fmtPrice(max, symbol)}</text>
        <text x={padX} y={height - 6} className="axis-label">{fmtPrice(min, symbol)}</text>
        <text x={width - padX} y={16} textAnchor="end" className="axis-label">
          Last {fmtPrice(chart?.currentPrice, symbol)}
        </text>
      </svg>
    </div>
  );
}

function ActiveTradeCard({ trade }) {
  const statusTone = (trade.current_r || 0) > 0 ? "good" : (trade.current_r || 0) < 0 ? "bad" : "neutral";
  return (
    <article className={`trade-card ${statusTone}`}>
      <div className="trade-head">
        <div>
          <span className="section-kicker">{trade.symbol}</span>
          <h3>{trade.direction}</h3>
        </div>
        <div className="trade-badges">
          <span>{trade.confidence_tier}</span>
          <span>{trade.status}</span>
        </div>
      </div>
      <div className="trade-grid">
        <div>
          <span>Entry</span>
          <strong>{fmtPrice(trade.entry_price, trade.symbol)}</strong>
        </div>
        <div>
          <span>Now</span>
          <strong>{fmtPrice(trade.current_price, trade.symbol)}</strong>
        </div>
        <div>
          <span>Suggested lot</span>
          <strong>{trade.lots !== null ? `${trade.lots.toFixed(2)} lot` : "-"}</strong>
        </div>
        <div>
          <span>Risk amount</span>
          <strong>{fmtMoney(trade.risk_amount)}</strong>
        </div>
      </div>
      <div className="trade-strip">
        <span className={statusTone}>{fmtR(trade.current_r)}</span>
        <span className={statusTone}>{fmtMoney(trade.floating_amount)}</span>
        <span>{fmtPercent(trade.floating_percent)}</span>
        <span>{trade.price_source || "15m close"}</span>
      </div>
      <p>{trade.ai_reasoning || "Assumed executed automatically when the full signal fired."}</p>
      <footer>
        <span>Opened {fmtDate(trade.created_at)}</span>
        <span>TP1 {fmtPrice(trade.tp1, trade.symbol)} | TP2 {fmtPrice(trade.tp2, trade.symbol)}</span>
      </footer>
    </article>
  );
}

function ClosedTradesTable({ trades }) {
  if (!trades.length) {
    return <div className="empty-state">No closed trades yet. Once the first trade resolves, this table will start recording compounding growth.</div>;
  }

  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>Pair</th>
            <th>Result</th>
            <th>Lots</th>
            <th>P/L</th>
            <th>R</th>
            <th>Growth</th>
            <th>Equity</th>
            <th>Closed</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => (
            <tr key={trade.id}>
              <td>
                <strong>{trade.symbol}</strong>
                <small>{trade.direction}</small>
              </td>
              <td className={trade.outcome === "WIN" ? "good" : trade.outcome === "LOSS" ? "bad" : "neutral"}>
                {trade.outcome}
              </td>
              <td>{trade.lots !== null ? trade.lots.toFixed(2) : "-"}</td>
              <td className={(trade.pnl_amount || 0) >= 0 ? "good" : "bad"}>{fmtMoney(trade.pnl_amount)}</td>
              <td className={(trade.pnl_r || 0) >= 0 ? "good" : "bad"}>{fmtR(trade.pnl_r)}</td>
              <td className={(trade.pnl_percent || 0) >= 0 ? "good" : "bad"}>{fmtPercent(trade.pnl_percent)}</td>
              <td>{fmtMoney(trade.end_balance)}</td>
              <td>{fmtDate(trade.closed_at || trade.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PairPerformance({ rows }) {
  if (!rows.length) {
    return <div className="empty-state">Pair performance will populate once signals start closing.</div>;
  }

  return (
    <div className="table-shell compact">
      <table>
        <thead>
          <tr>
            <th>Pair</th>
            <th>Trades</th>
            <th>Wins</th>
            <th>Losses</th>
            <th>WR</th>
            <th>Total R</th>
            <th>Avg R</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.symbol}>
              <td><strong>{row.symbol}</strong></td>
              <td>{row.total_trades}</td>
              <td>{row.wins}</td>
              <td>{row.losses}</td>
              <td>{row.win_rate}%</td>
              <td className={Number(row.total_r) >= 0 ? "good" : "bad"}>{fmtR(row.total_r)}</td>
              <td>{fmtR(row.avg_r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function App() {
  const [dashboardData, setDashboardData] = useState(null);
  const [chartData, setChartData] = useState(null);
  const [selectedPair, setSelectedPair] = useState(DEFAULT_PAIR);
  const [chartInterval, setChartInterval] = useState("15m");
  const [accountInput, setAccountInput] = useState("50000");
  const [clock, setClock] = useState(Date.now());
  const [busyAction, setBusyAction] = useState("");
  const [log, setLog] = useState([]);
  const [error, setError] = useState("");

  const dashboard = dashboardData?.dashboard;
  const status = dashboardData?.status;
  const pairSnapshots = dashboard?.priceMap || {};
  const activePairs = dashboard?.pairs?.filter((pair) => pair.active).map((pair) => pair.symbol) || [];
  const currentTime = useMemo(() => clock, [clock]);

  const pushLog = (message) => {
    setLog((rows) => [{ at: new Date().toISOString(), message }, ...rows].slice(0, 12));
  };

  const loadDashboard = async () => {
    const result = await api("/api/dashboard");
    setDashboardData(result);
    setAccountInput(String(result.dashboard?.baseBalance || 50000));
  };

  const loadChart = async (symbol = selectedPair, interval = chartInterval) => {
    const result = await api(`/api/chart/${symbol}?interval=${interval}&size=72`);
    setChartData(result);
  };

  const refreshAll = async (symbol = selectedPair, interval = chartInterval) => {
    try {
      setError("");
      await Promise.all([loadDashboard(), loadChart(symbol, interval)]);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    refreshAll();
    const refreshId = setInterval(() => refreshAll(selectedPair, chartInterval), 30000);
    const clockId = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      clearInterval(refreshId);
      clearInterval(clockId);
    };
  }, []);

  useEffect(() => {
    if (dashboard?.pairs?.length && !dashboard.pairs.find((pair) => pair.symbol === selectedPair)) {
      setSelectedPair(dashboard.pairs[0].symbol);
    }
  }, [dashboard, selectedPair]);

  useEffect(() => {
    loadChart(selectedPair, chartInterval).catch((err) => setError(err.message));
  }, [selectedPair, chartInterval]);

  const scanPair = async (symbol) => {
    setBusyAction(`scan-${symbol}`);
    try {
      const result = await api(`/api/pipeline/${symbol}`, { method: "POST" });
      const stage = result.result?.stage || "unknown";
      const sent = result.result?.sent ? "telegram dispatched" : "recorded without telegram";
      pushLog(`${symbol} scanned: ${stage}, ${sent}.`);
      await refreshAll(symbol, chartInterval);
    } catch (err) {
      setError(err.message);
      pushLog(`${symbol} scan failed: ${err.message}`);
    } finally {
      setBusyAction("");
    }
  };

  const testTelegram = async (symbol) => {
    setBusyAction(`telegram-${symbol}`);
    try {
      const result = await api("/api/telegram/test", {
        method: "POST",
        body: JSON.stringify({ symbol }),
      });
      pushLog(`${symbol} telegram test sent using ${result.price?.source || "unknown source"}.`);
      await refreshAll(symbol, chartInterval);
    } catch (err) {
      setError(err.message);
      pushLog(`Telegram test failed: ${err.message}`);
    } finally {
      setBusyAction("");
    }
  };

  const saveAccountSize = async () => {
    setBusyAction("account-save");
    try {
      const value = Number(accountInput);
      if (!Number.isFinite(value) || value <= 0) throw new Error("Enter a valid demo account size.");
      await api("/api/config/demo_account_size", {
        method: "PUT",
        body: JSON.stringify({ value }),
      });
      pushLog(`Demo account size updated to ${fmtMoney(value)}.`);
      await refreshAll(selectedPair, chartInterval);
    } catch (err) {
      setError(err.message);
      pushLog(`Account size save failed: ${err.message}`);
    } finally {
      setBusyAction("");
    }
  };

  const nextScan = countdownToInterval(currentTime, dashboard?.scanIntervalMins || 15);
  const nextGuard = countdownToInterval(currentTime, dashboard?.guardianIntervalMins || 5);
  const summary = dashboard?.summary || {};
  const activeSignals = dashboard?.activeSignals || [];
  const recentClosed = dashboard?.recentClosed || [];
  const performance = dashboard?.performance || [];
  const livePairs = status?.livePairs || [];

  return (
    <>
      <style>{styles}</style>
      <main className="workspace">
        <section className="hero">
          <div className="hero-copy">
            <span className="section-kicker">APEX SIGNAL SYSTEM / MANUAL EXECUTION DESK</span>
            <h1>Trade the signal. Let the system keep score.</h1>
            <p>
              GitHub-inspired operator view for live scans, assumed execution on your 50k demo book, compounding equity, and the exact lot size the signal expects you to place.
            </p>
            <div className="hero-pills">
              <Pill label="Mode" value={status?.mode || "-"} tone={status?.mode === "PAPER" ? "good" : "warn"} />
              <Pill label="AI" value={status?.ai || "-"} tone={status?.ai === "LIVE" ? "good" : "warn"} />
              <Pill label="Telegram" value={status?.telegram || "-"} tone={status?.telegram === "AUTHORIZED" ? "good" : "warn"} />
              <Pill label="Policy" value={status?.livePolicy || "-"} tone="neutral" />
            </div>
          </div>

          <div className="hero-stack">
            <HeroMetric label="Live equity" value={fmtMoney(dashboard?.totalBalance)} detail={`${fmtPercent(dashboard?.growthPct)} from base`} tone="blue" />
            <HeroMetric label="Realized balance" value={fmtMoney(dashboard?.realizedBalance)} detail={`${fmtPercent(dashboard?.realizedGrowthPct)} booked`} tone="green" />
            <HeroMetric label="Open P/L" value={fmtMoney(dashboard?.floatingPnL)} detail={`${summary.openTrades || 0} open trades`} tone={(dashboard?.floatingPnL || 0) >= 0 ? "green" : "red"} />
            <HeroMetric label="Win / loss" value={`${summary.wins || 0} / ${summary.losses || 0}`} detail={`${summary.winRate || 0}% decisive win rate`} tone="default" />
          </div>
        </section>

        {error ? <div className="error-banner">{error}</div> : null}

        <section className="strip-grid">
          <HeroMetric label="Net R" value={fmtR(summary.netR)} detail={`avg ${fmtR(summary.avgR)} per closed trade`} tone="default" />
          <HeroMetric label="Profit factor" value={summary.profitFactor ?? "-"} detail={`day ${fmtR(summary.dayR)} | total ${fmtR(summary.totalR)}`} tone="default" />
          <HeroMetric label="Next scan" value={nextScan} detail={`Brain1 every ${dashboard?.scanIntervalMins || 15}m`} tone="blue" />
          <HeroMetric label="Guard sweep" value={nextGuard} detail={`Brain2 every ${dashboard?.guardianIntervalMins || 5}m`} tone="default" />
          <HeroMetric label="Open winners / losers" value={`${dashboard?.floatingWinners || 0} / ${dashboard?.floatingLosers || 0}`} detail="marked off the latest 15m close" tone="default" />
          <HeroMetric label="Assumed trades" value={summary.tradesTaken || 0} detail="every BUY or SELL is counted as taken" tone="default" />
        </section>

        <section className="content-grid">
          <article className="panel panel-chart">
            <div className="panel-head">
              <div>
                <span className="section-kicker">PAIR BOARD</span>
                <h2>Live chart and execution controls</h2>
              </div>
              <div className="head-actions">
                <ActionButton onClick={() => refreshAll(selectedPair, chartInterval)} disabled={Boolean(busyAction)}>Refresh</ActionButton>
                <ActionButton onClick={() => scanPair(selectedPair)} disabled={Boolean(busyAction)} tone="green">
                  {busyAction === `scan-${selectedPair}` ? "Scanning..." : `Scan ${selectedPair}`}
                </ActionButton>
                <ActionButton onClick={() => testTelegram(selectedPair)} disabled={Boolean(busyAction)} tone="dark">
                  {busyAction === `telegram-${selectedPair}` ? "Sending..." : "Telegram test"}
                </ActionButton>
              </div>
            </div>

            <div className="pair-switcher">
              {(livePairs.length ? livePairs : [selectedPair]).map((symbol) => (
                <PairButton
                  key={symbol}
                  symbol={symbol}
                  snapshot={pairSnapshots[symbol]}
                  active={activePairs.includes(symbol)}
                  selected={selectedPair === symbol}
                  onSelect={setSelectedPair}
                />
              ))}
            </div>

            <div className="chart-toolbar">
              <div className="intervals">
                {CHART_INTERVALS.map((interval) => (
                  <button
                    key={interval}
                    className={`interval-chip ${chartInterval === interval ? "active" : ""}`}
                    onClick={() => setChartInterval(interval)}
                  >
                    {interval}
                  </button>
                ))}
              </div>
              <div className="toolbar-meta">
                <span>Current {fmtPrice(chartData?.currentPrice, selectedPair)}</span>
                <span>{chartData?.source || "loading"}</span>
              </div>
            </div>

            <CandleChart chart={chartData} symbol={selectedPair} interval={chartInterval} />
          </article>

          <aside className="stack">
            <article className="panel compact-panel">
              <div className="panel-head">
                <div>
                  <span className="section-kicker">DEMO BOOK</span>
                  <h2>Account assumptions</h2>
                </div>
              </div>
              <div className="account-editor">
                <label htmlFor="account-size">Demo account size (USD)</label>
                <div className="account-row">
                  <input
                    id="account-size"
                    value={accountInput}
                    onChange={(event) => setAccountInput(event.target.value)}
                    inputMode="decimal"
                  />
                  <ActionButton onClick={saveAccountSize} disabled={busyAction === "account-save"} tone="green">
                    {busyAction === "account-save" ? "Saving..." : "Save"}
                  </ActionButton>
                </div>
                <p>
                  The desk assumes every full BUY or SELL signal is executed manually on this account. Ready alerts stay watch-only and do not alter growth.
                </p>
              </div>
            </article>

            <article className="panel compact-panel">
              <div className="panel-head">
                <div>
                  <span className="section-kicker">SYSTEM STATE</span>
                  <h2>Live runtime</h2>
                </div>
              </div>
              <div className="status-grid">
                <Pill label="Server" value={dashboardData?.success ? "ONLINE" : "LOADING"} tone="good" />
                <Pill label="Telegram" value={status?.telegram || "-"} tone={status?.telegram === "AUTHORIZED" ? "good" : "warn"} />
                <Pill label="Provider" value={status?.marketDataProvider || "-"} tone="neutral" />
                <Pill label="Pairs" value={activePairs.length || 0} tone="neutral" />
              </div>
              <div className="runtime-meta">
                <span>UTC {dashboardData?.time?.utc || "-"}</span>
                <span>Sydney {dashboardData?.time?.sydney || "-"}</span>
                <span>{status?.telegramError || "Telegram auth is healthy."}</span>
              </div>
            </article>

            <article className="panel compact-panel">
              <div className="panel-head">
                <div>
                  <span className="section-kicker">OPERATOR LOG</span>
                  <h2>Recent actions</h2>
                </div>
              </div>
              <div className="log-list">
                {log.length ? log.map((row) => (
                  <div className="log-row" key={`${row.at}-${row.message}`}>
                    <span>{new Date(row.at).toLocaleTimeString([], { hour12: false })}</span>
                    <p>{row.message}</p>
                  </div>
                )) : <div className="empty-state tight">No local actions yet. A scan, test, or account update will show up here.</div>}
              </div>
            </article>
          </aside>
        </section>

        <section className="content-grid lower">
          <article className="panel panel-wide">
            <div className="panel-head">
              <div>
                <span className="section-kicker">EQUITY CURVE</span>
                <h2>Compounding growth from assumed execution</h2>
              </div>
            </div>
            <EquityChart curve={dashboard?.equityCurve || []} totalBalance={dashboard?.totalBalance} />
          </article>

          <article className="panel panel-side">
            <div className="panel-head">
              <div>
                <span className="section-kicker">PAIR STATS</span>
                <h2>Where the edge is showing up</h2>
              </div>
            </div>
            <PairPerformance rows={performance} />
          </article>
        </section>

        <section className="content-grid lower">
          <article className="panel panel-wide">
            <div className="panel-head">
              <div>
                <span className="section-kicker">OPEN BOOK</span>
                <h2>Winning and losing trades right now</h2>
              </div>
            </div>
            <div className="trade-list">
              {activeSignals.length ? activeSignals.map((trade) => (
                <ActiveTradeCard key={trade.id || `${trade.symbol}-${trade.created_at}`} trade={trade} />
              )) : <div className="empty-state">No open trades right now. The desk is waiting for the next full signal to become an assumed position.</div>}
            </div>
          </article>

          <article className="panel panel-side">
            <div className="panel-head">
              <div>
                <span className="section-kicker">BOOKMARKS</span>
                <h2>What to watch</h2>
              </div>
            </div>
            <div className="bookmark-list">
              <div className="bookmark">
                <strong>Lot size</strong>
                <p>The suggested lot uses the stored account size and the signal's risk tier. Use it as the manual execution amount.</p>
              </div>
              <div className="bookmark">
                <strong>Growth math</strong>
                <p>Closed trades compound from the last booked balance. Open trades show floating P/L against the balance that existed when the signal was assumed.</p>
              </div>
              <div className="bookmark">
                <strong>Chart feed</strong>
                <p>The dashboard uses live candle-close snapshots to stay rate-limit friendly, while the signal engine keeps using live market services behind the scenes.</p>
              </div>
            </div>
          </article>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <span className="section-kicker">CLOSED BOOK</span>
              <h2>Wins, losses, R multiple, P/L, and equity after each trade</h2>
            </div>
          </div>
          <ClosedTradesTable trades={recentClosed} />
        </section>
      </main>
    </>
  );
}

const styles = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Manrope:wght@400;500;600;700;800&display=swap');

:root {
  --bg: #0d1117;
  --bg-soft: #11161d;
  --panel: rgba(22, 27, 34, 0.92);
  --panel-alt: rgba(13, 17, 23, 0.94);
  --line: rgba(139, 148, 158, 0.18);
  --line-strong: rgba(139, 148, 158, 0.34);
  --text: #e6edf3;
  --muted: #8b949e;
  --dim: #6e7681;
  --green: #3fb950;
  --green-soft: rgba(63, 185, 80, 0.12);
  --blue: #2f81f7;
  --blue-soft: rgba(47, 129, 247, 0.14);
  --red: #f85149;
  --red-soft: rgba(248, 81, 73, 0.12);
  --gold: #d29922;
  --shadow: 0 24px 60px rgba(0, 0, 0, 0.34);
}

* { box-sizing: border-box; }
html, body, #root { min-height: 100%; }
body {
  margin: 0;
  color: var(--text);
  background:
    linear-gradient(180deg, rgba(47, 129, 247, 0.08), transparent 26rem),
    radial-gradient(circle at 10% 10%, rgba(63, 185, 80, 0.08), transparent 24rem),
    linear-gradient(180deg, #0b0f14 0%, #0d1117 42%, #0a0f14 100%);
  font-family: Manrope, sans-serif;
}

body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
  background-size: 28px 28px;
  mask-image: linear-gradient(180deg, rgba(0,0,0,0.2), rgba(0,0,0,0.85));
}

button,
input {
  font: inherit;
}

.workspace {
  width: min(1500px, calc(100% - 32px));
  margin: 0 auto;
  padding: 26px 0 46px;
}

.hero,
.strip-grid,
.content-grid,
.trade-list,
.hero-pills,
.hero-stack,
.status-grid,
.pair-switcher,
.head-actions,
.intervals,
.bookmark-list,
.log-list {
  display: grid;
  gap: 16px;
}

.hero {
  grid-template-columns: minmax(0, 1.5fr) minmax(360px, 0.8fr);
  margin-bottom: 18px;
}

.hero-copy,
.hero-stack,
.panel,
.hero-metric,
.pill {
  background: linear-gradient(180deg, rgba(22, 27, 34, 0.96), rgba(13, 17, 23, 0.96));
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
}

.hero-copy,
.panel {
  border-radius: 24px;
}

.hero-copy {
  padding: 30px;
  position: relative;
  overflow: hidden;
}

.hero-copy::after {
  content: "";
  position: absolute;
  right: -100px;
  top: -60px;
  width: 280px;
  height: 280px;
  border-radius: 999px;
  background: radial-gradient(circle, rgba(47, 129, 247, 0.18), transparent 70%);
}

.section-kicker,
.pill span,
.hero-metric span,
.trade-grid span,
.table-shell th,
.axis-label,
.log-row span,
.bookmark strong {
  font-family: "JetBrains Mono", monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 0.72rem;
  color: var(--muted);
}

h1, h2, h3, p, strong, small {
  margin: 0;
}

h1 {
  margin-top: 14px;
  max-width: 740px;
  font-size: clamp(2.9rem, 6.8vw, 6rem);
  line-height: 0.96;
  letter-spacing: -0.06em;
}

h2 {
  margin-top: 6px;
  font-size: 1.42rem;
  letter-spacing: -0.03em;
}

h3 {
  margin-top: 6px;
  font-size: 1.5rem;
  letter-spacing: -0.03em;
}

.hero-copy p {
  margin-top: 16px;
  max-width: 700px;
  color: var(--muted);
  line-height: 1.65;
  font-size: 1.02rem;
}

.hero-pills {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-top: 24px;
}

.pill {
  border-radius: 16px;
  padding: 14px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.pill strong {
  font-size: 0.85rem;
}

.pill-good strong,
.good {
  color: var(--green);
}

.pill-warn strong,
.bad {
  color: var(--red);
}

.pill-neutral strong,
.neutral {
  color: var(--text);
}

.hero-stack {
  border-radius: 24px;
  padding: 14px;
  align-content: start;
}

.hero-metric {
  border-radius: 18px;
  padding: 18px;
}

.hero-metric strong {
  display: block;
  margin-top: 10px;
  font-size: clamp(1.55rem, 3vw, 2.35rem);
  line-height: 1;
}

.hero-metric small {
  display: block;
  margin-top: 8px;
  color: var(--muted);
  line-height: 1.4;
}

.tone-green {
  border-color: rgba(63, 185, 80, 0.22);
  background: linear-gradient(180deg, rgba(18, 33, 23, 0.96), rgba(13, 17, 23, 0.96));
}

.tone-red {
  border-color: rgba(248, 81, 73, 0.22);
  background: linear-gradient(180deg, rgba(36, 18, 18, 0.96), rgba(13, 17, 23, 0.96));
}

.tone-blue {
  border-color: rgba(47, 129, 247, 0.24);
  background: linear-gradient(180deg, rgba(18, 27, 40, 0.96), rgba(13, 17, 23, 0.96));
}

.strip-grid {
  grid-template-columns: repeat(6, minmax(0, 1fr));
  margin-bottom: 18px;
}

.content-grid {
  grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.8fr);
  margin-bottom: 18px;
}

.content-grid.lower {
  grid-template-columns: minmax(0, 1.3fr) minmax(340px, 0.7fr);
}

.stack {
  display: grid;
  gap: 16px;
  align-content: start;
}

.panel {
  padding: 20px;
}

.compact-panel {
  padding: 18px;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  align-items: start;
  margin-bottom: 16px;
}

.head-actions {
  grid-template-columns: repeat(3, auto);
  align-items: center;
}

.action-button,
.interval-chip,
.pair-button {
  border: 1px solid var(--line);
  background: rgba(240, 246, 252, 0.02);
  color: var(--text);
}

.action-button,
.interval-chip {
  border-radius: 999px;
  padding: 10px 14px;
  cursor: pointer;
  transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
}

.action-button:hover,
.interval-chip:hover,
.pair-button:hover {
  transform: translateY(-1px);
  border-color: var(--line-strong);
}

.action-button.green {
  background: var(--green-soft);
  border-color: rgba(63, 185, 80, 0.28);
}

.action-button.dark {
  background: rgba(47, 129, 247, 0.08);
  border-color: rgba(47, 129, 247, 0.24);
}

.action-button:disabled {
  opacity: 0.65;
  cursor: wait;
  transform: none;
}

.pair-switcher {
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin-bottom: 16px;
}

.pair-button {
  border-radius: 18px;
  padding: 14px;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  text-align: left;
  cursor: pointer;
}

.pair-button strong {
  display: block;
  font-size: 0.96rem;
}

.pair-button small,
.pair-button em {
  color: var(--muted);
  font-style: normal;
  font-size: 0.78rem;
}

.pair-button-right {
  display: flex;
  flex-direction: column;
  align-items: end;
  gap: 4px;
}

.pair-button-right span {
  font-family: "JetBrains Mono", monospace;
}

.pair-button.selected {
  border-color: rgba(47, 129, 247, 0.36);
  background: rgba(47, 129, 247, 0.08);
}

.chart-toolbar {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.intervals {
  grid-template-columns: repeat(3, auto);
}

.interval-chip.active {
  background: rgba(47, 129, 247, 0.15);
  border-color: rgba(47, 129, 247, 0.32);
}

.toolbar-meta {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--muted);
  font-size: 0.88rem;
}

.chart-shell {
  border: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(13, 17, 23, 0.94), rgba(9, 13, 18, 0.98));
  border-radius: 20px;
  padding: 14px;
}

.chart-caption {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.chart-caption strong {
  display: block;
  margin-top: 6px;
}

.chart-caption small {
  color: var(--muted);
}

.equity-chart,
.candle-chart {
  width: 100%;
  display: block;
}

.grid-line {
  stroke: rgba(139, 148, 158, 0.14);
  stroke-width: 1;
}

.equity-line {
  fill: none;
  stroke: var(--blue);
  stroke-width: 3.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.equity-dot {
  fill: var(--bg);
  stroke: var(--blue);
  stroke-width: 2;
}

.wick {
  stroke-width: 1.4;
}

.wick.up,
.body.up {
  stroke: var(--green);
  fill: rgba(63, 185, 80, 0.8);
}

.wick.down,
.body.down {
  stroke: var(--red);
  fill: rgba(248, 81, 73, 0.8);
}

.ema-line {
  fill: none;
  stroke-width: 2;
}

.ema-line.fast {
  stroke: rgba(47, 129, 247, 0.95);
}

.ema-line.slow {
  stroke: rgba(210, 153, 34, 0.9);
}

.axis-label {
  fill: var(--muted);
}

.account-editor {
  display: grid;
  gap: 10px;
}

.account-editor label {
  color: var(--muted);
  font-size: 0.84rem;
}

.account-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
}

.account-row input {
  border: 1px solid var(--line);
  border-radius: 14px;
  background: rgba(240, 246, 252, 0.03);
  color: var(--text);
  padding: 12px 14px;
}

.account-editor p,
.runtime-meta,
.bookmark p,
.trade-card p,
.empty-state {
  color: var(--muted);
  line-height: 1.6;
  font-size: 0.92rem;
}

.status-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.runtime-meta {
  margin-top: 12px;
  display: grid;
  gap: 6px;
}

.log-list {
  gap: 10px;
}

.log-row {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  gap: 10px;
  padding: 12px;
  border-radius: 14px;
  border: 1px solid rgba(139, 148, 158, 0.12);
  background: rgba(240, 246, 252, 0.02);
}

.trade-list {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.trade-card {
  border: 1px solid var(--line);
  border-radius: 18px;
  background: rgba(240, 246, 252, 0.02);
  padding: 16px;
}

.trade-card.good {
  border-color: rgba(63, 185, 80, 0.26);
}

.trade-card.bad {
  border-color: rgba(248, 81, 73, 0.24);
}

.trade-head,
.trade-grid,
.trade-strip,
.trade-card footer {
  display: grid;
  gap: 10px;
}

.trade-head {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
}

.trade-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: end;
}

.trade-badges span,
.trade-strip span {
  border: 1px solid rgba(139, 148, 158, 0.18);
  border-radius: 999px;
  padding: 6px 8px;
  font-size: 0.78rem;
}

.trade-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 14px 0;
}

.trade-grid div {
  border-radius: 14px;
  border: 1px solid rgba(139, 148, 158, 0.14);
  padding: 12px;
  background: rgba(13, 17, 23, 0.55);
}

.trade-grid strong {
  display: block;
  margin-top: 8px;
  font-family: "JetBrains Mono", monospace;
}

.trade-strip {
  grid-template-columns: repeat(4, auto);
  align-items: center;
  margin-bottom: 12px;
}

.trade-card footer {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(139, 148, 158, 0.12);
  color: var(--muted);
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.bookmark-list {
  gap: 12px;
}

.bookmark {
  padding: 14px;
  border-radius: 16px;
  border: 1px solid rgba(139, 148, 158, 0.14);
  background: rgba(240, 246, 252, 0.02);
}

.table-shell {
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: rgba(13, 17, 23, 0.56);
}

table {
  width: 100%;
  border-collapse: collapse;
}

th,
td {
  padding: 13px 14px;
  border-bottom: 1px solid rgba(139, 148, 158, 0.12);
  text-align: left;
  vertical-align: top;
}

td strong {
  display: block;
}

td small {
  color: var(--muted);
}

tbody tr:hover {
  background: rgba(240, 246, 252, 0.02);
}

.error-banner {
  margin-bottom: 16px;
  padding: 14px 16px;
  border-radius: 16px;
  border: 1px solid rgba(248, 81, 73, 0.24);
  background: rgba(248, 81, 73, 0.08);
  color: #ffb3ad;
}

.empty-state {
  padding: 18px;
  border-radius: 16px;
  border: 1px dashed rgba(139, 148, 158, 0.24);
  background: rgba(240, 246, 252, 0.015);
}

.empty-state.tight {
  padding: 14px;
}

@media (max-width: 1180px) {
  .hero,
  .content-grid,
  .content-grid.lower {
    grid-template-columns: 1fr;
  }

  .strip-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .pair-switcher,
  .trade-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 780px) {
  .workspace {
    width: min(100%, calc(100% - 18px));
    padding: 18px 0 32px;
  }

  .hero-pills,
  .strip-grid,
  .pair-switcher,
  .trade-list,
  .trade-grid,
  .status-grid {
    grid-template-columns: 1fr;
  }

  .head-actions,
  .intervals {
    grid-template-columns: 1fr;
  }

  .account-row,
  .trade-card footer,
  .log-row {
    grid-template-columns: 1fr;
  }

  .pair-button,
  .panel-head,
  .chart-toolbar,
  .chart-caption,
  .trade-head {
    display: block;
  }

  .pair-button-right,
  .trade-badges {
    margin-top: 8px;
    align-items: start;
    justify-content: start;
  }
}
`;
