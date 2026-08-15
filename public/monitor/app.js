(() => {
  const RANGE_PRESETS = [
    ['1h', 3600000],
    ['6h', 6 * 3600000],
    ['24h', 24 * 3600000],
    ['7d', 7 * 86400000],
    ['30d', 30 * 86400000],
    ['60d', 60 * 86400000],
  ];

  const NAV_PAGES = [
    ['overview', 'Overview'],
    ['logs', 'App logs'],
    ['network', 'Network'],
    ['http', 'HTTP in'],
    ['vision', 'Vision'],
    ['billing', 'DeepInfra'],
    ['actions', 'Actions'],
    ['api-map', 'API map'],
  ];

  const API_ROUTES = [
    { method: 'GET', path: '/', auth: 'none', action: 'root' },
    { method: 'GET', path: '/health', auth: 'none', action: 'health' },
    { method: 'GET', path: '/live', auth: 'none', action: 'health.live' },
    { method: 'GET', path: '/ready', auth: 'none', action: 'health.ready' },
    { method: 'POST', path: '/analyze', auth: 'license', action: 'analyze' },
    { method: 'POST', path: '/confirm-vote', auth: 'license', action: 'confirm_vote' },
    { method: 'GET', path: '/monitor', auth: 'none', action: 'monitor.spa' },
    { method: 'POST', path: '/monitor/api/auth/login', auth: 'none', action: 'monitor.auth.login' },
    { method: 'POST', path: '/monitor/api/auth/logout', auth: 'none', action: 'monitor.auth.logout' },
    { method: 'GET', path: '/monitor/api/auth/me', auth: 'staff', action: 'monitor.auth.me' },
    { method: 'GET', path: '/monitor/api/overview', auth: 'staff', action: 'monitor.overview' },
    { method: 'GET', path: '/monitor/api/series', auth: 'staff', action: 'monitor.series' },
    { method: 'GET', path: '/monitor/api/logs', auth: 'staff', action: 'monitor.logs' },
    { method: 'GET', path: '/monitor/api/logs.csv', auth: 'staff', action: 'monitor.logs_csv' },
    { method: 'GET', path: '/monitor/api/network', auth: 'staff', action: 'monitor.network' },
    { method: 'GET', path: '/monitor/api/network.csv', auth: 'staff', action: 'monitor.network_csv' },
    { method: 'GET', path: '/monitor/api/http', auth: 'staff', action: 'monitor.http' },
    { method: 'GET', path: '/monitor/api/vision', auth: 'staff', action: 'monitor.vision' },
    { method: 'GET', path: '/monitor/api/facets', auth: 'staff', action: 'monitor.facets' },
    { method: 'GET', path: '/monitor/api/storage', auth: 'staff', action: 'monitor.storage' },
    { method: 'GET', path: '/monitor/api/billing', auth: 'staff', action: 'monitor.billing' },
    { method: 'POST', path: '/monitor/api/billing/refresh', auth: 'staff', action: 'monitor.billing.refresh' },
    { method: 'GET', path: '/monitor/api/status', auth: 'staff', action: 'monitor.status' },
  ];

  const STAFF_ACTIONS = [
    { id: 'refresh-billing', name: 'billing.refresh', label: 'Poll DeepInfra billing', hint: 'POST /monitor/api/billing/refresh — snapshots prepaid balance.', kind: 'run' },
    { id: 'jump-logs', name: 'nav.logs', label: 'Jump to app logs', hint: 'Open the App logs stream for this range.', kind: 'nav' },
    { id: 'jump-http', name: 'nav.http', label: 'Jump to inbound HTTP', hint: 'Open license-token engine requests (/analyze, /confirm-vote).', kind: 'nav' },
    { id: 'jump-network', name: 'nav.network', label: 'Jump to outbound network', hint: 'Open DeepInfra / provider call logs.', kind: 'nav' },
    { id: 'copy-health', name: 'copy.health', label: 'Copy health URL', hint: 'Clipboard: GET /health (public).', kind: 'copy' },
    { id: 'copy-live', name: 'copy.live', label: 'Copy live URL', hint: 'Clipboard: GET /live (public).', kind: 'copy' },
    { id: 'copy-ready', name: 'copy.ready', label: 'Copy ready URL', hint: 'Clipboard: GET /ready (public).', kind: 'copy' },
    { id: 'logout', name: 'auth.logout', label: 'Sign out', hint: 'Clear the staff session cookie for /monitor.', kind: 'logout' },
  ];

  function parseLocation() {
    const raw = (location.hash || '').replace(/^#\/?/, '');
    const segments = raw.split('/').filter(Boolean);
    const known = NAV_PAGES.map((p) => p[0]);
    const page = known.includes(segments[0]) ? segments[0] : 'overview';
    return { page, detail: segments.slice(1).join('/') };
  }

  const initialLoc = parseLocation();
  const state = {
    user: null,
    page: initialLoc.page,
    actionId: initialLoc.page === 'actions' ? initialLoc.detail : '',
    actionResult: null,
    apiView: 'wire',
    rangeMs: 24 * 3600000,
    autoRefresh: true,
    facets: { tasks: [], providers: [], models: [], services: [], levels: [] },
    expanded: new Set(),
    filters: {},
    timer: null,
  };

  const Chrome = window.MonitorChrome;

  const app = document.getElementById('app');
  let omni = null;

  function qs(params) {
    const to = Date.now();
    const from = to - state.rangeMs;
    const search = new URLSearchParams({ from: String(from), to: String(to), ...params });
    for (const [k, v] of search.entries()) {
      if (v == null || v === '' || v === 'undefined') search.delete(k);
    }
    return `?${search}`;
  }

  async function api(path, options = {}) {
    const resp = await fetch(`/monitor/api${path}`, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    if (resp.status === 401) {
      state.user = null;
      throw new Error('Staff login required');
    }
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!resp.ok) throw new Error(data?.error || `Request failed (${resp.status})`);
    return data;
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString();
  }
  function fmtAgo(ts) {
    if (!ts) return '—';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  function fmtUsd(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  }
  function fmtNum(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString();
  }
  function fmtMs(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return `${Math.round(n)} ms`;
  }
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function badge(level) {
    const cls = String(level || 'muted').toLowerCase();
    return `<span class="badge ${esc(cls)}">${esc(level || '—')}</span>`;
  }

  function drawChart(canvas, series, opts = {}) {
    if (!canvas) return;
    const tip = canvas.parentElement.querySelector('.chart-tip');
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 220;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const pad = { l: 44, r: 12, t: 12, b: 28 };
    const allPoints = series.flatMap((s) => s.points);
    if (!allPoints.length) {
      ctx.fillStyle = '#8b98a8';
      ctx.fillText('No data in this range', pad.l, height / 2);
      return;
    }
    const minX = Math.min(...allPoints.map((p) => p.t));
    const maxX = Math.max(...allPoints.map((p) => p.t));
    const maxY = Math.max(opts.minMax || 1, ...allPoints.map((p) => p.v));
    const xAt = (t) => pad.l + ((t - minX) / Math.max(1, maxX - minX)) * (width - pad.l - pad.r);
    const yAt = (v) => pad.t + (1 - v / maxY) * (height - pad.t - pad.b);

    ctx.strokeStyle = '#243040';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#8b98a8';
    ctx.font = '11px IBM Plex Sans, system-ui, sans-serif';
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + ((height - pad.t - pad.b) * i) / 4;
      const val = maxY * (1 - i / 4);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(width - pad.r, y);
      ctx.stroke();
      ctx.fillText(opts.formatY ? opts.formatY(val) : String(Math.round(val)), 6, y + 4);
    }
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const t = minX + ((maxX - minX) * i) / ticks;
      const x = xAt(t);
      ctx.fillText(new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' }), x - 24, height - 8);
    }

    series.forEach((s) => {
      if (!s.points.length) return;
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = xAt(p.t);
        const y = yAt(p.v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (s.fill) {
        const last = s.points[s.points.length - 1];
        const first = s.points[0];
        ctx.lineTo(xAt(last.t), yAt(0));
        ctx.lineTo(xAt(first.t), yAt(0));
        ctx.closePath();
        ctx.fillStyle = s.fill;
        ctx.fill();
      }
    });

    canvas.onmousemove = (ev) => {
      if (!tip) return;
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const t = minX + ((x - pad.l) / Math.max(1, width - pad.l - pad.r)) * (maxX - minX);
      const lines = series.map((s) => {
        let best = s.points[0];
        let bestD = Infinity;
        for (const p of s.points) {
          const d = Math.abs(p.t - t);
          if (d < bestD) { best = p; bestD = d; }
        }
        return `${s.name}: ${opts.formatY ? opts.formatY(best.v) : best.v}`;
      });
      tip.style.display = 'block';
      tip.style.left = `${Math.min(width - 160, Math.max(8, x + 8))}px`;
      tip.style.top = '8px';
      tip.innerHTML = `${fmtTime(t)}<br>${lines.join('<br>')}`;
    };
    canvas.onmouseleave = () => { if (tip) tip.style.display = 'none'; };
  }

  function shell(inner) {
    return `
      <div class="shell">
        <header class="topbar">
          <div class="brand">
            <img class="brand-mark" src="/monitor/static/craftology-mark.png" alt="Craftology" width="28" height="28" />
            <span>
              <span class="brand-name">CRAFT//OPS</span>
              <span class="brand-sub">Vision Monitor</span>
            </span>
          </div>
          <span class="live-dot${state.autoRefresh ? '' : ' off'}" title="${state.autoRefresh ? 'Live' : 'Paused'}"></span>
          <div class="range-chips" role="tablist" aria-label="Time range">
            ${RANGE_PRESETS.map(([label, ms]) => `
              <button type="button" class="chip ${state.rangeMs === ms ? 'active' : ''}" data-range="${ms}">${label}</button>
            `).join('')}
            <button type="button" class="chip" id="refresh" title="Refresh">↻</button>
          </div>
          <div class="top-spacer"></div>
          <button type="button" class="btn search-open" id="omni-open">
            ${Chrome.SEARCH_SVG}
            <span>Omnisearch</span>
            <span class="kbd">Ctrl K</span>
          </button>
          <button type="button" class="chip ${state.autoRefresh ? 'active' : ''}" id="autorefresh">Live</button>
        </header>
        <nav class="sidebar">
          ${NAV_PAGES.map(([id, label]) => `
            <button type="button" class="nav-link ${state.page === id ? 'active' : ''}" data-page="${id}"><span>${label}</span></button>
          `).join('')}
          <div class="nav-hint">Ctrl K search · j/k move · enter open · esc close</div>
          <div class="user-box">
            <span title="${esc(state.user?.email || '')}">${esc(state.user?.email || '')}</span>
            <button type="button" class="icon-btn" id="logout" title="Sign out">⎋</button>
          </div>
        </nav>
        <main class="main">
          <div class="page-head">
            <div>
              <h1>${esc(NAV_PAGES.find((p) => p[0] === state.page)?.[1] || 'Monitor')}</h1>
              <p>${state.page === 'actions'
      ? 'Named staff actions for this dashboard. Click a type to inspect or run it.'
      : state.page === 'api-map'
        ? 'Live route inventory. Staff monitor APIs vs license-token engine APIs are marked. Click a node to filter HTTP in.'
        : 'Vision Monitor. Admin role required.'}</p>
            </div>
          </div>
          ${inner}
        </main>
      </div>
    `;
  }

  function loginView(error = '') {
    return `
      <div class="auth-screen">
        <form class="login-card" id="login-form">
          <img class="brand-mark login-mark" src="/monitor/static/craftology-mark.png" alt="Craftology" width="48" height="48" />
          <p class="login-kicker">Staff console</p>
          <h1>Craftology Monitor</h1>
          <p class="sub">Vision Monitor. Same admin accounts as the Craftology site. Admin role required.</p>
          ${error ? `<div class="banner">${esc(error)}</div>` : ''}
          <div class="field">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="username" required />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required />
          </div>
          <button class="btn btn-primary" type="submit">Sign in</button>
        </form>
      </div>
    `;
  }

  async function renderLogin(error) {
    app.innerHTML = loginView(error);
    app.querySelector('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = app.querySelector('#email').value;
      const password = app.querySelector('#password').value;
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      try {
        const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
        state.user = data.user;
        await loadFacets();
        render();
      } catch (err) {
        renderLogin(err.message);
      }
    });
  }

  function goTo(page, detail = '') {
    state.page = page;
    if (page !== 'actions') state.actionId = '';
    if (page === 'actions' && detail) state.actionId = detail;
    const hash = detail ? `#/${page}/${detail}` : `#/${page}`;
    if (location.hash !== hash) location.hash = hash;
    else render();
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      return false;
    }
  }

  async function runStaffAction(id) {
    const action = STAFF_ACTIONS.find((a) => a.id === id) || STAFF_ACTIONS.find((a) => a.name === id);
    if (!action) {
      state.actionResult = { ok: false, message: 'Unknown action' };
      return render();
    }
    state.actionId = action.id;
    if (action.id === 'refresh-billing') {
      try {
        await api('/billing/refresh', { method: 'POST' });
        state.actionResult = { ok: true, message: 'DeepInfra billing snapshot refreshed.' };
      } catch (err) {
        state.actionResult = { ok: false, message: err.message || 'Refresh failed' };
      }
      return render();
    }
    if (action.id === 'jump-logs') return goTo('logs');
    if (action.id === 'jump-http') return goTo('http');
    if (action.id === 'jump-network') return goTo('network');
    if (action.id === 'copy-health' || action.id === 'copy-live' || action.id === 'copy-ready') {
      const path = action.id === 'copy-health' ? '/health' : action.id === 'copy-live' ? '/live' : '/ready';
      const ok = await copyText(`${location.origin}${path}`);
      state.actionResult = { ok, message: ok ? `Copied ${location.origin}${path}` : 'Clipboard unavailable' };
      return render();
    }
    if (action.id === 'logout') {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      state.user = null;
      return render();
    }
  }

  function bindShell() {
    app.querySelectorAll('[data-page]').forEach((btn) => {
      btn.addEventListener('click', () => goTo(btn.dataset.page));
    });
    app.querySelectorAll('[data-range]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.rangeMs = Number(btn.dataset.range);
        render();
      });
    });
    app.querySelector('#refresh')?.addEventListener('click', () => render());
    app.querySelector('#omni-open')?.addEventListener('click', () => omni?.open());
    app.querySelector('#autorefresh')?.addEventListener('click', () => {
      state.autoRefresh = !state.autoRefresh;
      scheduleRefresh();
      render();
    });
    app.querySelector('#logout')?.addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      state.user = null;
      render();
    });
  }

  function scheduleRefresh() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
      if (state.autoRefresh && state.user) {
      state.timer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        if (omni?.isOpen()) return;
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        render();
      }, 8000);
    }
  }

  async function loadFacets() {
    try {
      state.facets = await api(`/facets${qs()}`);
    } catch {
      state.facets = { tasks: [], providers: [], models: [], services: [], levels: [] };
    }
  }

  function filterBar(fields) {
    return `<div class="filters">${fields}</div>`;
  }

  function selectField(name, label, values) {
    const current = state.filters[name] || '';
    return `
      <div class="field">
        <label>${esc(label)}</label>
        <select data-filter="${esc(name)}">
          <option value="">All</option>
          ${values.map((v) => `<option value="${esc(v)}" ${current === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}
        </select>
      </div>
    `;
  }

  function bindFilters(onChange) {
    app.querySelectorAll('[data-filter]').forEach((el) => {
      el.addEventListener('change', () => {
        state.filters[el.dataset.filter] = el.value;
        onChange();
      });
    });
    const search = app.querySelector('[data-filter="q"]');
    search?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        state.filters.q = search.value;
        onChange();
      }
    });
  }

  function expandRow(id, payload) {
    if (!payload) return '';
    if (!state.expanded.has(id)) return '';
    return `<div class="expand">${esc(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2))}</div>`;
  }

  async function renderOverview() {
    const [overview, series, status, storage] = await Promise.all([
      api(`/overview${qs()}`),
      api(`/series${qs()}`),
      api('/status'),
      api('/storage'),
    ]);
    const http = overview.http || {};
    const billing = overview.billing || {};
    const errRate = http.requests ? (100 * (http.errors || 0) / http.requests) : 0;
    const balanceClass = billing.suspended ? 'danger' : (billing.available_usd != null && billing.available_usd < 5 ? 'warn' : 'ok');
    app.innerHTML = shell(`
      <div class="kpis">
        <div class="kpi ${balanceClass}">
          <div class="label">DeepInfra balance</div>
          <div class="value">${fmtUsd(billing.available_usd)}</div>
          <div class="sub">${billing.suspended ? `Suspended: ${esc(billing.suspend_reason || 'yes')}` : `Recent ${fmtUsd(billing.recent_usd)}`}</div>
        </div>
        <div class="kpi">
          <div class="label">Requests</div>
          <div class="value">${fmtNum(http.requests)}</div>
          <div class="sub">${fmtNum(http.errors)} errors · ${errRate.toFixed(2)}%</div>
        </div>
        <div class="kpi">
          <div class="label">Latency p50 / p95</div>
          <div class="value">${fmtMs(http.p50)}</div>
          <div class="sub">p95 ${fmtMs(http.p95)} · max ${fmtMs(http.max_latency)}</div>
        </div>
        <div class="kpi">
          <div class="label">Vision success</div>
          <div class="value">${fmtNum(overview.vision?.success || 0)}</div>
          <div class="sub">${fmtNum(overview.vision?.fail || 0)} failed · ${fmtNum(overview.vision?.cached || 0)} cached</div>
        </div>
        <div class="kpi">
          <div class="label">Queue</div>
          <div class="value">${fmtNum(status.queue?.active ?? status.queue?.pending ?? 0)}</div>
          <div class="sub">${fmtNum(status.queue?.users || 0)} users · ${fmtNum(status.queue?.pending || 0)} pending</div>
        </div>
        <div class="kpi">
          <div class="label">Tokens</div>
          <div class="value">${fmtNum(overview.tokens)}</div>
          <div class="sub">${(storage.db_bytes / (1024 * 1024)).toFixed(1)} MB stored</div>
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <h3>Request volume</h3>
          <div class="chart-wrap"><canvas id="chart-req"></canvas><div class="chart-tip"></div></div>
        </div>
        <div class="card">
          <h3>DeepInfra available balance</h3>
          <div class="chart-wrap"><canvas id="chart-bal"></canvas><div class="chart-tip"></div></div>
        </div>
      </div>
      <div class="grid-2" style="margin-top:12px">
        <div class="card">
          <h3>Latency (avg from minute buckets)</h3>
          <div class="chart-wrap"><canvas id="chart-lat"></canvas><div class="chart-tip"></div></div>
        </div>
        <div class="card">
          <h3>Errors vs success</h3>
          <div class="chart-wrap"><canvas id="chart-err"></canvas><div class="chart-tip"></div></div>
        </div>
      </div>
      <div class="grid-2" style="margin-top:12px">
        <div class="card">
          <h3>Providers</h3>
          ${(overview.byProvider || []).map((row) => `
            <div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)">
              <div><span class="status-dot ${row.success ? '' : 'warn'}"></span>${esc(row.provider)} <span class="mono">${esc(row.model)}</span></div>
              <div class="mono">${fmtNum(row.total)} · ${fmtMs(row.avg_latency)}</div>
            </div>
          `).join('') || '<div class="empty">No vision events yet</div>'}
          <h3 style="margin-top:16px">Live models</h3>
          ${(status.vision?.providers || []).map((p) => `
            <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)">
              <div><span class="status-dot ${p.ready ? '' : 'bad'}"></span>${esc(p.provider)} ${esc(p.model)}</div>
              <div class="mono">${p.last_error ? esc(p.last_error) : 'ok'}</div>
            </div>
          `).join('')}
        </div>
        <div class="card">
          <h3>Recent warnings / errors</h3>
          ${(overview.recentErrors || []).map((row) => `
            <div style="padding:8px 0;border-bottom:1px solid var(--line)">
              ${badge(row.level)} <span class="mono">${fmtAgo(row.ts)}</span>
              <div>${esc(row.msg || row.error || '')}</div>
            </div>
          `).join('') || '<div class="empty">No recent errors</div>'}
        </div>
      </div>
    `);
    bindShell();
    const reqPoints = (series.rows || []).map((r) => ({ t: r.ts, v: r.requests || 0 }));
    const errPoints = (series.rows || []).map((r) => ({ t: r.ts, v: r.errors || 0 }));
    const latPoints = (series.rows || []).map((r) => ({
      t: r.ts,
      v: r.latency_count ? r.latency_sum / r.latency_count : 0,
    }));
    const okPoints = (series.rows || []).map((r) => ({ t: r.ts, v: r.vision_success || 0 }));
    const failPoints = (series.rows || []).map((r) => ({ t: r.ts, v: r.vision_fail || 0 }));
    const balPoints = (overview.billingSeries || []).map((r) => ({ t: r.ts, v: r.available_usd || 0 }));
    drawChart(document.getElementById('chart-req'), [
      { name: 'Requests', color: '#3ee0b0', fill: 'rgba(62,224,176,.12)', points: reqPoints },
      { name: 'HTTP errors', color: '#ff6b7a', points: errPoints },
    ]);
    drawChart(document.getElementById('chart-bal'), [
      { name: 'Available USD', color: '#5cc8ff', fill: 'rgba(92,200,255,.12)', points: balPoints },
    ], { formatY: (v) => `$${v.toFixed(2)}` });
    drawChart(document.getElementById('chart-lat'), [
      { name: 'Avg ms', color: '#f0b429', points: latPoints },
    ], { formatY: (v) => `${Math.round(v)}ms` });
    drawChart(document.getElementById('chart-err'), [
      { name: 'Success', color: '#3ee0b0', points: okPoints },
      { name: 'Fail', color: '#ff6b7a', points: failPoints },
    ]);
  }

  async function renderLogs() {
    const data = await api(`/logs${qs({
      q: state.filters.q || '',
      level: state.filters.level || '',
      task: state.filters.task || '',
      provider: state.filters.provider || '',
      license_id: state.filters.license_id || '',
      limit: '250',
    })}`);
    app.innerHTML = shell(`
      ${filterBar(`
        <div class="field search">
          <label>Search</label>
          <input data-filter="q" value="${esc(state.filters.q || '')}" placeholder="Find in messages, errors, payload — press Enter" />
        </div>
        ${selectField('level', 'Level', state.facets.levels || ['info', 'warn', 'error', 'fatal'])}
        ${selectField('task', 'Task', state.facets.tasks || [])}
        ${selectField('provider', 'Provider', state.facets.providers || [])}
        <div class="field">
          <label>License id</label>
          <input data-filter="license_id" value="${esc(state.filters.license_id || '')}" placeholder="uuid" />
        </div>
        <a class="btn secondary small" href="/monitor/api/logs.csv${qs({
          q: state.filters.q || '',
          level: state.filters.level || '',
          task: state.filters.task || '',
        })}">Export CSV</a>
      `)}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Level</th><th>Task</th><th>Message</th><th>Provider</th><th>Req</th></tr></thead>
          <tbody>
            ${(data.rows || []).map((row) => `
              <tr class="clickable" data-expand="log-${row.id}">
                <td class="mono">${esc(fmtAgo(row.ts))}<div class="user-pill">${esc(fmtTime(row.ts))}</div></td>
                <td>${badge(row.level)}</td>
                <td class="mono">${esc(row.task || '')}</td>
                <td class="msg">${esc(row.msg || row.error || '')}${expandRow(`log-${row.id}`, row.payload || row.error)}</td>
                <td class="mono">${esc(row.provider || '')} ${esc(row.model || '')}</td>
                <td class="mono">${esc(row.request_id || '')}</td>
              </tr>
            `).join('') || '<tr><td colspan="6" class="empty">No logs in this range</td></tr>'}
          </tbody>
        </table>
      </div>
    `);
    bindShell();
    bindFilters(() => render());
    bindExpand();
  }

  async function renderNetwork() {
    const data = await api(`/network${qs({
      q: state.filters.q || '',
      service: state.filters.service || '',
      model: state.filters.model || '',
      task: state.filters.task || '',
      errors: state.filters.errors || '',
      min_latency: state.filters.min_latency || '',
      limit: '250',
    })}`);
    app.innerHTML = shell(`
      ${filterBar(`
        <div class="field search">
          <label>Search URL / error / body</label>
          <input data-filter="q" value="${esc(state.filters.q || '')}" placeholder="deepinfra, 429, timeout — Enter" />
        </div>
        ${selectField('service', 'Service', state.facets.services || ['deepinfra', 'billing', 'ollama', 'supabase'])}
        ${selectField('task', 'Task', state.facets.tasks || [])}
        ${selectField('model', 'Model', state.facets.models || [])}
        ${selectField('errors', 'Errors only', ['1'])}
        <div class="field">
          <label>Min latency (ms)</label>
          <input data-filter="min_latency" value="${esc(state.filters.min_latency || '')}" />
        </div>
        <a class="btn secondary small" href="/monitor/api/network.csv${qs({
          q: state.filters.q || '',
          service: state.filters.service || '',
        })}">Export CSV</a>
      `)}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Service</th><th>Status</th><th>Ms</th><th>URL</th><th>Model / task</th><th>Tokens</th></tr></thead>
          <tbody>
            ${(data.rows || []).map((row) => `
              <tr class="clickable" data-expand="net-${row.id}">
                <td class="mono">${esc(fmtAgo(row.ts))}</td>
                <td>${badge(row.service)}</td>
                <td>${row.status >= 400 || row.error ? badge('error') : badge('ok')} <span class="mono">${esc(row.status ?? '—')}</span></td>
                <td class="mono">${esc(fmtMs(row.latency_ms))}</td>
                <td class="url">${esc(row.method)} ${esc(row.url)}${expandRow(`net-${row.id}`, {
                  error: row.error,
                  request: row.request_excerpt,
                  response: row.response_excerpt,
                })}</td>
                <td class="mono">${esc(row.model || '')}<div>${esc(row.task || '')}</div></td>
                <td class="mono">${esc(row.total_tokens ?? '')}</td>
              </tr>
            `).join('') || '<tr><td colspan="7" class="empty">No outbound calls in this range</td></tr>'}
          </tbody>
        </table>
      </div>
    `);
    bindShell();
    bindFilters(() => render());
    bindExpand();
  }

  async function renderHttp() {
    const data = await api(`/http${qs({
      path: state.filters.path || '',
      task: state.filters.task || '',
      license_id: state.filters.license_id || '',
      errors: state.filters.errors || '',
      limit: '250',
    })}`);
    app.innerHTML = shell(`
      ${filterBar(`
        ${selectField('path', 'Path', ['/analyze', '/confirm-vote', '/health', '/live', '/ready', '/monitor/api/overview'].concat(
        state.filters.path && !['/analyze', '/confirm-vote', '/health', '/live', '/ready', '/monitor/api/overview'].includes(state.filters.path)
          ? [state.filters.path]
          : []
      ))}
        ${selectField('task', 'Task', state.facets.tasks || [])}
        ${selectField('errors', 'Errors only', ['1'])}
        <div class="field">
          <label>License id</label>
          <input data-filter="license_id" value="${esc(state.filters.license_id || '')}" />
        </div>
      `)}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Path</th><th>Status</th><th>Ms</th><th>Task</th><th>Provider</th><th>License</th><th>Queue</th></tr></thead>
          <tbody>
            ${(data.rows || []).map((row) => `
              <tr>
                <td class="mono">${esc(fmtAgo(row.ts))}</td>
                <td class="mono">${esc(row.method)} ${esc(row.path)}</td>
                <td>${row.status >= 400 ? badge('error') : badge('ok')} ${esc(row.status)}</td>
                <td class="mono">${esc(fmtMs(row.latency_ms))}</td>
                <td class="mono">${esc(row.task || '')}</td>
                <td class="mono">${esc(row.provider || '')} ${esc(row.model || '')} ${row.cached ? badge('ok') : ''}</td>
                <td class="mono">${esc(row.license_id || '')}</td>
                <td class="mono">${esc(row.queue_wait_ms || 0)}</td>
              </tr>
            `).join('') || '<tr><td colspan="8" class="empty">No inbound HTTP yet</td></tr>'}
          </tbody>
        </table>
      </div>
    `);
    bindShell();
    bindFilters(() => render());
  }

  async function renderVision() {
    const [overview, data] = await Promise.all([
      api(`/overview${qs()}`),
      api(`/vision${qs({
        task: state.filters.task || '',
        provider: state.filters.provider || '',
        model: state.filters.model || '',
        success: state.filters.success || '',
        license_id: state.filters.license_id || '',
        limit: '250',
      })}`),
    ]);
    app.innerHTML = shell(`
      <div class="grid-3" style="margin-bottom:12px">
        ${(overview.byTask || []).map((row) => `
          <div class="kpi">
            <div class="label">${esc(row.task || 'unknown')}</div>
            <div class="value">${fmtNum(row.success || 0)}</div>
            <div class="sub">${fmtNum(row.fail || 0)} fail · avg ${fmtMs(row.avg_latency)}</div>
          </div>
        `).join('') || '<div class="empty">No task breakdown yet</div>'}
      </div>
      ${filterBar(`
        ${selectField('task', 'Task', state.facets.tasks || [])}
        ${selectField('provider', 'Provider', state.facets.providers || [])}
        ${selectField('model', 'Model', state.facets.models || [])}
        ${selectField('success', 'Result', ['1', '0'])}
        <div class="field">
          <label>License id</label>
          <input data-filter="license_id" value="${esc(state.filters.license_id || '')}" />
        </div>
      `)}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Task</th><th>Result</th><th>Ms</th><th>Provider</th><th>Tokens</th><th>License</th></tr></thead>
          <tbody>
            ${(data.rows || []).map((row) => `
              <tr class="clickable" data-expand="vis-${row.id}">
                <td class="mono">${esc(fmtAgo(row.ts))}</td>
                <td class="mono">${esc(row.task || '')}</td>
                <td>${row.success ? badge('ok') : badge('error')} ${esc(row.error || (row.cached ? 'cached' : 'ok'))}</td>
                <td class="mono">${esc(fmtMs(row.latency_ms))}</td>
                <td class="mono">${esc(row.provider || '')} ${esc(row.model || '')}</td>
                <td class="mono">${esc((row.prompt_tokens || 0) + (row.completion_tokens || 0) || '')}</td>
                <td class="mono">${esc(row.license_id || '')}${expandRow(`vis-${row.id}`, row.attempts_json)}</td>
              </tr>
            `).join('') || '<tr><td colspan="7" class="empty">No vision events yet</td></tr>'}
          </tbody>
        </table>
      </div>
    `);
    bindShell();
    bindFilters(() => render());
    bindExpand();
  }

  async function renderBilling() {
    const [history, overview] = await Promise.all([
      api(`/billing${qs()}`),
      api(`/overview${qs()}`),
    ]);
    const latest = overview.billing || history.rows?.[0] || {};
    app.innerHTML = shell(`
      <div class="kpis">
        <div class="kpi ${latest.suspended ? 'danger' : 'ok'}">
          <div class="label">Available</div>
          <div class="value">${fmtUsd(latest.available_usd)}</div>
          <div class="sub">${latest.error ? esc(latest.error) : latest.suspended ? esc(latest.suspend_reason || 'suspended') : 'Prepaid DeepInfra balance'}</div>
        </div>
        <div class="kpi">
          <div class="label">Owed</div>
          <div class="value">${fmtUsd(latest.owed_usd)}</div>
          <div class="sub">Positive Stripe balance means money owed</div>
        </div>
        <div class="kpi">
          <div class="label">Recent spend</div>
          <div class="value">${fmtUsd(latest.recent_usd)}</div>
          <div class="sub">Since last invoice</div>
        </div>
        <div class="kpi">
          <div class="label">Spend limit</div>
          <div class="value">${fmtUsd(latest.spending_limit_usd)}</div>
          <div class="sub">Updated ${esc(fmtAgo(latest.ts))}</div>
        </div>
      </div>
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3>Balance over time</h3>
          <button class="btn secondary small" id="billing-refresh">Poll DeepInfra now</button>
        </div>
        <div class="chart-wrap"><canvas id="chart-bal2"></canvas><div class="chart-tip"></div></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Available</th><th>Owed</th><th>Recent</th><th>Limit</th><th>Suspended</th><th>Error</th></tr></thead>
          <tbody>
            ${(history.rows || []).map((row) => `
              <tr class="clickable" data-expand="bill-${row.id}">
                <td class="mono">${esc(fmtTime(row.ts))}</td>
                <td>${esc(fmtUsd(row.available_usd))}</td>
                <td>${esc(fmtUsd(row.owed_usd))}</td>
                <td>${esc(fmtUsd(row.recent_usd))}</td>
                <td>${esc(fmtUsd(row.spending_limit_usd))}</td>
                <td>${row.suspended ? badge('error') : badge('ok')}</td>
                <td class="msg">${esc(row.error || '')}${expandRow(`bill-${row.id}`, row.usage_json || row.checklist_json)}</td>
              </tr>
            `).join('') || '<tr><td colspan="7" class="empty">No billing snapshots yet — they appear after the first poll (~3 min) or click Poll now</td></tr>'}
          </tbody>
        </table>
      </div>
    `);
    bindShell();
    bindExpand();
    drawChart(document.getElementById('chart-bal2'), [
      { name: 'Available USD', color: '#3ee0b0', fill: 'rgba(62,224,176,.12)', points: (overview.billingSeries || []).map((r) => ({ t: r.ts, v: r.available_usd || 0 })) },
      { name: 'Recent spend', color: '#f0b429', points: (overview.billingSeries || []).map((r) => ({ t: r.ts, v: r.recent_usd || 0 })) },
    ], { formatY: (v) => `$${v.toFixed(2)}` });
    app.querySelector('#billing-refresh')?.addEventListener('click', async () => {
      await api('/billing/refresh', { method: 'POST' });
      render();
    });
  }

  function renderActions() {
    const selected = STAFF_ACTIONS.some((a) => a.id === state.actionId) ? state.actionId : '';
    app.innerHTML = shell(Chrome.renderActions({
      actions: STAFF_ACTIONS,
      selectedId: selected,
      result: state.actionResult,
    }));
    bindShell();
    Chrome.bindActions(app, {
      onSelect: (id) => {
        state.actionResult = null;
        goTo('actions', id);
      },
      onRun: (id) => runStaffAction(id),
    });
  }

  function renderApiMap() {
    app.innerHTML = shell(Chrome.renderApiMap({ routes: API_ROUTES, view: state.apiView }));
    bindShell();
    Chrome.bindApiMap(app, {
      onToggle: (view) => {
        state.apiView = view;
        renderApiMap();
      },
      onOpen: (route) => {
        state.filters.path = route.path;
        goTo('http');
      },
    });
  }

  function bindExpand() {
    app.querySelectorAll('[data-expand]').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.dataset.expand;
        if (state.expanded.has(id)) state.expanded.delete(id);
        else state.expanded.add(id);
        render();
      });
    });
  }

  async function render() {
    if (!state.user) return renderLogin();
    try {
      if (state.page === 'logs') return await renderLogs();
      if (state.page === 'network') return await renderNetwork();
      if (state.page === 'http') return await renderHttp();
      if (state.page === 'vision') return await renderVision();
      if (state.page === 'billing') return await renderBilling();
      if (state.page === 'actions') return renderActions();
      if (state.page === 'api-map') return renderApiMap();
      return await renderOverview();
    } catch (err) {
      if (!state.user) return renderLogin(err.message === 'Staff login required' ? '' : err.message);
      app.innerHTML = shell(`<div class="error-banner">${esc(err.message)}</div>`);
      bindShell();
    }
  }

  window.addEventListener('hashchange', () => {
    const loc = parseLocation();
    state.page = loc.page;
    state.actionId = loc.page === 'actions' ? loc.detail : state.actionId;
    if (loc.page !== 'actions') state.actionResult = null;
    render();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    if (!state.user || omni?.isOpen()) return;
    e.preventDefault();
    omni?.open();
  });

  omni = Chrome.createOmni({
    placeholder: 'status:500 path:/analyze level:error  ·  or free text',
    isEnabled: () => Boolean(state.user),
    getNav: () => NAV_PAGES.map(([id, label]) => ({ id: `nav-${id}`, label: `Go to ${label}`, to: id })),
    getActions: () => STAFF_ACTIONS,
    getRoutes: () => API_ROUTES,
    go: (page) => goTo(page),
    openAction: (id) => {
      const match = STAFF_ACTIONS.find((a) => a.id === id || a.name === id);
      goTo('actions', match?.id || id);
    },
    openRoute: (route) => {
      state.filters.path = route.path;
      goTo('http');
    },
    applyNetwork: (tokens) => {
      if (tokens.path) state.filters.path = tokens.path;
      if (tokens.q) state.filters.q = tokens.q;
      goTo(tokens.path && (tokens.path.startsWith('/analyze') || tokens.path.startsWith('/confirm') || tokens.path.startsWith('/monitor') || tokens.path.startsWith('/health')) ? 'http' : 'network');
    },
    applyLogs: ({ request_id, q }) => {
      if (request_id) state.filters.q = request_id;
      if (q) state.filters.q = q;
      goTo('logs');
    },
    openHttp: (row) => {
      if (row.url) {
        state.filters.q = row.url;
        goTo('network');
        return;
      }
      state.filters.path = row.path || '';
      goTo('http');
    },
    openLog: (row) => {
      state.filters.q = row.request_id || (row.msg || row.message || '').slice(0, 80);
      if (row.level) state.filters.level = row.level;
      goTo('logs');
    },
    searchLive: async (q, tokens) => {
      const [logs, http, network] = await Promise.all([
        api(`/logs${qs({ q: tokens.q || q, level: tokens.level || '', limit: '8' })}`).catch(() => ({ rows: [] })),
        api(`/http${qs({ path: tokens.path || '', limit: '8' })}`).catch(() => ({ rows: [] })),
        api(`/network${qs({ q: tokens.q || q, limit: '8' })}`).catch(() => ({ rows: [] })),
      ]);
      return {
        logs: logs.rows || [],
        http: [...(http.rows || []), ...(network.rows || []).map((row) => ({ ...row, path: row.url || row.path }))],
      };
    },
  });

  (async () => {
    try {
      const me = await api('/auth/me');
      state.user = me.user;
      await loadFacets();
    } catch {
      state.user = null;
    }
    scheduleRefresh();
    render();
  })();
})();
