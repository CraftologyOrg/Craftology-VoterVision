import { getDb, getMonitorPaths, isMonitorReady } from './db.js';
import { sanitizeFtsQuery } from './redact.js';
import { RETENTION_MS } from './constants.js';
import { queueLength } from './writer.js';

const MAX_RANGE_MS = RETENTION_MS;
const DEFAULT_RANGE_MS = 24 * 60 * 60 * 1000;

export function parseTimeRange(query) {
  const now = Date.now();
  let from = query.from ? Number(query.from) : now - DEFAULT_RANGE_MS;
  let to = query.to ? Number(query.to) : now;
  if (!Number.isFinite(from)) from = now - DEFAULT_RANGE_MS;
  if (!Number.isFinite(to)) to = now;
  if (to < from) [from, to] = [to, from];
  if (to - from > MAX_RANGE_MS) from = to - MAX_RANGE_MS;
  const oldest = now - RETENTION_MS;
  if (from < oldest) from = oldest;
  return { from, to, now };
}

function clampLimit(raw, fallback = 100, max = 500) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, n);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function queryLogs(query) {
  const { from, to } = parseTimeRange(query);
  const limit = clampLimit(query.limit, 150, 500);
  const afterId = query.after_id ? parseInt(query.after_id, 10) : null;
  const fts = sanitizeFtsQuery(query.q);
  const params = { from, to, limit };
  const where = ['l.ts BETWEEN @from AND @to'];
  if (query.level) {
    where.push('l.level = @level');
    params.level = String(query.level);
  }
  if (query.task) {
    where.push('l.task = @task');
    params.task = String(query.task);
  }
  if (query.provider) {
    where.push('l.provider = @provider');
    params.provider = String(query.provider);
  }
  if (query.license_id) {
    where.push('l.license_id = @license_id');
    params.license_id = String(query.license_id);
  }
  if (afterId && Number.isFinite(afterId)) {
    where.push('l.id > @after_id');
    params.after_id = afterId;
  }
  if (fts) {
    where.push('l.id IN (SELECT rowid FROM app_logs_fts WHERE app_logs_fts MATCH @fts)');
    params.fts = fts;
  }

  const sql = `
    SELECT l.* FROM app_logs l
    WHERE ${where.join(' AND ')}
    ORDER BY l.id DESC
    LIMIT @limit
  `;
  let rows;
  try {
    rows = getDb().prepare(sql).all(params);
  } catch {
    const fallback = where.filter((clause) => !clause.includes('app_logs_fts'));
    if (query.q) {
      fallback.push('(l.msg LIKE @like OR l.error LIKE @like OR l.payload LIKE @like)');
      params.like = `%${String(query.q).slice(0, 80)}%`;
    }
    rows = getDb().prepare(`
      SELECT l.* FROM app_logs l
      WHERE ${fallback.join(' AND ')}
      ORDER BY l.id DESC
      LIMIT @limit
    `).all(params);
  }
  return { from, to, rows };
}

export function queryNetwork(query) {
  const { from, to } = parseTimeRange(query);
  const limit = clampLimit(query.limit, 150, 500);
  const afterId = query.after_id ? parseInt(query.after_id, 10) : null;
  const fts = sanitizeFtsQuery(query.q);
  const params = { from, to, limit };
  const where = ['n.ts BETWEEN @from AND @to'];
  if (query.service) {
    where.push('n.service = @service');
    params.service = String(query.service);
  }
  if (query.model) {
    where.push('n.model = @model');
    params.model = String(query.model);
  }
  if (query.task) {
    where.push('n.task = @task');
    params.task = String(query.task);
  }
  if (query.status) {
    where.push('n.status = @status');
    params.status = parseInt(query.status, 10);
  }
  if (query.min_latency) {
    where.push('n.latency_ms >= @min_latency');
    params.min_latency = parseInt(query.min_latency, 10);
  }
  if (afterId && Number.isFinite(afterId)) {
    where.push('n.id > @after_id');
    params.after_id = afterId;
  }
  if (query.errors === '1' || query.errors === 'true') {
    where.push('(n.error IS NOT NULL OR n.status >= 400 OR n.status IS NULL)');
  }
  if (fts) {
    where.push('n.id IN (SELECT rowid FROM network_calls_fts WHERE network_calls_fts MATCH @fts)');
    params.fts = fts;
  }
  const rowsSql = `
    SELECT n.* FROM network_calls n
    WHERE ${where.join(' AND ')}
    ORDER BY n.id DESC
    LIMIT @limit
  `;
  let rows;
  try {
    rows = getDb().prepare(rowsSql).all(params);
  } catch {
    const fallback = where.filter((clause) => !clause.includes('network_calls_fts'));
    if (query.q) {
      fallback.push('(n.url LIKE @like OR n.error LIKE @like OR n.response_excerpt LIKE @like)');
      params.like = `%${String(query.q).slice(0, 80)}%`;
    }
    rows = getDb().prepare(`
      SELECT n.* FROM network_calls n
      WHERE ${fallback.join(' AND ')}
      ORDER BY n.id DESC
      LIMIT @limit
    `).all(params);
  }
  return { from, to, rows };
}

export function queryHttp(query) {
  const { from, to } = parseTimeRange(query);
  const limit = clampLimit(query.limit, 150, 500);
  const params = { from, to, limit };
  const where = ['ts BETWEEN @from AND @to'];
  if (query.path) {
    where.push('path = @path');
    params.path = String(query.path);
  }
  if (query.task) {
    where.push('task = @task');
    params.task = String(query.task);
  }
  if (query.license_id) {
    where.push('license_id = @license_id');
    params.license_id = String(query.license_id);
  }
  if (query.status) {
    where.push('status = @status');
    params.status = parseInt(query.status, 10);
  }
  if (query.errors === '1' || query.errors === 'true') {
    where.push('status >= 400');
  }
  const rows = getDb().prepare(`
    SELECT * FROM http_requests
    WHERE ${where.join(' AND ')}
    ORDER BY id DESC
    LIMIT @limit
  `).all(params);
  return { from, to, rows };
}

export function queryVision(query) {
  const { from, to } = parseTimeRange(query);
  const limit = clampLimit(query.limit, 150, 500);
  const params = { from, to, limit };
  const where = ['ts BETWEEN @from AND @to'];
  if (query.task) {
    where.push('task = @task');
    params.task = String(query.task);
  }
  if (query.provider) {
    where.push('provider = @provider');
    params.provider = String(query.provider);
  }
  if (query.model) {
    where.push('model = @model');
    params.model = String(query.model);
  }
  if (query.success === '1' || query.success === '0') {
    where.push('success = @success');
    params.success = parseInt(query.success, 10);
  }
  if (query.license_id) {
    where.push('license_id = @license_id');
    params.license_id = String(query.license_id);
  }
  const rows = getDb().prepare(`
    SELECT * FROM vision_events
    WHERE ${where.join(' AND ')}
    ORDER BY id DESC
    LIMIT @limit
  `).all(params);
  return { from, to, rows };
}

export function querySeries(query) {
  const { from, to } = parseTimeRange(query);
  const span = to - from;
  const bucketMs = span > 14 * 24 * 3600 * 1000
    ? 60 * 60 * 1000
    : span > 2 * 24 * 3600 * 1000
      ? 15 * 60 * 1000
      : 60 * 1000;
  const rows = getDb().prepare(`
    SELECT
      (ts / ?) * ? AS ts,
      SUM(requests) AS requests,
      SUM(errors) AS errors,
      SUM(latency_sum) AS latency_sum,
      SUM(latency_count) AS latency_count,
      MAX(latency_max) AS latency_max,
      SUM(tokens) AS tokens,
      SUM(deepinfra_calls) AS deepinfra_calls,
      SUM(ollama_calls) AS ollama_calls,
      SUM(supabase_calls) AS supabase_calls,
      SUM(cache_hits) AS cache_hits,
      SUM(vision_success) AS vision_success,
      SUM(vision_fail) AS vision_fail
    FROM metrics_minute
    WHERE ts BETWEEN ? AND ?
    GROUP BY 1
    ORDER BY 1 ASC
  `).all(bucketMs, bucketMs, from, to);
  return { from, to, bucketMs, rows };
}

export function queryOverview(query) {
  const { from, to } = parseTimeRange(query);
  const db = getDb();
  const http = db.prepare(`
    SELECT
      COUNT(*) AS requests,
      SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
      AVG(latency_ms) AS avg_latency,
      MAX(latency_ms) AS max_latency,
      SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS cache_hits
    FROM http_requests
    WHERE ts BETWEEN ? AND ?
  `).get(from, to);

  const latencies = db.prepare(`
    SELECT latency_ms FROM http_requests
    WHERE ts BETWEEN ? AND ? AND path IN ('/analyze', '/confirm-vote') AND latency_ms IS NOT NULL
    ORDER BY id DESC
    LIMIT 8000
  `).all(from, to).map((r) => r.latency_ms).filter((n) => Number.isFinite(n));

  const vision = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(success) AS success,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS fail,
      SUM(cached) AS cached,
      AVG(latency_ms) AS avg_latency
    FROM vision_events
    WHERE ts BETWEEN ? AND ?
  `).get(from, to);

  const byTask = db.prepare(`
    SELECT task,
      COUNT(*) AS total,
      SUM(success) AS success,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS fail,
      AVG(latency_ms) AS avg_latency
    FROM vision_events
    WHERE ts BETWEEN ? AND ?
    GROUP BY task
    ORDER BY total DESC
  `).all(from, to);

  const byProvider = db.prepare(`
    SELECT COALESCE(provider, 'unknown') AS provider,
      COALESCE(model, '') AS model,
      COUNT(*) AS total,
      SUM(success) AS success,
      AVG(latency_ms) AS avg_latency,
      SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)) AS tokens
    FROM vision_events
    WHERE ts BETWEEN ? AND ?
    GROUP BY provider, model
    ORDER BY total DESC
  `).all(from, to);

  const network = db.prepare(`
    SELECT service,
      COUNT(*) AS total,
      SUM(CASE WHEN error IS NOT NULL OR status >= 400 OR status IS NULL THEN 1 ELSE 0 END) AS errors,
      AVG(latency_ms) AS avg_latency,
      SUM(COALESCE(total_tokens, 0)) AS tokens
    FROM network_calls
    WHERE ts BETWEEN ? AND ?
    GROUP BY service
    ORDER BY total DESC
  `).all(from, to);

  const recentErrors = db.prepare(`
    SELECT id, ts, level, msg, task, provider, model, error, request_id
    FROM app_logs
    WHERE ts BETWEEN ? AND ? AND level IN ('warn', 'error', 'fatal')
    ORDER BY id DESC
    LIMIT 25
  `).all(from, to);

  const billing = db.prepare(`
    SELECT * FROM billing_snapshots ORDER BY ts DESC LIMIT 1
  `).get();

  const billingSeries = db.prepare(`
    SELECT ts, available_usd, owed_usd, recent_usd, spending_limit_usd, suspended
    FROM billing_snapshots
    WHERE ts BETWEEN ? AND ? AND available_usd IS NOT NULL
    ORDER BY ts ASC
  `).all(from, to);

  const tokens = db.prepare(`
    SELECT SUM(COALESCE(total_tokens, 0)) AS tokens
    FROM network_calls
    WHERE ts BETWEEN ? AND ?
  `).get(from, to);

  return {
    from,
    to,
    http: {
      requests: http?.requests || 0,
      errors: http?.errors || 0,
      avg_latency: http?.avg_latency || 0,
      max_latency: http?.max_latency || 0,
      cache_hits: http?.cache_hits || 0,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
    },
    vision,
    byTask,
    byProvider,
    network,
    recentErrors,
    billing: billing || null,
    billingSeries,
    tokens: tokens?.tokens || 0,
  };
}

export function queryBillingHistory(query) {
  const { from, to } = parseTimeRange(query);
  const rows = getDb().prepare(`
    SELECT * FROM billing_snapshots
    WHERE ts BETWEEN ? AND ?
    ORDER BY ts DESC
    LIMIT 500
  `).all(from, to);
  return { from, to, rows };
}

export function queryFacets(query) {
  const { from, to } = parseTimeRange(query);
  const db = getDb();
  return {
    tasks: db.prepare(`
      SELECT DISTINCT task AS value FROM vision_events
      WHERE ts BETWEEN ? AND ? AND task IS NOT NULL
      ORDER BY task
    `).all(from, to).map((r) => r.value),
    providers: db.prepare(`
      SELECT DISTINCT provider AS value FROM vision_events
      WHERE ts BETWEEN ? AND ? AND provider IS NOT NULL
      ORDER BY provider
    `).all(from, to).map((r) => r.value),
    models: db.prepare(`
      SELECT DISTINCT model AS value FROM vision_events
      WHERE ts BETWEEN ? AND ? AND model IS NOT NULL
      ORDER BY model
    `).all(from, to).map((r) => r.value),
    services: db.prepare(`
      SELECT DISTINCT service AS value FROM network_calls
      WHERE ts BETWEEN ? AND ? AND service IS NOT NULL
      ORDER BY service
    `).all(from, to).map((r) => r.value),
    levels: db.prepare(`
      SELECT DISTINCT level AS value FROM app_logs
      WHERE ts BETWEEN ? AND ?
      ORDER BY level
    `).all(from, to).map((r) => r.value),
  };
}

export function queryStorageStats() {
  const db = getDb();
  const counts = {
    app_logs: db.prepare('SELECT COUNT(*) AS n FROM app_logs').get().n,
    http_requests: db.prepare('SELECT COUNT(*) AS n FROM http_requests').get().n,
    network_calls: db.prepare('SELECT COUNT(*) AS n FROM network_calls').get().n,
    vision_events: db.prepare('SELECT COUNT(*) AS n FROM vision_events').get().n,
    billing_snapshots: db.prepare('SELECT COUNT(*) AS n FROM billing_snapshots').get().n,
    metrics_minute: db.prepare('SELECT COUNT(*) AS n FROM metrics_minute').get().n,
  };
  let pageCount = 0;
  let pageSize = 0;
  try {
    pageCount = db.pragma('page_count', { simple: true });
    pageSize = db.pragma('page_size', { simple: true });
  } catch {
    pageCount = 0;
    pageSize = 0;
  }
  return {
    ready: isMonitorReady(),
    paths: getMonitorPaths(),
    counts,
    db_bytes: pageCount * pageSize,
    write_queue: queueLength(),
    retention_days: 60,
  };
}
