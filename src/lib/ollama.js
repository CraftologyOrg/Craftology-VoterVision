import crypto from 'crypto';

const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = 'moondream2';
const TIMEOUT_MS = 15000;
const CACHE_TTL_MS = parseInt(process.env.VISION_CACHE_TTL_MS, 10) || 30000;

const cache = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt < now) cache.delete(key);
  }
}, 60000).unref();

function cacheKey(task, screenshotB64) {
  const hash = crypto.createHash('sha256')
    .update(task)
    .update(screenshotB64.slice(0, 2048))
    .update(screenshotB64.slice(-2048))
    .update(String(screenshotB64.length))
    .digest('hex');
  return `${task}:${hash}`;
}

let modelReady = false;

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
    modelReady = models.some(m => m.name && m.name.startsWith('moondream'));
    return modelReady;
  } catch {
    modelReady = false;
    return false;
  }
}

export function isModelReady() {
  return modelReady;
}

export async function queryModel(prompt, screenshotB64) {
  const key = cacheKey(prompt, screenshotB64);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { response: cached.response, cached: true };
  }

  if (!modelReady) {
    await checkModelAvailable();
    if (!modelReady) {
      return { error: 'model_unavailable', message: 'moondream2 is not loaded or available', fallback: true };
    }
  }

  const start = Date.now();

  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        images: [screenshotB64],
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 512,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      if (text.includes('not found') || text.includes('pull')) {
        modelReady = false;
        return { error: 'model_unavailable', message: `moondream2 not available: ${text.slice(0, 200)}`, fallback: true };
      }
      return { error: 'model_unavailable', message: `Ollama returned ${resp.status}: ${text.slice(0, 200)}`, fallback: true };
    }

    const data = await resp.json();
    const latencyMs = Date.now() - start;
    const response = data.response || '';

    cache.set(key, { response, expiresAt: Date.now() + CACHE_TTL_MS });

    return { response, latencyMs, cached: false };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { error: 'timeout', message: `moondream2 did not respond within ${TIMEOUT_MS}ms`, fallback: true };
    }
    return { error: 'model_unavailable', message: err.message || String(err), fallback: true };
  }
}
