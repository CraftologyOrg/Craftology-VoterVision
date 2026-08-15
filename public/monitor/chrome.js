(() => {
  const TOKEN_KEYS = new Set([
    'status', 'action', 'user', 'path', 'method', 'ip', 'level',
    'request_id', 'requestid', 'module',
  ]);

  const LOCK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden><rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.7"/></svg>';
  const SEARCH_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="M20 20l-3.2-3.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parseSearchQuery(input) {
    const tokens = { q: '' };
    const leftover = [];
    const parts = String(input || '').trim().split(/\s+/).filter(Boolean);
    for (const part of parts) {
      const colon = part.indexOf(':');
      if (colon <= 0) {
        leftover.push(part);
        continue;
      }
      const key = part.slice(0, colon).toLowerCase();
      let value = part.slice(colon + 1);
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!value || !TOKEN_KEYS.has(key)) {
        leftover.push(part);
        continue;
      }
      if (key === 'requestid' || key === 'request_id') tokens.request_id = value;
      else if (key === 'method') tokens.method = value.toUpperCase();
      else tokens[key] = value;
    }
    tokens.q = leftover.join(' ').trim();
    return tokens;
  }

  function tokenChips(tokens) {
    const chips = [];
    for (const key of ['method', 'status', 'path', 'action', 'user', 'ip', 'level', 'module', 'request_id']) {
      if (tokens[key]) chips.push({ key, value: tokens[key] });
    }
    if (tokens.q) chips.push({ key: 'q', value: tokens.q });
    return chips;
  }

  function methodClass(method) {
    const m = String(method || '').toUpperCase();
    if (m === 'GET') return 'm-get';
    if (m === 'POST') return 'm-post';
    if (m === 'PUT') return 'm-put';
    if (m === 'PATCH') return 'm-patch';
    if (m === 'DELETE') return 'm-del';
    return 'm-other';
  }

  function methodBadge(method) {
    const m = String(method || '—').toUpperCase();
    return `<span class="badge ${methodClass(m)}">${esc(m)}</span>`;
  }

  function authBadge(auth) {
    const a = String(auth || 'none').toLowerCase();
    const lock = a !== 'none' && a !== 'public'
      ? `<span class="lock" title="Auth required">${LOCK_SVG}</span>`
      : '';
    const label = a === 'none' || a === 'public' ? 'public' : a;
    const cls = a === 'public' ? 'none' : a;
    return `${lock}<span class="auth-pill ${esc(cls)}">${esc(label)}</span>`;
  }

  function groupPath(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    if (parts[0] === 'monitor' && parts[1] === 'api') return '/monitor/api';
    if (parts[0] === 'api' && parts[1] === 'monitor') return '/api/monitor';
    if (parts[0] === 'api' && parts[1] === 'v1' && parts[2]) return `/api/v1/${parts[2]}`;
    if (parts[0] === 'api' && parts[1] === 'solve') return '/api/solve/autovoter';
    if (parts[0] === 'api' && parts[1]) return `/api/${parts[1]}`;
    if (parts[0] === 'api') return '/api';
    return `/${parts[0] ?? ''}`;
  }

  function insertRoute(root, route) {
    const parts = String(route.path || '/').split('/').filter(Boolean);
    let node = root;
    for (const part of parts) {
      let next = node.children.get(part);
      if (!next) {
        next = { segment: part, children: new Map(), routes: [] };
        node.children.set(part, next);
      }
      node = next;
    }
    node.routes.push(route);
  }

  function buildTree(routes) {
    const root = { segment: '', children: new Map(), routes: [] };
    for (const route of routes) insertRoute(root, route);
    return root;
  }

  function routeRow(route) {
    return `
      <button type="button" class="route-row" data-method="${esc(route.method)}" data-path="${esc(route.path)}">
        ${methodBadge(route.method)}
        ${authBadge(route.auth)}
        <span class="cell-ellipsis">${esc(route.path)}</span>
        <span class="count-pill">${esc(route.action || '')}</span>
      </button>
    `;
  }

  function renderTree(node, depth) {
    const kids = [...node.children.values()].sort((a, b) => a.segment.localeCompare(b.segment));
    const childHtml = kids.map((child) => `
      <details ${depth < 1 ? 'open' : ''}>
        <summary>/${esc(child.segment)}</summary>
        ${child.routes.map(routeRow).join('')}
        ${renderTree(child, depth + 1)}
      </details>
    `).join('');
    const rootRoutes = depth === 0 ? node.routes.map(routeRow).join('') : '';
    return `<div class="tree" style="padding-left:${depth === 0 ? 0 : 10}px">${childHtml}${rootRoutes}</div>`;
  }

  function renderWire(routes) {
    const map = new Map();
    for (const route of routes) {
      const key = groupPath(route.path);
      const list = map.get(key) ?? [];
      list.push(route);
      map.set(key, list);
    }
    const groups = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (!groups.length) return '<div class="empty">No routes in catalog.</div>';
    return `<div class="wire-grid">${groups.map(([group, list]) => `
      <section class="wire-card">
        <h3>${esc(group || '/')}</h3>
        ${list.slice().sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)).map(routeRow).join('')}
      </section>
    `).join('')}</div>`;
  }

  function renderApiMap({ routes, view }) {
    return `
      <div class="api-map-tools">
        <div class="view-toggle">
          <button type="button" class="chip ${view === 'wire' ? 'active' : ''}" data-api-view="wire">Wireframe</button>
          <button type="button" class="chip ${view === 'tree' ? 'active' : ''}" data-api-view="tree">Tree</button>
        </div>
      </div>
      ${view === 'tree'
        ? `<section class="card"><h3>Collapsible tree</h3>${renderTree(buildTree(routes), 0)}</section>`
        : renderWire(routes)}
    `;
  }

  function bindApiMap(root, { onToggle, onOpen }) {
    root.querySelectorAll('[data-api-view]').forEach((btn) => {
      btn.addEventListener('click', () => onToggle(btn.dataset.apiView));
    });
    root.querySelectorAll('.route-row').forEach((btn) => {
      btn.addEventListener('click', () => onOpen({ method: btn.dataset.method, path: btn.dataset.path }));
    });
  }

  function renderActions({ actions, selectedId, result }) {
    const selected = actions.find((a) => a.id === selectedId) || null;
    return `
      <div class="actions-layout">
        <aside class="side-list">
          ${actions.map((action) => `
            <button type="button" class="side-item ${action.id === selectedId ? 'active' : ''}" data-action="${esc(action.id)}">
              <span class="cell-ellipsis">${esc(action.label)}</span>
              <span class="count-pill">${esc(action.kind)}</span>
            </button>
          `).join('')}
        </aside>
        <section class="action-detail">
          ${selected ? `
            <h2>${esc(selected.label)}</h2>
            <p>${esc(selected.hint || 'Staff-only. Runs in your current monitor session.')}</p>
            <p class="mono">${esc(selected.name || selected.id)}</p>
            <button type="button" class="btn" data-run="${esc(selected.id)}">Run</button>
            ${result ? `<p class="${result.ok ? '' : 'error-line'}" style="text-align:left;padding:12px 0 0">${esc(result.message)}</p>` : ''}
          ` : '<div class="empty">Select an action type to inspect or run it.</div>'}
        </section>
      </div>
    `;
  }

  function bindActions(root, { onSelect, onRun }) {
    root.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => onSelect(btn.dataset.action));
    });
    root.querySelector('[data-run]')?.addEventListener('click', () => {
      onRun(root.querySelector('[data-run]').dataset.run);
    });
  }

  function createOmni(opts) {
    const root = document.createElement('div');
    root.className = 'palette-root';
    root.hidden = true;
    root.setAttribute('role', 'presentation');
    document.body.appendChild(root);

    let q = '';
    let active = 0;
    let items = [];
    let results = { http: [], logs: [], actions: [] };
    let loading = false;
    let timer = null;
    let open = false;

    function closeAnd(fn) {
      return () => {
        setOpen(false);
        fn();
      };
    }

    function buildItems() {
      const list = [];
      const trimmed = q.trim();
      const tokens = parseSearchQuery(trimmed);
      const nav = opts.getNav() || [];
      const staff = opts.getActions() || [];
      const routes = opts.getRoutes() || [];

      if (trimmed) {
        list.push({
          id: 'apply-network',
          group: 'Apply',
          label: 'Open Network with these filters',
          meta: 'Enter',
          run: closeAnd(() => opts.applyNetwork(tokens)),
        });
        if (tokens.request_id) {
          list.push({
            id: 'apply-logs',
            group: 'Apply',
            label: `Jump to logs for ${tokens.request_id}`,
            run: closeAnd(() => opts.applyLogs({ request_id: tokens.request_id })),
          });
        }
        if (tokens.action) {
          list.push({
            id: 'apply-action',
            group: 'Apply',
            label: `Open action ${tokens.action}`,
            run: closeAnd(() => opts.openAction(tokens.action)),
          });
        }
      }

      for (const cmd of nav) {
        if (!trimmed || cmd.label.toLowerCase().includes(trimmed.toLowerCase()) || String(cmd.to).includes(trimmed)) {
          list.push({
            id: cmd.id,
            group: 'Navigate',
            label: cmd.label,
            meta: cmd.to,
            run: closeAnd(() => opts.go(cmd.to)),
          });
        }
      }

      for (const action of staff) {
        const hay = `${action.label} ${action.name || ''} ${action.id}`.toLowerCase();
        if (!trimmed || hay.includes(trimmed.toLowerCase()) || (tokens.action && hay.includes(tokens.action.toLowerCase()))) {
          list.push({
            id: `act-${action.id}`,
            group: 'Actions',
            label: action.label,
            meta: action.name || action.kind,
            run: closeAnd(() => opts.openAction(action.id)),
          });
        }
      }

      for (const route of routes) {
        const hay = `${route.method} ${route.path} ${route.action || ''}`.toLowerCase();
        if (!trimmed || hay.includes(trimmed.toLowerCase()) || (tokens.path && route.path.includes(tokens.path))) {
          list.push({
            id: `api-${route.method}-${route.path}`,
            group: 'API',
            label: `${route.method} ${route.path}`,
            meta: route.auth,
            method: route.method,
            run: closeAnd(() => opts.openRoute(route)),
          });
        }
      }

      for (const row of results.http || []) {
        list.push({
          id: `http-${row.id}`,
          group: 'HTTP',
          label: `${row.method || ''} ${row.path || row.url || ''}`,
          meta: `${row.status ?? ''} · ${row.ts || ''}`,
          method: row.method,
          run: closeAnd(() => opts.openHttp(row)),
        });
      }
      for (const row of results.logs || []) {
        list.push({
          id: `log-${row.id}`,
          group: 'Logs',
          label: row.msg || row.message || row.error || 'log',
          meta: `${row.level || ''} · ${row.task || row.category || ''}`,
          run: closeAnd(() => opts.openLog(row)),
        });
      }
      return list;
    }

    function paint() {
      items = buildItems();
      if (active >= items.length) active = Math.max(0, items.length - 1);
      const chips = tokenChips(parseSearchQuery(q));
      const groups = {};
      for (const item of items) (groups[item.group] ??= []).push(item);
      let running = -1;
      root.innerHTML = `
        <div class="palette" role="dialog" aria-label="Omnisearch">
          <input class="search-input" value="${esc(q)}" placeholder="${esc(opts.placeholder || 'status:500 path:/health  ·  or free text')}" />
          ${chips.length ? `<div class="chips">${chips.map((c) => `<span class="token-chip">${esc(c.key)}:${esc(c.value)}</span>`).join('')}</div>` : ''}
          <div class="palette-list">
            ${loading ? '<div class="loading-line">Searching…</div>' : ''}
            ${Object.entries(groups).map(([group, groupItems]) => `
              <div class="palette-group">
                <h3>${esc(group)}</h3>
                ${groupItems.map((item) => {
                  running += 1;
                  const index = running;
                  const httpBits = group === 'HTTP' && item.label.includes(' ')
                    ? `${methodBadge(item.method || item.label.split(' ')[0])}<span class="cell-ellipsis">${esc(item.label.slice(item.label.indexOf(' ') + 1))}</span>`
                    : `<span class="cell-ellipsis">${esc(item.label)}</span>`;
                  return `<button type="button" class="palette-item ${index === active ? 'active' : ''}" data-index="${index}">${httpBits}${item.meta ? `<span class="meta">${esc(item.meta)}</span>` : ''}</button>`;
                }).join('')}
              </div>
            `).join('')}
            ${!loading && items.length === 0 ? '<div class="empty">No matches. Tokens: status action user path method ip level request_id</div>' : ''}
          </div>
        </div>
      `;
      const input = root.querySelector('input');
      if (document.activeElement !== input) {
        const pos = q.length;
        input.focus();
        input.setSelectionRange(pos, pos);
      }
      input.addEventListener('input', (e) => {
        q = e.target.value;
        scheduleSearch();
        paint();
        input.focus();
      });
      root.querySelectorAll('.palette-item').forEach((btn) => {
        btn.addEventListener('mouseenter', () => {
          active = Number(btn.dataset.index);
          root.querySelectorAll('.palette-item').forEach((el) => el.classList.toggle('active', el === btn));
        });
        btn.addEventListener('click', () => items[Number(btn.dataset.index)]?.run());
      });
    }

    function scheduleSearch() {
      const trimmed = q.trim();
      window.clearTimeout(timer);
      if (!trimmed || !opts.searchLive) {
        results = { http: [], logs: [], actions: [] };
        loading = false;
        return;
      }
      loading = true;
      const tokens = parseSearchQuery(trimmed);
      timer = window.setTimeout(() => {
        opts.searchLive(trimmed, tokens)
          .then((data) => {
            results = data || { http: [], logs: [] };
            loading = false;
            if (open) paint();
          })
          .catch(() => {
            results = { http: [], logs: [] };
            loading = false;
            if (open) paint();
          });
      }, 220);
    }

    function setOpen(next) {
      open = next;
      root.hidden = !next;
      if (next) {
        q = '';
        results = { http: [], logs: [] };
        active = 0;
        loading = false;
        paint();
      }
    }

    root.addEventListener('click', (e) => {
      if (e.target === root) setOpen(false);
    });

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        if (opts.isEnabled && !opts.isEnabled()) return;
        e.preventDefault();
        setOpen(true);
        return;
      }
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        active = Math.min(items.length - 1, active + 1);
        paint();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        active = Math.max(0, active - 1);
        paint();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        items[active]?.run();
      }
    });

    return {
      open: () => setOpen(true),
      close: () => setOpen(false),
      isOpen: () => open,
      SEARCH_SVG,
    };
  }

  window.MonitorChrome = {
    esc,
    parseSearchQuery,
    tokenChips,
    methodBadge,
    authBadge,
    groupPath,
    renderApiMap,
    bindApiMap,
    renderActions,
    bindActions,
    createOmni,
    SEARCH_SVG,
  };
})();
