import { getDb } from './db.js';
import { FLUSH_BATCH_SIZE, FLUSH_INTERVAL_MS, RETENTION_MS } from './constants.js';

const queue = [];
let flushTimer = null;
let flushing = false;
let insertLog;
let insertHttp;
let insertNetwork;
let insertVision;
let insertBilling;
let bumpMetrics;

function minuteBucket(ts) {
  return Math.floor(ts / 60000) * 60000;
}

function ensureStatements() {
  if (insertLog) return;
  const db = getDb();
  insertLog = db.prepare(`
    INSERT INTO app_logs (ts, level, msg, request_id, task, provider, model, license_id, error, payload)
    VALUES (@ts, @level, @msg, @request_id, @task, @provider, @model, @license_id, @error, @payload)
  `);
  insertHttp = db.prepare(`
    INSERT INTO http_requests (
      ts, method, path, status, latency_ms, license_id, user_id, task, provider, model,
      cached, error, queue_wait_ms, ip, request_id
    ) VALUES (
      @ts, @method, @path, @status, @latency_ms, @license_id, @user_id, @task, @provider, @model,
      @cached, @error, @queue_wait_ms, @ip, @request_id
    )
  `);
  insertNetwork = db.prepare(`
    INSERT INTO network_calls (
      ts, service, method, url, status, latency_ms, error, model, task,
      prompt_tokens, completion_tokens, total_tokens, request_id, request_excerpt, response_excerpt
    ) VALUES (
      @ts, @service, @method, @url, @status, @latency_ms, @error, @model, @task,
      @prompt_tokens, @completion_tokens, @total_tokens, @request_id, @request_excerpt, @response_excerpt
    )
  `);
  insertVision = db.prepare(`
    INSERT INTO vision_events (
      ts, task, success, cached, provider, model, latency_ms, error, attempts_json,
      license_id, prompt_tokens, completion_tokens, queue_wait_ms, request_id
    ) VALUES (
      @ts, @task, @success, @cached, @provider, @model, @latency_ms, @error, @attempts_json,
      @license_id, @prompt_tokens, @completion_tokens, @queue_wait_ms, @request_id
    )
  `);
  insertBilling = db.prepare(`
    INSERT INTO billing_snapshots (
      ts, stripe_balance, available_usd, owed_usd, recent_usd, spending_limit_usd,
      suspended, suspend_reason, usage_json, checklist_json, error
    ) VALUES (
      @ts, @stripe_balance, @available_usd, @owed_usd, @recent_usd, @spending_limit_usd,
      @suspended, @suspend_reason, @usage_json, @checklist_json, @error
    )
  `);
  bumpMetrics = db.prepare(`
    INSERT INTO metrics_minute (
      ts, requests, errors, latency_sum, latency_count, latency_max, tokens,
      deepinfra_calls, ollama_calls, supabase_calls, cache_hits, vision_success, vision_fail
    ) VALUES (
      @ts, @requests, @errors, @latency_sum, @latency_count, @latency_max, @tokens,
      @deepinfra_calls, @ollama_calls, @supabase_calls, @cache_hits, @vision_success, @vision_fail
    )
    ON CONFLICT(ts) DO UPDATE SET
      requests = requests + excluded.requests,
      errors = errors + excluded.errors,
      latency_sum = latency_sum + excluded.latency_sum,
      latency_count = latency_count + excluded.latency_count,
      latency_max = MAX(latency_max, excluded.latency_max),
      tokens = tokens + excluded.tokens,
      deepinfra_calls = deepinfra_calls + excluded.deepinfra_calls,
      ollama_calls = ollama_calls + excluded.ollama_calls,
      supabase_calls = supabase_calls + excluded.supabase_calls,
      cache_hits = cache_hits + excluded.cache_hits,
      vision_success = vision_success + excluded.vision_success,
      vision_fail = vision_fail + excluded.vision_fail
  `);
}

function emptyMetrics(ts) {
  return {
    ts: minuteBucket(ts),
    requests: 0,
    errors: 0,
    latency_sum: 0,
    latency_count: 0,
    latency_max: 0,
    tokens: 0,
    deepinfra_calls: 0,
    ollama_calls: 0,
    supabase_calls: 0,
    cache_hits: 0,
    vision_success: 0,
    vision_fail: 0,
  };
}

function applyMetrics(item, metrics) {
  const row = item.row || {};
  if (item.type === 'http') {
    metrics.requests += 1;
    if ((row.status || 0) >= 400) metrics.errors += 1;
    const latency = Number(row.latency_ms) || 0;
    if (latency > 0) {
      metrics.latency_sum += latency;
      metrics.latency_count += 1;
      if (latency > metrics.latency_max) metrics.latency_max = latency;
    }
    if (row.cached) metrics.cache_hits += 1;
  } else if (item.type === 'network') {
    const tokens = Number(row.total_tokens) || ((Number(row.prompt_tokens) || 0) + (Number(row.completion_tokens) || 0));
    metrics.tokens += tokens;
    if (row.service === 'deepinfra' || row.service === 'billing') metrics.deepinfra_calls += 1;
    if (row.service === 'ollama') metrics.ollama_calls += 1;
    if (row.service === 'supabase') metrics.supabase_calls += 1;
  } else if (item.type === 'vision') {
    if (row.success) metrics.vision_success += 1;
    else metrics.vision_fail += 1;
    if (row.cached) metrics.cache_hits += 1;
    const tokens = (Number(row.prompt_tokens) || 0) + (Number(row.completion_tokens) || 0);
    metrics.tokens += tokens;
    const latency = Number(row.latency_ms) || 0;
    if (latency > 0) {
      metrics.latency_sum += latency;
      metrics.latency_count += 1;
      if (latency > metrics.latency_max) metrics.latency_max = latency;
    }
  }
}

function insertItem(item) {
  const row = item.row;
  switch (item.type) {
    case 'log':
      insertLog.run(row);
      break;
    case 'http':
      insertHttp.run(row);
      break;
    case 'network':
      insertNetwork.run(row);
      break;
    case 'vision':
      insertVision.run(row);
      break;
    case 'billing':
      insertBilling.run(row);
      break;
    default:
      break;
  }
}

export function enqueue(type, row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row || {})) {
    normalized[key] = value === undefined ? null : value;
  }
  queue.push({ type, row: normalized });
  if (queue.length >= FLUSH_BATCH_SIZE) {
    flushMonitorWrites();
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushMonitorWrites();
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }
}

export function flushMonitorWrites() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    ensureStatements();
    const batch = queue.splice(0, 400);
    const db = getDb();
    const run = db.transaction((items) => {
      const metricsByMinute = new Map();
      for (const item of items) {
        insertItem(item);
        if (item.type === 'http' || item.type === 'network' || item.type === 'vision') {
          const ts = item.row.ts || Date.now();
          const key = minuteBucket(ts);
          let metrics = metricsByMinute.get(key);
          if (!metrics) {
            metrics = emptyMetrics(ts);
            metricsByMinute.set(key, metrics);
          }
          applyMetrics(item, metrics);
        }
      }
      for (const metrics of metricsByMinute.values()) bumpMetrics.run(metrics);
    });
    run(batch);
  } catch (err) {
    process.stderr.write(`[monitor] flush failed: ${err.message}\n`);
  } finally {
    flushing = false;
    if (queue.length) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushMonitorWrites();
      }, 40);
      flushTimer.unref?.();
    }
  }
}

export function pruneExpiredRows(now = Date.now()) {
  const cutoff = now - RETENTION_MS;
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare('DELETE FROM app_logs WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM http_requests WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM network_calls WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM vision_events WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM metrics_minute WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM billing_snapshots WHERE ts < ?').run(cutoff);
    db.prepare('DELETE FROM staff_sessions WHERE last_seen_at < ?').run(now - 14 * 24 * 60 * 60 * 1000);
  });
  run();
}

export function queueLength() {
  return queue.length;
}
