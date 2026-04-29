import { useEffect, useState } from "react";

const TARGET_PAIRS = ["EURUSD", "USDCHF", "GBPJPY", "EURJPY", "XAUUSD"];

const fmtPrice = (value, symbol) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (symbol === "XAUUSD") return n.toFixed(2);
  if (symbol?.includes("JPY")) return n.toFixed(3);
  return n.toFixed(5);
};

const fmtDate = (value) => {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString([], { hour12: false });
};

const api = async (path, options = {}) => {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed: ${res.status}`);
  return json;
};

function StatusPill({ label, value, tone = "neutral" }) {
  return (
    <div className={`status-pill ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Metric({ label, value, sub }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {sub ? <small>{sub}</small> : null}
    </div>
  );
}

function SignalCard({ signal }) {
  const direction = signal.direction || signal.signal_type || "WAIT";
  const tier = signal.confidence_tier || "UNKNOWN";
  const isTrade = ["BUY", "SELL"].includes(direction);

  return (
    <article className={`signal-card ${String(direction).toLowerCase()}`}>
      <div className="signal-head">
        <div>
          <span className="eyebrow">{signal.symbol || "UNKNOWN"}</span>
          <h3>{direction}</h3>
        </div>
        <div className="signal-badges">
          <span>{tier}</span>
          <span>{signal.entry_type || "NO_TYPE"}</span>
        </div>
      </div>

      <div className="price-grid">
        <div>
          <span>Entry</span>
          <strong>{fmtPrice(signal.entry_price, signal.symbol)}</strong>
        </div>
        <div>
          <span>Stop</span>
          <strong>{fmtPrice(signal.stop_loss, signal.symbol)}</strong>
        </div>
        <div>
          <span>TP1</span>
          <strong>{fmtPrice(signal.tp1, signal.symbol)}</strong>
        </div>
        <div>
          <span>TP2</span>
          <strong>{fmtPrice(signal.tp2, signal.symbol)}</strong>
        </div>
      </div>

      <div className="signal-meta">
        <span>Confluence {signal.confluence_score ?? "-"}/6</span>
        <span>AI {signal.ai_conviction ?? 0}%</span>
        <span>{signal.regime || "NO_REGIME"}</span>
        <span>{signal.session || "NO_SESSION"}</span>
      </div>

      <p className="reason">
        {signal.ai_reasoning || signal.reason || (isTrade ? "Validated trade signal." : "No trade executed.")}
      </p>

      <footer>
        <span>Created {fmtDate(signal.created_at || signal.detected_at)}</span>
        <span>Valid until {fmtDate(signal.valid_until)}</span>
      </footer>
    </article>
  );
}

function PairTile({ symbol, market, busy, onMarket, onScan, onTelegram }) {
  return (
    <div className="pair-tile">
      <div>
        <span className="eyebrow">{symbol}</span>
        <strong>{market?.price ? fmtPrice(market.price.price, symbol) : "Waiting"}</strong>
        <small>
          {market?.provider ? `${market.provider}${market.live ? " live" : " fallback"}` : "No tick yet"}
        </small>
      </div>
      <div className="pair-actions">
        <button disabled={busy} onClick={() => onMarket(symbol)}>Price</button>
        <button disabled={busy} onClick={() => onScan(symbol)}>Scan</button>
        <button disabled={busy} onClick={() => onTelegram(symbol)}>Telegram</button>
      </div>
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [pairs, setPairs] = useState([]);
  const [activeSignals, setActiveSignals] = useState([]);
  const [history, setHistory] = useState([]);
  const [markets, setMarkets] = useState({});
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [error, setError] = useState("");

  const pushLog = (message) => {
    setLog((rows) => [{ at: new Date().toISOString(), message }, ...rows].slice(0, 10));
  };

  const refresh = async () => {
    try {
      setError("");
      const [s, p, a, h] = await Promise.all([
        api("/api/status"),
        api("/api/pairs"),
        api("/api/signals/active"),
        api("/api/signals/history?limit=20"),
      ]);
      setStatus(s);
      setPairs(p.pairs || []);
      setActiveSignals(a.signals || []);
      setHistory(h.signals || []);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, []);

  const loadMarket = async (symbol) => {
    setBusy(true);
    try {
      const result = await api(`/api/market/${symbol}`);
      setMarkets((m) => ({ ...m, [symbol]: result }));
      pushLog(`${symbol} price loaded from ${result.provider}`);
    } catch (e) {
      setError(e.message);
      pushLog(`${symbol} price failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const scanPair = async (symbol) => {
    setBusy(true);
    try {
      const result = await api(`/api/pipeline/${symbol}`, { method: "POST" });
      const stage = result.result?.stage || "unknown";
      const sent = result.result?.sent ? "Telegram sent" : "No Telegram signal";
      pushLog(`${symbol} scan complete: ${stage}, ${sent}`);
      await refresh();
    } catch (e) {
      setError(e.message);
      pushLog(`${symbol} scan failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const testTelegram = async (symbol) => {
    setBusy(true);
    try {
      const result = await api("/api/telegram/test", {
        method: "POST",
        body: JSON.stringify({ symbol }),
      });
      pushLog(`${symbol} Telegram test ${result.success ? "sent" : "failed"} using ${result.price?.source}`);
    } catch (e) {
      setError(e.message);
      pushLog(`Telegram test failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const activePairSymbols = pairs.filter((p) => p.active).map((p) => p.symbol);
  const targetPairs = TARGET_PAIRS.map((symbol) => pairs.find((p) => p.symbol === symbol) || { symbol, active: activePairSymbols.includes(symbol) });

  return (
    <>
      <style>{styles}</style>
      <main className="shell">
        <section className="hero">
          <div>
            <span className="eyebrow">APEX V3 DEMO COMMAND</span>
            <h1>Live signal desk</h1>
            <p>
              Real market data checks, target-growth policy filtering, Telegram delivery, and demo-account monitoring from one dashboard.
            </p>
          </div>
          <div className="hero-panel">
            <StatusPill label="Server" value={status?.status || "Loading"} tone="good" />
            <StatusPill label="Telegram" value={status?.telegram || "-"} tone={status?.telegram === "CONNECTED" ? "good" : "warn"} />
            <StatusPill label="AI" value={status?.ai || "-"} tone={status?.ai === "LIVE" ? "good" : "warn"} />
            <StatusPill label="Mode" value={status?.mode || "-"} tone={status?.mode === "PAPER" ? "good" : "warn"} />
          </div>
        </section>

        {error ? <div className="error">{error}</div> : null}

        <section className="metrics">
          <Metric label="UTC Time" value={status?.time?.utc?.split(", ").pop() || "-"} sub={status?.time?.utc || ""} />
          <Metric label="Sydney Time" value={status?.time?.sydney?.split(", ").pop() || "-"} sub={status?.time?.sydney || ""} />
          <Metric label="Live Policy" value={status?.livePolicy || "-"} sub="Current production filter" />
          <Metric label="Active Pairs" value={activePairSymbols.length || 0} sub={activePairSymbols.join(", ") || "None"} />
        </section>

        <section className="grid">
          <div className="panel span-7">
            <div className="panel-head">
              <div>
                <span className="eyebrow">TARGET PAIRS</span>
                <h2>Execution controls</h2>
              </div>
              <button className="ghost" onClick={refresh} disabled={busy}>Refresh</button>
            </div>
            <div className="pair-grid">
              {targetPairs.map((pair) => (
                <PairTile
                  key={pair.symbol}
                  symbol={pair.symbol}
                  market={markets[pair.symbol]}
                  busy={busy}
                  onMarket={loadMarket}
                  onScan={scanPair}
                  onTelegram={testTelegram}
                />
              ))}
            </div>
          </div>

          <div className="panel span-5">
            <div className="panel-head">
              <div>
                <span className="eyebrow">SYSTEM LOG</span>
                <h2>Latest actions</h2>
              </div>
            </div>
            <div className="log-list">
              {log.length ? log.map((row) => (
                <div className="log-row" key={`${row.at}-${row.message}`}>
                  <span>{new Date(row.at).toLocaleTimeString([], { hour12: false })}</span>
                  <p>{row.message}</p>
                </div>
              )) : <p className="empty">No actions yet. Run a price check or Telegram test.</p>}
            </div>
          </div>
        </section>

        <section className="grid">
          <div className="panel span-7">
            <div className="panel-head">
              <div>
                <span className="eyebrow">ACTIVE SIGNALS</span>
                <h2>Signals being watched</h2>
              </div>
            </div>
            <div className="signal-list">
              {activeSignals.length ? activeSignals.map((signal) => <SignalCard key={signal.id || `${signal.symbol}-${signal.created_at}`} signal={signal} />) : (
                <p className="empty">No active signals right now. Cron scans every 15 minutes.</p>
              )}
            </div>
          </div>

          <div className="panel span-5">
            <div className="panel-head">
              <div>
                <span className="eyebrow">HISTORY</span>
                <h2>Recent decisions</h2>
              </div>
            </div>
            <div className="history-list">
              {history.length ? history.map((signal) => (
                <div className="history-row" key={signal.id || `${signal.symbol}-${signal.created_at}`}>
                  <div>
                    <strong>{signal.symbol}</strong>
                    <span>{signal.signal_type || signal.direction || "NO_TRADE"}</span>
                  </div>
                  <small>{fmtDate(signal.created_at)}</small>
                </div>
              )) : <p className="empty">No closed/rejected decisions yet.</p>}
            </div>
          </div>
        </section>
      </main>
    </>
  );
}

const styles = `
@import url('https://fonts.googleapis.com/css2?family=Barlow:ital,wght@0,400;0,600;0,700;0,800;1,500&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');

:root {
  --bg: #080806;
  --panel: rgba(18, 18, 14, 0.82);
  --panel-strong: #12120f;
  --line: rgba(234, 214, 161, 0.12);
  --text: #f3ead4;
  --muted: #918a77;
  --dim: #5e584b;
  --gold: #d6a94a;
  --green: #4ed6a3;
  --red: #e8665d;
  --blue: #80b7ff;
  --warn: #e7bd62;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  min-width: 320px;
  color: var(--text);
  background:
    radial-gradient(circle at top left, rgba(214, 169, 74, 0.18), transparent 32rem),
    radial-gradient(circle at 90% 12%, rgba(78, 214, 163, 0.1), transparent 28rem),
    linear-gradient(145deg, #060604 0%, #10100c 52%, #060604 100%);
  font-family: Barlow, sans-serif;
}

button {
  font: inherit;
}

.shell {
  width: min(1440px, calc(100% - 32px));
  margin: 0 auto;
  padding: 28px 0 48px;
}

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.7fr);
  gap: 22px;
  align-items: stretch;
  margin-bottom: 20px;
}

.hero > div:first-child,
.hero-panel,
.panel,
.metric-card {
  border: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(22, 22, 18, 0.92), rgba(10, 10, 8, 0.92));
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(18px);
}

.hero > div:first-child {
  border-radius: 28px;
  padding: 34px;
  min-height: 230px;
  position: relative;
  overflow: hidden;
}

.hero > div:first-child::after {
  content: "";
  position: absolute;
  right: -90px;
  bottom: -90px;
  width: 260px;
  height: 260px;
  border: 1px solid rgba(214, 169, 74, 0.22);
  border-radius: 50%;
}

.eyebrow {
  display: inline-block;
  color: var(--gold);
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.72rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

h1, h2, h3, p { margin: 0; }
h1 {
  margin-top: 14px;
  max-width: 760px;
  font-size: clamp(3rem, 7vw, 6.9rem);
  line-height: 0.86;
  letter-spacing: -0.07em;
  text-transform: uppercase;
}

h2 {
  margin-top: 7px;
  font-size: 1.45rem;
  letter-spacing: -0.03em;
}

.hero p {
  margin-top: 18px;
  max-width: 680px;
  color: var(--muted);
  font-size: 1.05rem;
  line-height: 1.6;
}

.hero-panel {
  border-radius: 28px;
  padding: 20px;
  display: grid;
  gap: 10px;
}

.status-pill {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.025);
}

.status-pill span,
.metric-card span,
.price-grid span,
.signal-meta span,
.history-row small,
.log-row span,
.signal-card footer {
  color: var(--dim);
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.74rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.status-pill strong { font-size: 0.9rem; }
.status-pill.good strong { color: var(--green); }
.status-pill.warn strong { color: var(--warn); }

.metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 20px;
}

.metric-card {
  border-radius: 22px;
  padding: 20px;
  min-height: 124px;
}

.metric-card strong {
  display: block;
  margin-top: 12px;
  font-size: clamp(1.6rem, 3vw, 2.5rem);
  line-height: 1;
}

.metric-card small {
  display: block;
  margin-top: 8px;
  color: var(--muted);
  font-size: 0.86rem;
  line-height: 1.35;
}

.grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 18px;
  margin-bottom: 18px;
}

.span-7 { grid-column: span 7; }
.span-5 { grid-column: span 5; }

.panel {
  border-radius: 26px;
  padding: 22px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}

.ghost,
.pair-actions button {
  border: 1px solid rgba(214, 169, 74, 0.24);
  border-radius: 999px;
  color: var(--text);
  background: rgba(214, 169, 74, 0.08);
  padding: 10px 14px;
  cursor: pointer;
}

.ghost:disabled,
.pair-actions button:disabled {
  opacity: 0.55;
  cursor: wait;
}

.pair-grid,
.signal-list,
.history-list,
.log-list {
  display: grid;
  gap: 12px;
}

.pair-tile {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  align-items: center;
  border: 1px solid rgba(234, 214, 161, 0.1);
  border-radius: 20px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.025);
}

.pair-tile strong {
  display: block;
  margin-top: 6px;
  font-size: 1.85rem;
  letter-spacing: -0.03em;
}

.pair-tile small {
  color: var(--muted);
}

.pair-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.pair-actions button {
  padding: 8px 11px;
  font-size: 0.82rem;
}

.signal-card {
  border: 1px solid rgba(234, 214, 161, 0.12);
  border-radius: 22px;
  padding: 18px;
  background: rgba(255, 255, 255, 0.025);
}

.signal-card.buy { border-color: rgba(78, 214, 163, 0.34); }
.signal-card.sell { border-color: rgba(232, 102, 93, 0.34); }

.signal-head,
.signal-card footer,
.history-row,
.log-row {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  align-items: center;
}

.signal-head h3 {
  margin-top: 4px;
  font-size: 2rem;
  letter-spacing: -0.04em;
}

.signal-badges {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 7px;
}

.signal-badges span {
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
  padding: 7px 10px;
  color: var(--muted);
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.72rem;
}

.price-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin: 16px 0;
}

.price-grid div {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 12px;
  background: rgba(0, 0, 0, 0.16);
}

.price-grid strong {
  display: block;
  margin-top: 7px;
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.94rem;
}

.signal-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.signal-meta span {
  border: 1px solid rgba(214, 169, 74, 0.14);
  border-radius: 999px;
  padding: 6px 8px;
}

.reason {
  color: var(--muted);
  margin-top: 14px;
  line-height: 1.55;
}

.signal-card footer {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  text-transform: none;
  letter-spacing: 0;
}

.history-row,
.log-row {
  border: 1px solid rgba(234, 214, 161, 0.1);
  border-radius: 16px;
  padding: 13px;
  background: rgba(255, 255, 255, 0.02);
}

.history-row strong {
  margin-right: 9px;
}

.history-row span {
  color: var(--muted);
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.8rem;
}

.log-row {
  align-items: flex-start;
}

.log-row p {
  color: var(--muted);
  line-height: 1.45;
  text-align: right;
}

.empty,
.error {
  border: 1px dashed rgba(214, 169, 74, 0.22);
  border-radius: 18px;
  color: var(--muted);
  padding: 18px;
  line-height: 1.5;
  background: rgba(0, 0, 0, 0.12);
}

.error {
  border-color: rgba(232, 102, 93, 0.4);
  color: #ffd6d2;
  margin-bottom: 18px;
}

@media (max-width: 980px) {
  .hero,
  .metrics,
  .grid {
    grid-template-columns: 1fr;
  }

  .span-7,
  .span-5 {
    grid-column: span 1;
  }

  .price-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .shell {
    width: min(100% - 20px, 1440px);
    padding-top: 12px;
  }

  .hero > div:first-child,
  .hero-panel,
  .panel,
  .metric-card {
    border-radius: 20px;
    padding: 18px;
  }

  .pair-tile,
  .signal-head,
  .signal-card footer,
  .history-row,
  .log-row {
    grid-template-columns: 1fr;
    flex-direction: column;
    align-items: flex-start;
  }

  .pair-actions {
    justify-content: flex-start;
  }

  .price-grid {
    grid-template-columns: 1fr;
  }
}
`;
