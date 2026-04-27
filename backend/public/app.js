'use strict';
// APEX V2 — Frontend App (~500 lines)
// Polls backend API, renders all tabs, handles user actions

const API = '';  // Same-origin — backend serves this file

// ── STATE ─────────────────────────────────────────────────────────────────────
let state = {
  settings:     {},
  activePairs:  ['EURUSD','XAUUSD','GBPUSD','USDJPY','AUDUSD','USDCAD'],
  allPairs:     ['EURUSD','XAUUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','NZDUSD','USDCHF','EURJPY','GBPJPY'],
  logFilter:    'all',
};

// ── TABS ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'learning')     loadLearning();
    if (btn.dataset.tab === 'subscribers')  loadSubscribers();
    if (btn.dataset.tab === 'logs')         loadLogs();
    if (btn.dataset.tab === 'analyzer')     loadAnalyzer();
    if (btn.dataset.tab === 'broker')       loadBroker();
  });
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const r = await fetch(API + path, { headers: { 'Content-Type': 'application/json' }, ...options });
  return r.json();
}
const $ = id => document.getElementById(id);
const fmt = (n, decimals = 2) => n == null ? '—' : parseFloat(n).toFixed(decimals);
const fmtMoney = n => n == null ? '—' : `$${parseFloat(n).toFixed(2)}`;
const sydneyTime = () => new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour12: false });

function setDot(id, connected) {
  const el = $(id);
  if (!el) return;
  el.className = 'dot ' + (connected ? 'green' : 'red');
}

function toggleBtn(id, isOn) {
  const el = $(id);
  if (!el) return;
  el.textContent = isOn ? 'ON' : 'OFF';
  el.className = 'toggle-btn ' + (isOn ? 'on' : 'off');
}

// ── STATUS POLL ───────────────────────────────────────────────────────────────
async function pollStatus() {
  try {
    const s = await api('/api/status');
    // Header dots
    setDot('hdr-ctrader',  s.brokerConnected);
    setDot('hdr-telegram', s.telegramConnected);
    $('hdr-time').textContent = s.sydneyTime || sydneyTime();

    // Dashboard
    const pnlEl = $('s-pnl');
    $('s-balance').textContent = fmtMoney(s.balance);
    if (pnlEl) {
      pnlEl.textContent = s.todayPnL != null ? (s.todayPnL >= 0 ? '+' : '') + fmtMoney(s.todayPnL) : '—';
      pnlEl.className = 'stat-value ' + (s.todayPnL > 0 ? 'pos' : s.todayPnL < 0 ? 'neg' : '');
    }
    $('s-wr').textContent     = s.winRate7d != null ? s.winRate7d + '%' : '—';
    $('s-losses').textContent = s.dailyLosses != null ? `${s.dailyLosses}/${s.dailyLossLimit}` : '—';
    $('s-open').textContent   = s.openPositions ?? '—';

    if (s.lastSignal) {
      $('s-last-signal').textContent = `${s.lastSignal.pair} ${s.lastSignal.direction} (${s.lastSignal.tier})`;
    }

    setDot('d-ctrader-dot',  s.brokerConnected);
    setDot('d-telegram-dot', s.telegramConnected);
    const autoEl = $('d-auto-exec');
    if (autoEl) {
      autoEl.textContent = s.autoExecute ? 'ON' : 'OFF';
      autoEl.className = 'badge ' + (s.autoExecute ? 'on' : 'off');
    }

    // Sync settings state
    state.settings = { ...state.settings, autoExecute: s.autoExecute, manualReview: s.manualReview };
    toggleBtn('toggle-auto',   s.autoExecute);
    toggleBtn('toggle-manual', s.manualReview);
    toggleBtn('set-auto-exec',   s.autoExecute);
    toggleBtn('set-manual-review', s.manualReview);

    // Telegram tab status
    setDot('tg-status-dot', s.telegramConnected);
    $('tg-status-text') && ($('tg-status-text').textContent = s.telegramConnected ? 'Connected' : 'Disconnected');
  } catch {}
}

// ── RECENT TRADES ─────────────────────────────────────────────────────────────
async function loadRecentTrades() {
  try {
    const trades = await api('/api/trades/recent');
    const tbody = $('recent-trades-body');
    if (!trades.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No trades yet</td></tr>';
      return;
    }
    tbody.innerHTML = trades.slice(0,10).map(t => `
      <tr>
        <td>${t.symbol || '—'}</td>
        <td>${t.direction || '—'}</td>
        <td>${fmt(t.entry_price, 5)}</td>
        <td>${fmt(t.exit_price, 5)}</td>
        <td class="${t.outcome === 'WIN' ? 'badge-win' : 'badge-loss'}">${t.outcome || '—'}</td>
        <td>${fmt(t.pnl_r, 1)}R</td>
        <td>${t.closed_at ? new Date(t.closed_at).toLocaleString('en-AU',{timeZone:'Australia/Sydney',hour12:false}) : '—'}</td>
      </tr>`).join('');

    // Also fill last-10 in Trading tab
    const l10 = $('last10-body');
    if (l10) {
      l10.innerHTML = trades.slice(0,10).map(t => `
        <tr>
          <td>${t.symbol || '—'}</td>
          <td>${t.direction || '—'}</td>
          <td class="${t.outcome === 'WIN' ? 'badge-win' : 'badge-loss'}">${t.outcome || '—'}</td>
          <td>${fmt(t.pnl_r, 1)}R</td>
          <td>${t.exit_reason || '—'}</td>
        </tr>`).join('');
    }
  } catch {}
}

// ── OPEN POSITIONS ────────────────────────────────────────────────────────────
async function loadOpenPositions() {
  try {
    const pos = await api('/api/trades/open');
    const tbody = $('open-positions-body');
    if (!pos.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No open positions</td></tr>';
      return;
    }
    tbody.innerHTML = pos.map(p => `
      <tr>
        <td>${p.symbol || '—'}</td>
        <td>${p.tradeSide || p.direction || '—'}</td>
        <td>${fmt(p.entryPrice || p.entry_price, 5)}</td>
        <td>${fmt(p.stopLoss || p.stop_loss, 5)}</td>
        <td>${fmt(p.takeProfit || p.tp1, 5)}</td>
        <td>${fmt(p.volume || p.size, 2)}</td>
        <td>${fmtMoney(p.pnl)}</td>
      </tr>`).join('');
  } catch {}
}

// ── ANALYZER ─────────────────────────────────────────────────────────────────
async function loadAnalyzer() {
  try {
    const data = await api('/api/analyzer');
    const grid = $('analyzer-grid');
    grid.innerHTML = data.map(d => `
      <div class="analyzer-card">
        <div class="pair-name">${d.pair}</div>
        <div class="pair-stat"><span class="label">Status</span><span>${d.status}</span></div>
        ${d.data ? `
        <div class="pair-stat"><span class="label">Regime</span><span>${d.data.regime || '—'}</span></div>
        <div class="pair-stat"><span class="label">Session</span><span>${d.data.session || '—'}</span></div>
        <div class="pair-stat"><span class="label">News Block</span><span>${d.data.newsBlackout ? 'YES' : 'NO'}</span></div>
        ` : ''}
      </div>`).join('');
  } catch {
    $('analyzer-grid').innerHTML = '<p class="empty">Analyzer unavailable</p>';
  }
}

// ── PAIRS ─────────────────────────────────────────────────────────────────────
function renderPairs() {
  const grid = $('pairs-grid');
  grid.innerHTML = state.allPairs.map(p => `
    <label class="pair-checkbox">
      <input type="checkbox" value="${p}" ${state.activePairs.includes(p) ? 'checked' : ''}>
      ${p}
    </label>`).join('');
}

$('btn-save-pairs')?.addEventListener('click', async () => {
  const checked = [...document.querySelectorAll('#pairs-grid input:checked')].map(i => i.value);
  state.activePairs = checked;
  await api('/api/pairs/update', { method: 'POST', body: JSON.stringify({ pairs: checked }) });
  showMsg('settings-msg', 'Pairs saved');
});

// ── SETTINGS ─────────────────────────────────────────────────────────────────
function initSliders() {
  const sliders = [
    { id: 'sl-diamond',      valId: 'val-diamond-risk',   key: 'diamondRisk' },
    { id: 'sl-gold',         valId: 'val-gold-risk',      key: 'goldRisk' },
    { id: 'sl-silver',       valId: 'val-silver-risk',    key: 'silverRisk' },
    { id: 'sl-diamond-conv', valId: 'val-diamond-conv',   key: 'diamondConviction' },
    { id: 'sl-gold-conv',    valId: 'val-gold-conv',      key: 'goldConviction' },
    { id: 'sl-silver-conv',  valId: 'val-silver-conv',    key: 'silverConviction' },
    { id: 'sl-daily-loss',   valId: 'val-daily-loss',     key: 'dailyLossLimit' },
  ];
  sliders.forEach(({ id, valId }) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => { $(valId).textContent = el.value; });
  });
}

function makeToggle(btnId, stateKey) {
  const btn = $(btnId);
  if (!btn) return;
  btn.addEventListener('click', () => {
    state.settings[stateKey] = !state.settings[stateKey];
    toggleBtn(btnId, state.settings[stateKey]);
  });
}

makeToggle('set-auto-exec',     'autoExecute');
makeToggle('set-manual-review', 'manualReview');
makeToggle('set-live-mode',     'liveMode');
makeToggle('toggle-auto',       'autoExecute');
makeToggle('toggle-manual',     'manualReview');

$('btn-save-settings')?.addEventListener('click', async () => {
  const body = {
    diamondRisk:       parseFloat($('sl-diamond')?.value),
    goldRisk:          parseFloat($('sl-gold')?.value),
    silverRisk:        parseFloat($('sl-silver')?.value),
    diamondConviction: parseFloat($('sl-diamond-conv')?.value),
    goldConviction:    parseFloat($('sl-gold-conv')?.value),
    silverConviction:  parseFloat($('sl-silver-conv')?.value),
    dailyLossLimit:    parseFloat($('sl-daily-loss')?.value),
    autoExecute:       state.settings.autoExecute,
    manualReview:      state.settings.manualReview,
    liveMode:          state.settings.liveMode,
  };
  try {
    await api('/api/settings/update', { method: 'POST', body: JSON.stringify(body) });
    showMsg('settings-msg', 'Settings saved');
  } catch {
    showMsg('settings-msg', 'Save failed', true);
  }
});

// ── SCAN NOW ──────────────────────────────────────────────────────────────────
$('btn-scan-now')?.addEventListener('click', async () => {
  $('btn-scan-now').textContent = 'Scanning...';
  $('btn-scan-now').disabled = true;
  try {
    const r = await api('/api/scan/manual', { method: 'POST' });
    $('btn-scan-now').textContent = `Done — ${r.signals} signal(s)`;
  } catch {
    $('btn-scan-now').textContent = 'Error';
  }
  setTimeout(() => { $('btn-scan-now').textContent = 'Manual Scan Now'; $('btn-scan-now').disabled = false; }, 3000);
});

// ── LEARNING ─────────────────────────────────────────────────────────────────
async function loadLearning() {
  try {
    const results = await api('/api/learning/results');
    const container = $('learning-results');
    if (!results.length) {
      container.innerHTML = '<p class="empty">No learning cycles completed yet.</p>';
      return;
    }

    // Group by analysis_date
    const byDate = {};
    for (const r of results) {
      const key = r.analysis_date?.split('T')[0] || 'unknown';
      if (!byDate[key]) byDate[key] = [];
      byDate[key].push(r);
    }

    container.innerHTML = Object.entries(byDate).slice(0, 5).map(([date, rows]) => {
      const insights  = JSON.parse(rows[0]?.insights || '[]');
      const suggested = JSON.parse(rows[0]?.suggested_changes || '[]');
      return `
        <div class="learning-cycle">
          <h4>Cycle: ${date}</h4>
          <strong style="font-size:.7rem;color:var(--muted)">INSIGHTS</strong>
          <ul class="insight-list">
            ${insights.map(i => `<li>${i}</li>`).join('')}
          </ul>
          ${suggested.length ? `
          <strong style="font-size:.7rem;color:var(--muted);display:block;margin-top:.75rem">SUGGESTED CHANGES</strong>
          ${suggested.map((s, idx) => `
            <div class="suggestion-card">
              <p>${s.reason} <em style="color:var(--muted)">(${s.confidence} confidence)</em></p>
              <div class="suggestion-actions">
                <button class="btn-primary" onclick="approveSuggestion(${rows[0].id}, true)">Apply</button>
                <button class="btn-secondary" onclick="approveSuggestion(${rows[0].id}, false)">Reject</button>
              </div>
            </div>`).join('')}
          ` : ''}
        </div>`;
    }).join('');
  } catch {
    $('learning-results').innerHTML = '<p class="empty">Could not load learning results</p>';
  }
}

window.approveSuggestion = async (id, approved) => {
  await api('/api/learning/approve', { method: 'POST', body: JSON.stringify({ patternId: id, approved }) });
  loadLearning();
};

$('btn-run-learning')?.addEventListener('click', async () => {
  $('btn-run-learning').textContent = 'Running...';
  $('btn-run-learning').disabled = true;
  try {
    await api('/api/learning/run', { method: 'POST' });
    await loadLearning();
  } catch {}
  $('btn-run-learning').textContent = 'Run Now';
  $('btn-run-learning').disabled = false;
});

// ── TELEGRAM ─────────────────────────────────────────────────────────────────
$('btn-tg-test')?.addEventListener('click', async () => {
  $('btn-tg-test').textContent = 'Sending...';
  try {
    const r = await api('/api/telegram/test', { method: 'POST' });
    showMsg('tg-msg', r.success ? 'Test message sent' : 'Failed — check token/group');
    setDot('tg-status-dot', r.connected);
    $('tg-status-text') && ($('tg-status-text').textContent = r.connected ? 'Connected' : 'Disconnected');
  } catch {
    showMsg('tg-msg', 'Request failed', true);
  }
  $('btn-tg-test').textContent = 'Test Send';
});

// ── SUBSCRIBERS ───────────────────────────────────────────────────────────────
async function loadSubscribers() {
  try {
    const data = await api('/api/subscribers');
    $('sub-count').textContent   = data.total || 0;
    $('sub-revenue').textContent = `$${data.revenue || 0}`;

    const tbody = $('sub-table-body');
    if (!data.subscribers?.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No subscribers yet</td></tr>';
      return;
    }
    tbody.innerHTML = data.subscribers.map(s => `
      <tr>
        <td>${s.email}</td>
        <td>${s.tier}</td>
        <td>${s.joined_date ? new Date(s.joined_date).toLocaleDateString() : '—'}</td>
        <td class="${s.status === 'active' ? 'badge-win' : 'badge-loss'}">${s.status}</td>
        <td><button onclick="removeSub(${s.id})" style="background:none;border:none;color:var(--red);cursor:pointer;font-family:inherit">Remove</button></td>
      </tr>`).join('');
  } catch {}
}

$('btn-add-sub')?.addEventListener('click', () => {
  $('add-sub-form').classList.toggle('hidden');
});

$('btn-sub-save')?.addEventListener('click', async () => {
  const email = $('sub-email')?.value?.trim();
  const tier  = $('sub-tier')?.value;
  if (!email) return;
  await api('/api/subscribers/add', { method: 'POST', body: JSON.stringify({ email, tier }) });
  $('add-sub-form').classList.add('hidden');
  $('sub-email').value = '';
  loadSubscribers();
});

window.removeSub = async (id) => {
  await api(`/api/subscribers/${id}`, { method: 'DELETE' });
  loadSubscribers();
};

// ── LOGS ─────────────────────────────────────────────────────────────────────
async function loadLogs() {
  try {
    const type = state.logFilter !== 'all' ? `?type=${state.logFilter}` : '';
    const logs = await api(`/api/logs${type}`);
    const list = $('logs-list');
    if (!logs.length) { list.innerHTML = '<p class="empty">No logs yet</p>'; return; }
    list.innerHTML = logs.map(l => `
      <div class="log-item ${l.type}">
        <span class="log-ts">${l.timestamp ? new Date(l.timestamp).toLocaleString('en-AU',{timeZone:'Australia/Sydney',hour12:false}) : '—'}</span>
        <span class="log-type">${l.type}</span>
        <span class="log-msg">${l.message}${l.symbol ? ` [${l.symbol}]` : ''}</span>
      </div>`).join('');
  } catch {}
}

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.logFilter = btn.dataset.filter;
    loadLogs();
  });
});

// ── MT4/MT5 BROKER ───────────────────────────────────────────────────────────
async function loadBroker() {
  try {
    const r = await api('/api/broker/status');
    setDot('ct-status-dot', r.connected);
    $('ct-status-text').textContent = r.connected ? 'Connected' : 'Disconnected';
    $('ct-platform').textContent    = r.platform ? r.platform.toUpperCase() : '';
    $('ct-account-id').textContent  = r.accountId || '—';
    $('ct-balance').textContent     = fmtMoney(r.balance);
    $('ct-equity').textContent      = fmtMoney(r.equity);
    $('ct-last-sync').textContent   = r.lastSync ? new Date(r.lastSync).toLocaleString('en-AU',{timeZone:'Australia/Sydney',hour12:false}) : '—';
  } catch {}
}

$('btn-ct-reconnect')?.addEventListener('click', async () => {
  $('btn-ct-reconnect').textContent = 'Reconnecting...';
  $('btn-ct-reconnect').disabled = true;
  try {
    const r = await api('/api/broker/reconnect', { method: 'POST' });
    setDot('ct-status-dot', r.connected);
    $('ct-status-text').textContent = r.connected ? 'Connected' : 'Disconnected';
  } catch {}
  $('btn-ct-reconnect').textContent = 'Reconnect';
  $('btn-ct-reconnect').disabled = false;
});

// ── UTIL ─────────────────────────────────────────────────────────────────────
function showMsg(id, text, isErr = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'msg' + (isErr ? ' err' : '');
  setTimeout(() => { el.textContent = ''; }, 4000);
}

// ── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  initSliders();
  renderPairs();

  // Load settings from backend
  try {
    const s = await api('/api/settings');
    if (s.diamondRisk)    { $('sl-diamond').value = s.diamondRisk;     $('val-diamond-risk').textContent = s.diamondRisk; }
    if (s.goldRisk)       { $('sl-gold').value = s.goldRisk;           $('val-gold-risk').textContent = s.goldRisk; }
    if (s.silverRisk)     { $('sl-silver').value = s.silverRisk;       $('val-silver-risk').textContent = s.silverRisk; }
    if (s.dailyLossLimit) { $('sl-daily-loss').value = s.dailyLossLimit; $('val-daily-loss').textContent = s.dailyLossLimit; }
    state.settings = s;
    toggleBtn('set-live-mode', s.liveMode);
  } catch {}

  await pollStatus();
  await loadRecentTrades();

  // Poll every 30 seconds
  setInterval(async () => {
    await pollStatus();
    if (document.querySelector('.tab-btn[data-tab="dashboard"].active')) {
      await loadRecentTrades();
    }
    if (document.querySelector('.tab-btn[data-tab="trading"].active')) {
      await loadOpenPositions();
      await loadRecentTrades();
    }
  }, 30000);
}

init();
