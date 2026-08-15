import crypto from 'crypto';
import { recordNetworkCall } from './monitor/network.js';
import { stringifySafe, truncate } from './monitor/redact.js';

const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL_PREFIX = 'moondream';
let resolvedModelName = 'moondream2'; // fallback; overwritten once Ollama confirms the real name
const TIMEOUT_MS = parseInt(process.env.VISION_TIMEOUT_MS, 10) || 20000;
const CACHE_TTL_MS = parseInt(process.env.VISION_CACHE_TTL_MS, 10) || 30000;
const CACHE_MAX_ENTRIES = parseInt(process.env.VISION_CACHE_MAX_ENTRIES, 10) || 500;

// Keep model loaded for 30 minutes to avoid reload penalty between votes
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';

// Moondream responses are small JSON blobs — cap tokens per task to avoid
// generating dead tokens on CPU hardware where every token costs real time.
const TASK_NUM_PREDICT = {
  check_page_ready: 100,
  find_submit_button: 150,
  detect_captcha: 150,
  locate_captcha_checkbox: 180,
  detect_vote_result: 150,
  confirm_vote: 180,
  find_input_fields: 256,
};
const TASK_TIMEOUT_MS = {
  locate_captcha_checkbox: Math.min(12000, TIMEOUT_MS),
};

function timeoutSignal(ms, upstreamSignal) {
  if (!upstreamSignal) return AbortSignal.timeout(ms);
  return AbortSignal.any([upstreamSignal, AbortSignal.timeout(ms)]);
}

const cache = new Map();
function enforceCacheLimit() {
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt < now) cache.delete(key);
  }
}, 60000).unref();

function cacheKey(task, prompt, screenshotB64) {
  const hash = crypto.createHash('sha256')
    .update(task)
    .update(prompt || '')
    .update(screenshotB64)
    .digest('hex');
  return `${task}:${hash}`;
}

let modelReady = false;
let lastSuccessfulModelCallAt = 0;

export async function checkModelAvailable() {
  const url = `${OLLAMA_BASE}/api/tags`;
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      modelReady = false;
      recordNetworkCall({
        service: 'ollama',
        method: 'GET',
        url,
        status: resp.status,
        latency_ms: Date.now() - start,
        error: `HTTP ${resp.status}`,
      });
      return false;
    }
    const data = await resp.json();
    const models = data.models || [];
    const found = models.find(m => m.name && m.name.startsWith(MODEL_PREFIX));
    modelReady = !!found;
    if (found) resolvedModelName = found.name;
    recordNetworkCall({
      service: 'ollama',
      method: 'GET',
      url,
      status: resp.status,
      latency_ms: Date.now() - start,
      model: found?.name || null,
      request_excerpt: stringifySafe({ probe: 'tags' }),
      response_excerpt: stringifySafe({ models: models.map((m) => m.name).slice(0, 20) }),
    });
    return modelReady;
  } catch (err) {
    modelReady = false;
    recordNetworkCall({
      service: 'ollama',
      method: 'GET',
      url,
      latency_ms: Date.now() - start,
      error: err.message || String(err),
    });
    return false;
  }
}

export function isModelReady() {
  return modelReady;
}

export function getLastSuccessfulModelCallAt() {
  return lastSuccessfulModelCallAt;
}

export async function warmupModel() {
  if (!modelReady) return;
  const url = `${OLLAMA_BASE}/api/generate`;
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: resolvedModelName,
        prompt: 'hi',
        stream: false,
        keep_alive: KEEP_ALIVE,
        options: { num_predict: 1 },
      }),
      signal: AbortSignal.timeout(30000),
    });
    recordNetworkCall({
      service: 'ollama',
      method: 'POST',
      url,
      status: resp.status,
      latency_ms: Date.now() - start,
      model: resolvedModelName,
      request_excerpt: stringifySafe({ probe: 'warmup', model: resolvedModelName }),
    });
  } catch (err) {
    recordNetworkCall({
      service: 'ollama',
      method: 'POST',
      url,
      latency_ms: Date.now() - start,
      model: resolvedModelName,
      error: err.message || String(err),
      request_excerpt: stringifySafe({ probe: 'warmup' }),
    });
  }
}

export async function queryModel(prompt, screenshotB64, task, signal) {
  const key = cacheKey(task, prompt, screenshotB64);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { response: cached.response, cached: true };
  }

  if (!modelReady) {
    return { error: 'model_unavailable', message: 'moondream2 is not loaded or available', fallback: true };
  }

  const start = Date.now();
  const requestTimeoutMs = TASK_TIMEOUT_MS[task] ?? TIMEOUT_MS;
  const url = `${OLLAMA_BASE}/api/generate`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: resolvedModelName,
        prompt,
        images: [screenshotB64],
        stream: false,
        keep_alive: KEEP_ALIVE,
        options: {
          temperature: 0.1,
          num_predict: TASK_NUM_PREDICT[task] ?? 256,
        },
      }),
      signal: timeoutSignal(requestTimeoutMs, signal),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      recordNetworkCall({
        service: 'ollama',
        method: 'POST',
        url,
        status: resp.status,
        latency_ms: Date.now() - start,
        model: resolvedModelName,
        task,
        error: `HTTP ${resp.status}`,
        request_excerpt: stringifySafe({ model: resolvedModelName, task, num_predict: TASK_NUM_PREDICT[task] ?? 256 }),
        response_excerpt: truncate(text, 800),
      });
      if (text.includes('not found') || text.includes('pull')) {
        modelReady = false;
        return { error: 'model_unavailable', message: `${resolvedModelName} not available: ${text.slice(0, 200)}`, fallback: true };
      }
      return { error: 'model_unavailable', message: `Ollama returned ${resp.status}: ${text.slice(0, 200)}`, fallback: true };
    }

    const data = await resp.json();
    const latencyMs = Date.now() - start;
    const response = data.response || '';
    modelReady = true;
    lastSuccessfulModelCallAt = Date.now();

    recordNetworkCall({
      service: 'ollama',
      method: 'POST',
      url,
      status: resp.status,
      latency_ms: latencyMs,
      model: resolvedModelName,
      task,
      request_excerpt: stringifySafe({ model: resolvedModelName, task, num_predict: TASK_NUM_PREDICT[task] ?? 256 }),
      response_excerpt: truncate(response, 800),
    });

    cache.set(key, { response, expiresAt: Date.now() + CACHE_TTL_MS });
    enforceCacheLimit();

    return { response, latencyMs, cached: false };
  } catch (err) {
    recordNetworkCall({
      service: 'ollama',
      method: 'POST',
      url,
      latency_ms: Date.now() - start,
      model: resolvedModelName,
      task,
      error: err.message || String(err),
      request_excerpt: stringifySafe({ model: resolvedModelName, task }),
    });
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      // Timeout does not imply model is unavailable; keep readiness state as-is.
      return { error: 'timeout', message: `moondream2 did not respond within ${requestTimeoutMs}ms`, fallback: true };
    }
    modelReady = false;
    return { error: 'model_unavailable', message: err.message || String(err), fallback: true };
  }
}
