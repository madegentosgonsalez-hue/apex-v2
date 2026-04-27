'use strict';
// APEX V2 — Frontend App
// Polls backend API, renders all tabs, handles user actions

const API = '';  // same-origin — backend serves this file

// ── STATE ─────────────────────────────────────────────────────────────────────
let state = {
  settings:    {},
  activePairs: ['EURUSD','XAUUSD','GBPUSD','USDJPY','AUDUSD','USDCAD'],
  allPairs:    ['EURUSD','XAUUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','NZDUSD','USDCHF','EURJPY','GBPJPY'],
  logFilter:   'all',
  tvWidgets:   {},   // container id → widget instance placeholder
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmt = (n, d = 2) => n == null ? '—' : parseFloat(n).toFixed(d);
const fmtMoney = n => n == null ? '—' : `$${parseFloat(n).toFixed(2)}`;
const sydneyNow = () => new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour12: false });

async function apiFetch(path, options = {}) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 35000);
  try {
    const r    = await fetch(API + path, {
      headers: { 'Content-Type': 'application/json' },
      signal:  ctrl.signal,
      ...options,
    });
    clearTimeout(timer);
    const text = await r.text();
    try { return JSON.parse(text); }
    catch { return { _error: true, _status: r.status, _raw: text.slice(0, 200) }; }
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function setDot(id, connected) {
  const el = $(id);
  if (!el) return;
  el.className = 'dot ' + (connected ? 'green' : 'red');
}

function toggleBtn(id, isOn) {
  const el = $(id);
  if (!el) return;
  el.textContent = isOn ? 'ON' : 'OFF';
  el.className   = 'toggle-btn ' + (isOn ? 'on' : 'off');
}

function showMsg(id, text, isErr = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className   = 'msg' + (isErr ? ' err' : '');
  setTimeout(() => { el.textContent = ''; }, 4000);
}

function flash(id) {
  const el = $(id);
  if (!el) return;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 600);
}

// ── COUNTDOWN ─────────────────────────────────────────────────────────────────
function getSecondsToNextScan() {
  const now  = new Date();
  const minsIntoInterval = now.getMinutes() % 15;
  return (15 - minsIntoInterval) * 60 - now.getSeconds();
}

function fmtCountdown(secs) {
  return `${String(Math.floor(secs / 60)).padStart(2,'0')}:${String(secs % 60).padStart(2,'0')}`;
}

function updateCountdown() {
  const secs = getSecondsToNextScan();
  const str  = fmtCountdown(secs);
  const cls  = secs < 60 ? ' urgent' : '';

  // Header countdown
  const hdr = $('countdown');
  if (hdr) { hdr.textContent = str; hdr.className = 'countdown' + cls; }

  // Activity panel countdown
  const ap = $('ap-countdown');
  if (ap)  { ap.textContent  = str; ap.className  = 'ap-countdown' + cls; }
}

// ── ACTIVITY PANEL — BRAIN CARDS + PAIR DOTS ─────────────────────────────────
function setBrainCard(id, active, statusText) {
  const card = $(id);
  if (!card) return;
  card.className = 'brain-card' + (active ? ' active' : '');
  const st = card.querySelector('.bc-status');
  if (st) st.textContent = statusText;
}

function renderPairDots(activePairs, currentPair, completedPairs, errorPairs, scanning) {
  const container = $('pair-dots');
  if (!container) return;
  if (!activePairs || !activePairs.length) {
    container.innerHTML = '<span style="color:#555;font-size:.7rem">—</span>';
    return;
  }
  container.innerHTML = activePairs.map(pair => {
    let cls = 'pair-dot pending';
    if (!scanning && (!completedPairs || !completedPairs.length)) cls = 'pair-dot pending';
    else if (pair === currentPair) cls = 'pair-dot scanning';
    else if (errorPairs && errorPairs.includes(pair)) cls = 'pair-dot error';
    else if (completedPairs && completedPairs.includes(pair)) cls = 'pair-dot done';
    return `<div class="${cls}">${pair}</div>`;
  }).join('');
}

let scanStateCache = {};

async function pollScanState() {
  try {
    const s = await apiFetch('/api/scan/state');
    scanStateCache = s;

    // Brain 1
    setBrainCard('bc1',
      s.scanning,
      s.scanning ? `SCANNING → ${s.currentPair || '...'}` : 'IDLE'
    );

    // Brain 2
    setBrainCard('bc2',
      s.brain2Active,
      s.brain2Active ? 'MONITORING POSITIONS' : 'IDLE'
    );

    // Brain 3
    setBrainCard('bc3',
      s.brain3Active,
      s.brain3Active ? 'CHECKING EXITS' : 'IDLE'
    );

    // Last scan time
    const lastEl = $('ap-last-scan');
    if (lastEl && s.lastScanAt) {
      const d = new Date(s.lastScanAt);
      lastEl.textContent = 'last ' + d.toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour12: false });
    }

    // Pair dots
    renderPairDots(s.activePairs, s.currentPair, s.completedPairs, s.errorPairs, s.scanning);

    // Sync activePairs for other UI
    if (s.activePairs) state.activePairs = s.activePairs;

  } catch {}
}

// ── TABS ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    const tab = btn.dataset.tab;
    if (tab === 'charts')      initChartTab();
    if (tab === 'signals')     loadSignals();
    if (tab === 'learning')    loadLearning();
    if (tab === 'subscribers') loadSubscribers();
    if (tab === 'logs')        loadLogs();
    if (tab === 'analyzer')    loadAnalyzer();
    if (tab === 'broker')      loadBroker();
  });
});

// ── TRADINGVIEW WIDGET ────────────────────────────────────────────────────────
const tvSymbol = {
  EURUSD: 'FX:EURUSD',
  XAUUSD: 'TVC:GOLD',
  GBPUSD: 'FX:GBPUSD',
  USDJPY: 'FX:USDJPY',
  AUDUSD: 'FX:AUDUSD',
  USDCAD: 'FX:USDCAD',
  NZDUSD: 'FX:NZDUSD',
  USDCHF: 'FX:USDCHF',
  EURJPY: 'FX:EURJPY',
  GBPJPY: 'FX:GBPJPY',
};

let tvWidgetIdx = 0;

function initTVWidget(containerId, symbol, interval) {
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = '';

  // TradingView requires a unique inner div ID each time
  const innerId = `tv_inner_${++tvWidgetIdx}`;
  const inner   = document.createElement('div');
  inner.id      = innerId;
  inner.style.cssText = 'width:100%;height:100%';
  container.appendChild(inner);

  if (typeof TradingView === 'undefined') {
    inner.innerHTML = '<p class="empty" style="padding-top:5rem">TradingView script loading — try again in a moment</p>';
    return;
  }

  try {
    new TradingView.widget({
      autosize:          true,
      symbol:            symbol,
      interval:          interval || '60',
      timezone:          'Australia/Sydney',
      theme:             'dark',
      style:             '1',
      locale:            'en',
      toolbar_bg:        '#0e0e0e',
      enable_publishing: false,
      save_image:        false,
      hide_top_toolbar:  false,
      container_id:      innerId,
    });
  } catch (e) {
    inner.innerHTML = `<p class="empty" style="padding-top:5rem">Chart error: ${e.message}</p>`;
  }
}

// Dashboard mini chart
function initDashChart() {
  const sym = $('dash-chart-pair')?.value || 'FX:EURUSD';
  initTVWidget('dash-tv-container', sym, '60');
}

// Charts tab
function initChartTab() {
  const sym = $('chart-pair')?.value || 'FX:EURUSD';
  const tf  = $('chart-tf')?.value || '60';
  initTVWidget('main-tv-container', sym, tf);
}

$('dash-chart-pair')?.addEventListener('change', initDashChart);
$('btn-load-chart')?.addEventListener('click', initChartTab);

// ── STATUS POLL ───────────────────────────────────────────────────────────────
async function pollStatus() {
  try {
    const s = await apiFetch('/api/status');

    // Header dots
    setDot('hdr-broker',   s.brokerConnected);
    setDot('hdr-telegram', s.telegramConnected);
    $('hdr-time').textContent = s.sydneyTime || sydneyNow();

    // Header brain label
    const brainEl = $('brain-label');
    const pulseEl = $('pulse-dot');
    if (brainEl) {
      brainEl.textContent = s.scanning ? `BRAIN1 → ${s.currentPair || '...'}` : 'ONLINE';
      brainEl.className   = 'brain-label';
    }
    if (pulseEl) pulseEl.className = 'pulse-dot';

    // Dashboard stats
    const prevBal = $('s-balance')?.textContent;
    const newBal  = fmtMoney(s.balance);
    if (prevBal !== newBal) { $('s-balance').textContent = newBal; flash('s-balance'); }

    const pnlEl = $('s-pnl');
    if (pnlEl) {
      pnlEl.textContent = s.todayPnL != null ? (s.todayPnL >= 0 ? '+' : '') + fmtMoney(s.todayPnL) : '—';
      pnlEl.className   = 'stat-value ' + (s.todayPnL > 0 ? 'pos' : s.todayPnL < 0 ? 'neg' : '');
    }
    if ($('s-wr'))     $('s-wr').textContent     = s.winRate7d != null ? s.winRate7d + '%' : '—';
    if ($('s-losses')) $('s-losses').textContent = s.dailyLosses != null ? `${s.dailyLosses}/${s.dailyLossLimit}` : '—';
    if ($('s-open'))   $('s-open').textContent   = s.openPositions ?? '—';
    if (s.lastSignal && $('s-last-signal')) {
      $('s-last-signal').textContent = `${s.lastSignal.pair} ${s.lastSignal.direction} (${s.lastSignal.tier})`;
    }

    // Connection row
    setDot('d-broker-dot',   s.brokerConnected);
    setDot('d-telegram-dot', s.telegramConnected);
    const autoEl = $('d-auto-exec');
    if (autoEl) { autoEl.textContent = s.autoExecute ? 'ON' : 'OFF'; autoEl.className = 'badge ' + (s.autoExecute ? 'on' : 'off'); }
    const modeEl = $('d-mode');
    if (modeEl) { modeEl.textContent = s.liveMode ? 'LIVE' : 'PAPER'; modeEl.className = 'badge ' + (s.liveMode ? 'on' : 'off'); }

    // Sync toggle state
    state.settings = { ...state.settings, autoExecute: s.autoExecute, manualReview: s.manualReview };
    toggleBtn('toggle-auto',       s.autoExecute);
    toggleBtn('toggle-manual',     s.manualReview);
    toggleBtn('set-auto-exec',     s.autoExecute);
    toggleBtn('set-manual-review', s.manualReview);

    // Telegram tab
    setDot('tg-status-dot', s.telegramConnected);
    if ($('tg-status-text')) $('tg-status-text').textContent = s.telegramConnected ? 'Connected' : 'Disconnected';
  } catch (err) {
    const pulseEl = $('pulse-dot');
    const brainEl = $('brain-label');
    if (pulseEl) pulseEl.className = 'pulse-dot offline';
    if (brainEl) { brainEl.textContent = 'OFFLINE'; brainEl.className = 'brain-label idle'; }
    setBrainCard('bc1', false, 'OFFLINE');
    setBrainCard('bc2', false, 'OFFLINE');
    setBrainCard('bc3', false, 'OFFLINE');
  }
}

// ── SIGNALS ───────────────────────────────────────────────────────────────────
async function loadSignals() {
  try {
    const signals = await apiFetch('/api/signals/active');
    const list    = $('signals-list');
    if (!signals.length) {
      list.innerHTML = '<p class="empty">No active signals at the moment</p>';
      return;
    }
    list.innerHTML = signals.map(sig => {
      const dir    = sig.direction || '—';
      const tier   = sig.confidence_tier || sig.tier || '—';
      const cls    = dir === 'LONG' ? 'bull' : dir === 'SHORT' ? 'bear' : '';
      const tierCls = tier === 'DIAMOND' ? 'badge-diamond' : tier === 'GOLD' ? 'badge-gold' : 'badge-silver';
      return `
        <div class="signal-card ${cls}">
          <div class="sig-pair">${sig.symbol || '—'}</div>
          <div class="sig-tier ${tierCls}">${tier}</div>
          <div class="sig-dir ${dir}">${dir}</div>
          <div style="font-size:.65rem;color:var(--muted)">${sig.created_at ? new Date(sig.created_at).toLocaleTimeString('en-AU',{timeZone:'Australia/Sydney',hour12:false}) : '—'}</div>
          <div><span class="sig-label">Entry</span><br><span class="sig-val">${fmt(sig.entry_price,5)}</span></div>
          <div><span class="sig-label">Stop Loss</span><br><span class="sig-val">${fmt(sig.stop_loss,5)}</span></div>
          <div><span class="sig-label">TP1</span><br><span class="sig-val">${fmt(sig.tp1,5)}</span></div>
          <div><span class="sig-label">TP2</span><br><span class="sig-val">${fmt(sig.tp2,5)}</span></div>
        </div>`;
    }).join('');
  } catch {
    $('signals-list').innerHTML = '<p class="empty">Could not load signals</p>';
  }
}

$('btn-refresh-signals')?.addEventListener('click', loadSignals);

// ── RECENT TRADES ─────────────────────────────────────────────────────────────
async function loadRecentTrades() {
  try {
    const trades = await apiFetch('/api/trades/recent');
    const tbody  = $('recent-trades-body');
    if (!trades.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No trades yet</td></tr>';
      return;
    }
    tbody.innerHTML = trades.slice(0, 10).map(t => `
      <tr>
        <td>${t.symbol || '—'}</td>
        <td>${t.direction || '—'}</td>
        <td>${fmt(t.entry_price, 5)}</td>
        <td>${fmt(t.exit_price, 5)}</td>
        <td class="${t.outcome === 'WIN' ? 'badge-win' : 'badge-loss'}">${t.outcome || '—'}</td>
        <td>${fmt(t.pnl_r, 1)}R</td>
        <td>${t.closed_at ? new Date(t.closed_at).toLocaleString('en-AU',{timeZone:'Australia/Sydney',hour12:false}) : '—'}</td>
      </tr>`).join('');

    const l10 = $('last10-body');
    if (l10) {
      l10.innerHTML = trades.slice(0, 10).map(t => `
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
    const pos   = await apiFetch('/api/trades/open');
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
        <td>${fmt(p.stopLoss   || p.stop_loss, 5)}</td>
        <td>${fmt(p.takeProfit || p.tp1, 5)}</td>
        <td>${fmt(p.volume     || p.size, 2)}</td>
        <td>${fmtMoney(p.pnl)}</td>
      </tr>`).join('');
  } catch {}
}

// ── ANALYZER ─────────────────────────────────────────────────────────────────
async function loadAnalyzer() {
  const grid = $('analyzer-grid');
  grid.innerHTML = state.activePairs.map(p => `
    <div class="analyzer-card" id="ac-${p}">
      <div class="pair-name">${p}</div>
      <div class="pair-stat"><span class="label">Status</span><span>Loading…</span></div>
    </div>`).join('');

  try {
    const data = await apiFetch('/api/analyzer');
    grid.innerHTML = data.map(d => `
      <div class="analyzer-card${d.status !== 'OK' ? ' scan-error' : ''}">
        <div class="pair-name">${d.pair}</div>
        <div class="pair-stat"><span class="label">Status</span><span>${d.status}</span></div>
        ${d.data ? `
        <div class="pair-stat"><span class="label">Regime</span><span>${d.data.regime || '—'}</span></div>
        <div class="pair-stat"><span class="label">Session</span><span>${d.data.session || '—'}</span></div>
        <div class="pair-stat"><span class="label">News block</span><span>${d.data.newsBlackout ? 'YES' : 'NO'}</span></div>
        ` : '<div class="pair-stat"><span class="label">Detail</span><span style="color:var(--red)">No data</span></div>'}
      </div>`).join('');
  } catch {
    grid.innerHTML = '<p class="empty">Analyzer unavailable</p>';
  }
}

// ── SCAN NOW ──────────────────────────────────────────────────────────────────
$('btn-scan-now')?.addEventListener('click', async () => {
  const btn = $('btn-scan-now');
  btn.textContent = 'Scanning…';
  btn.disabled    = true;
  showMsg('scan-msg', '');
  try {
    const r = await apiFetch('/api/scan/manual', { method: 'POST' });
    if (r._error) {
      showMsg('scan-msg', `Server error (${r._status}) — check logs`, true);
    } else {
      const count = r.signals ?? 0;
      showMsg('scan-msg', `Scan complete — ${count} signal(s) found across ${(r.scanned || []).length} pairs`);
      if (count > 0) loadSignals();
    }
  } catch (err) {
    showMsg('scan-msg', err.name === 'AbortError' ? 'Scan timed out — still running in background' : 'Network error', true);
  }
  btn.textContent = 'Manual Scan Now';
  btn.disabled    = false;
});

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
  const checked    = [...document.querySelectorAll('#pairs-grid input:checked')].map(i => i.value);
  state.activePairs = checked;
  await apiFetch('/api/pairs/update', { method: 'POST', body: JSON.stringify({ pairs: checked }) });
  showMsg('pairs-msg', 'Pairs saved');
});

// ── SETTINGS ─────────────────────────────────────────────────────────────────
function initSliders() {
  [
    ['sl-diamond',      'val-diamond-risk'],
    ['sl-gold',         'val-gold-risk'],
    ['sl-silver',       'val-silver-risk'],
    ['sl-diamond-conv', 'val-diamond-conv'],
    ['sl-gold-conv',    'val-gold-conv'],
    ['sl-silver-conv',  'val-silver-conv'],
    ['sl-daily-loss',   'val-daily-loss'],
  ].forEach(([id, valId]) => {
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
    await apiFetch('/api/settings/update', { method: 'POST', body: JSON.stringify(body) });
    showMsg('settings-msg', 'Settings saved');
  } catch {
    showMsg('settings-msg', 'Save failed', true);
  }
});

// ── LEARNING ─────────────────────────────────────────────────────────────────
async function loadLearning() {
  try {
    const results   = await apiFetch('/api/learning/results');
    const container = $('learning-results');
    if (!results.length) {
      container.innerHTML = '<p class="empty">No learning cycles completed yet.</p>';
      return;
    }
    const byDate = {};
    for (const r of results) {
      const key = r.analysis_date?.split('T')[0] || 'unknown';
      if (!byDate[key]) byDate[key] = [];
      byDate[key].push(r);
    }
    container.innerHTML = Object.entries(byDate).slice(0, 5).map(([date, rows]) => {
      const insights  = JSON.parse(rows[0]?.insights           || '[]');
      const suggested = JSON.parse(rows[0]?.suggested_changes  || '[]');
      return `
        <div class="learning-cycle">
          <h4>Cycle: ${date}</h4>
          <strong style="font-size:.65rem;color:var(--muted)">INSIGHTS</strong>
          <ul class="insight-list">${insights.map(i => `<li>${i}</li>`).join('')}</ul>
          ${suggested.length ? `
          <strong style="font-size:.65rem;color:var(--muted);display:block;margin-top:.75rem">SUGGESTED CHANGES</strong>
          ${suggested.map(() => `
            <div class="suggestion-card">
              <p>${suggested[0].reason} <em style="color:var(--muted)">(${suggested[0].confidence})</em></p>
              <div class="suggestion-actions">
                <button class="btn-primary" onclick="approveSuggestion(${rows[0].id},true)">Apply</button>
                <button class="btn-secondary" onclick="approveSuggestion(${rows[0].id},false)">Reject</button>
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
  await apiFetch('/api/learning/approve', { method: 'POST', body: JSON.stringify({ patternId: id, approved }) });
  loadLearning();
};

$('btn-run-learning')?.addEventListener('click', async () => {
  const btn = $('btn-run-learning');
  btn.textContent = 'Running…';
  btn.disabled    = true;
  try {
    await apiFetch('/api/learning/run', { method: 'POST' });
    await loadLearning();
  } catch {}
  btn.textContent = 'Run Now';
  btn.disabled    = false;
});

// ── TELEGRAM ─────────────────────────────────────────────────────────────────
$('btn-tg-test')?.addEventListener('click', async () => {
  const btn = $('btn-tg-test');
  btn.textContent = 'Sending…';
  try {
    const r = await apiFetch('/api/telegram/test', { method: 'POST' });
    showMsg('tg-msg', r.success ? 'Test message sent' : 'Failed — check token/group');
    setDot('tg-status-dot', r.connected);
    if ($('tg-status-text')) $('tg-status-text').textContent = r.connected ? 'Connected' : 'Disconnected';
  } catch {
    showMsg('tg-msg', 'Request failed', true);
  }
  btn.textContent = 'Test Send';
});

// ── SUBSCRIBERS ───────────────────────────────────────────────────────────────
async function loadSubscribers() {
  try {
    const data  = await apiFetch('/api/subscribers');
    $('sub-count').textContent   = data.total    || 0;
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
        <td><button onclick="removeSub(${s.id})" style="background:none;border:none;color:var(--red);cursor:pointer;font-family:inherit;font-size:.7rem">Remove</button></td>
      </tr>`).join('');
  } catch {}
}

$('btn-add-sub')?.addEventListener('click', () => $('add-sub-form').classList.toggle('hidden'));

$('btn-sub-save')?.addEventListener('click', async () => {
  const email = $('sub-email')?.value?.trim();
  const tier  = $('sub-tier')?.value;
  if (!email) return;
  await apiFetch('/api/subscribers/add', { method: 'POST', body: JSON.stringify({ email, tier }) });
  $('add-sub-form').classList.add('hidden');
  $('sub-email').value = '';
  loadSubscribers();
});

window.removeSub = async id => {
  await apiFetch(`/api/subscribers/${id}`, { method: 'DELETE' });
  loadSubscribers();
};

// ── LOGS ─────────────────────────────────────────────────────────────────────
async function loadLogs() {
  try {
    const type = state.logFilter !== 'all' ? `?type=${state.logFilter}` : '';
    const logs = await apiFetch(`/api/logs${type}`);
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

// ── BROKER ───────────────────────────────────────────────────────────────────
async function loadBroker() {
  try {
    const r = await apiFetch('/api/broker/status');
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
  const btn = $('btn-ct-reconnect');
  btn.textContent = 'Reconnecting…';
  btn.disabled    = true;
  try {
    const r = await apiFetch('/api/broker/reconnect', { method: 'POST' });
    setDot('ct-status-dot', r.connected);
    $('ct-status-text').textContent = r.connected ? 'Connected' : 'Disconnected';
  } catch {}
  btn.textContent = 'Reconnect';
  btn.disabled    = false;
});

// ── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  initSliders();
  renderPairs();

  // Load settings from backend
  try {
    const s = await apiFetch('/api/settings');
    if (s.diamondRisk)    { $('sl-diamond').value = s.diamondRisk;          $('val-diamond-risk').textContent = s.diamondRisk; }
    if (s.goldRisk)       { $('sl-gold').value    = s.goldRisk;             $('val-gold-risk').textContent    = s.goldRisk; }
    if (s.silverRisk)     { $('sl-silver').value  = s.silverRisk;           $('val-silver-risk').textContent  = s.silverRisk; }
    if (s.dailyLossLimit) { $('sl-daily-loss').value = s.dailyLossLimit;    $('val-daily-loss').textContent   = s.dailyLossLimit; }
    state.settings = s;
    toggleBtn('set-live-mode', s.liveMode);
  } catch {}

  // First status poll
  await pollStatus();
  await loadRecentTrades();

  // Init dashboard chart after a short delay (let TV script load)
  setTimeout(initDashChart, 1500);

  // Countdown every second
  updateCountdown();
  setInterval(updateCountdown, 1000);

  // Scan state poll every 4 seconds (lightweight endpoint)
  await pollScanState();
  setInterval(pollScanState, 4000);

  // Full status poll every 20 seconds
  setInterval(async () => {
    await pollStatus();
    if (document.querySelector('.tab-btn[data-tab="dashboard"].active')) {
      await loadRecentTrades();
    }
    if (document.querySelector('.tab-btn[data-tab="trading"].active')) {
      await loadOpenPositions();
      await loadRecentTrades();
    }
  }, 20000);

  // Refresh logs/signals every 60s if those tabs are open
  setInterval(() => {
    if (document.querySelector('.tab-btn[data-tab="logs"].active'))    loadLogs();
    if (document.querySelector('.tab-btn[data-tab="signals"].active')) loadSignals();
  }, 60000);
}

init();
