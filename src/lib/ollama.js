import crypto from 'crypto';

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
  find_input_fields: 256,
};

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
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      modelReady = false;
      return false;
    }
    const data = await resp.json();
    const models = data.models || [];
    const found = models.find(m => m.name && m.name.startsWith(MODEL_PREFIX));
    modelReady = !!found;
    if (found) resolvedModelName = found.name;
    return modelReady;
  } catch {
    modelReady = false;
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
  try {
    await fetch(`${OLLAMA_BASE}/api/generate`, {
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
  } catch {
    // warmup failure is non-fatal
  }
}

export async function queryModel(prompt, screenshotB64, task) {
  const key = cacheKey(task, prompt, screenshotB64);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { response: cached.response, cached: true };
  }

  if (!modelReady) {
    return { error: 'model_unavailable', message: 'moondream2 is not loaded or available', fallback: true };
  }

  const start = Date.now();

  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
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

    cache.set(key, { response, expiresAt: Date.now() + CACHE_TTL_MS });
    enforceCacheLimit();

    return { response, latencyMs, cached: false };
  } catch (err) {
    modelReady = false;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { error: 'timeout', message: `moondream2 did not respond within ${TIMEOUT_MS}ms`, fallback: true };
    }
    return { error: 'model_unavailable', message: err.message || String(err), fallback: true };
  }
}
