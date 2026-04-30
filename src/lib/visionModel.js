import crypto from 'crypto';
import {
  checkModelAvailable as checkOllamaAvailable,
  getLastSuccessfulModelCallAt as getLastSuccessfulOllamaCallAt,
  isModelReady as isOllamaReady,
  queryModel as queryOllamaModel,
  warmupModel as warmupOllamaModel,
} from './ollama.js';

const DEEPINFRA_BASE_URL = process.env.DEEPINFRA_BASE_URL || 'https://api.deepinfra.com/v1/openai';
const DEEPINFRA_API_KEY = process.env.DEEPINFRA_API_KEY || process.env.DEEPINFRA_TOKEN || '';
const TIMEOUT_MS = parseInt(process.env.VISION_TIMEOUT_MS, 10) || 20000;
const DEEPINFRA_TIMEOUT_MS = parseInt(process.env.DEEPINFRA_TIMEOUT_MS, 10) || TIMEOUT_MS;
const CACHE_TTL_MS = parseInt(process.env.VISION_CACHE_TTL_MS, 10) || 30000;
const CACHE_MAX_ENTRIES = parseInt(process.env.VISION_CACHE_MAX_ENTRIES, 10) || 500;

const DEFAULT_DEEPINFRA_MODELS = [
  'Qwen/Qwen3-VL-235B-A22B-Instruct',
  'Qwen/Qwen3-VL-30B-A3B-Instruct',
  'Qwen/Qwen3.6-35B-A3B',
  'Qwen/Qwen3.5-397B-A17B',
];

const DEEPINFRA_MODELS = (process.env.DEEPINFRA_MODELS || DEFAULT_DEEPINFRA_MODELS.join(','))
  .split(',')
  .map(model => model.trim())
  .filter(Boolean);

const TASK_MAX_TOKENS = {
  check_page_ready: 256,
  find_submit_button: 384,
  detect_captcha: 384,
  locate_captcha_checkbox: 512,
  detect_vote_result: 384,
  confirm_vote: 512,
  find_input_fields: 768,
  classify_vote_failure: 640,
};

const cache = new Map();
const providerState = new Map();

let lastSuccessfulModelCallAt = 0;

function providerKey(provider, model) {
  return `${provider}:${model}`;
}

function setProviderState(provider, model, patch) {
  const key = providerKey(provider, model);
  providerState.set(key, {
    provider,
    model,
    lastSuccessAt: 0,
    lastErrorAt: 0,
    lastError: '',
    ...providerState.get(key),
    ...patch,
  });
}

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

function cacheKey(task, prompt, screenshot) {
  return crypto.createHash('sha256')
    .update(task)
    .update(prompt || '')
    .update(normalizeBase64(screenshot))
    .digest('hex');
}

function normalizeBase64(screenshot) {
  return String(screenshot || '')
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s/g, '');
}

function toDataUrl(screenshot) {
  const raw = String(screenshot || '').replace(/\s/g, '');
  if (raw.startsWith('data:image/')) return raw;
  return `data:image/png;base64,${normalizeBase64(raw)}`;
}

function timeoutSignal(ms, upstreamSignal) {
  if (!upstreamSignal) return AbortSignal.timeout(ms);
  return AbortSignal.any([upstreamSignal, AbortSignal.timeout(ms)]);
}

function getProviders() {
  const providers = [];

  if (DEEPINFRA_API_KEY) {
    for (const model of DEEPINFRA_MODELS) {
      providers.push({ provider: 'deepinfra', model });
    }
  }

  providers.push({ provider: 'ollama', model: 'moondream2' });
  return providers;
}

function extractDeepInfraContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => typeof part === 'string' ? part : part?.text || '')
      .join('')
      .trim();
  }
  return '';
}

async function queryDeepInfraModel(model, prompt, screenshot, task, signal) {
  const start = Date.now();
  const resp = await fetch(`${DEEPINFRA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DEEPINFRA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: TASK_MAX_TOKENS[task] ?? 512,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: toDataUrl(screenshot) } },
          ],
        },
      ],
    }),
    signal: timeoutSignal(DEEPINFRA_TIMEOUT_MS, signal),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return {
      error: resp.status === 429 ? 'rate_limited' : 'model_unavailable',
      message: `DeepInfra ${model} returned ${resp.status}: ${text.slice(0, 300)}`,
      latencyMs: Date.now() - start,
      retryable: resp.status === 429 || resp.status >= 500 || resp.status === 408,
    };
  }

  const data = await resp.json();
  const response = extractDeepInfraContent(data);

  if (!response) {
    return {
      error: 'empty_response',
      message: `DeepInfra ${model} returned an empty response`,
      latencyMs: Date.now() - start,
      retryable: true,
    };
  }

  return {
    response,
    latencyMs: Date.now() - start,
    usage: data.usage,
  };
}

async function queryProvider(provider, prompt, screenshot, task, signal) {
  if (provider.provider === 'deepinfra') {
    return queryDeepInfraModel(provider.model, prompt, screenshot, task, signal);
  }

  const result = await queryOllamaModel(prompt, normalizeBase64(screenshot), task, signal);
  if (result.error) return result;
  return {
    ...result,
    model: provider.model,
  };
}

export async function analyzeWithProviderFallback({ prompt, screenshot, task, parseResponse, signal }) {
  const key = cacheKey(task, prompt, screenshot);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.value, cached: true };
  }

  const attempts = [];
  let lastError = null;

  for (const provider of getProviders()) {
    const start = Date.now();
    if (signal?.aborted) {
      return {
        error: 'client_aborted',
        message: 'Client disconnected before vision analysis started',
        fallback: true,
        attempts,
      };
    }

    if (provider.provider === 'ollama' && !isOllamaReady()) {
      const skipped = {
        provider: provider.provider,
        model: provider.model,
        error: 'model_unavailable',
        message: 'Ollama fallback is not loaded or available',
        latencyMs: 0,
      };
      attempts.push(skipped);
      lastError = skipped;
      continue;
    }

    try {
      const modelResult = await queryProvider(provider, prompt, screenshot, task, signal);
      const latencyMs = modelResult.latencyMs ?? (Date.now() - start);

      if (modelResult.error) {
        const failed = {
          provider: provider.provider,
          model: provider.model,
          error: modelResult.error,
          message: modelResult.message,
          latencyMs,
        };
        attempts.push(failed);
        setProviderState(provider.provider, provider.model, {
          lastErrorAt: Date.now(),
          lastError: modelResult.error,
        });
        lastError = failed;
        continue;
      }

      const parsed = parseResponse(modelResult.response, task);
      if (parsed.error) {
        const failed = {
          provider: provider.provider,
          model: provider.model,
          error: parsed.error,
          message: parsed.message,
          latencyMs,
        };
        attempts.push(failed);
        setProviderState(provider.provider, provider.model, {
          lastErrorAt: Date.now(),
          lastError: parsed.error,
        });
        lastError = failed;
        continue;
      }

      const success = {
        response: modelResult.response,
        parsed,
        provider: provider.provider,
        model: provider.model,
        latencyMs,
        cached: false,
        attempts,
        usage: modelResult.usage,
      };

      lastSuccessfulModelCallAt = Date.now();
      setProviderState(provider.provider, provider.model, {
        lastSuccessAt: lastSuccessfulModelCallAt,
        lastError: '',
      });
      cache.set(key, { value: success, expiresAt: Date.now() + CACHE_TTL_MS });
      enforceCacheLimit();
      return success;
    } catch (err) {
      const error = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'model_unavailable';
      const failed = {
        provider: provider.provider,
        model: provider.model,
        error,
        message: err.message || String(err),
        latencyMs: Date.now() - start,
      };
      attempts.push(failed);
      setProviderState(provider.provider, provider.model, {
        lastErrorAt: Date.now(),
        lastError: error,
      });
      lastError = failed;
    }
  }

  const allParseFailures = attempts.length > 0 && attempts.every(attempt => attempt.error === 'parse_failed');
  return {
    error: allParseFailures ? 'parse_failed' : (lastError?.error || 'model_unavailable'),
    message: lastError?.message || 'No vision provider returned a usable response',
    fallback: true,
    attempts,
  };
}

export async function checkProvidersAvailable() {
  const ollamaAvailable = await checkOllamaAvailable();
  return isDeepInfraConfigured() || ollamaAvailable;
}

export function isDeepInfraConfigured() {
  return Boolean(DEEPINFRA_API_KEY);
}

export function isVisionReady() {
  return isDeepInfraConfigured() || isOllamaReady();
}

export function getLastSuccessfulModelCallAt() {
  return Math.max(lastSuccessfulModelCallAt, getLastSuccessfulOllamaCallAt());
}

export function warmupModel() {
  return warmupOllamaModel();
}

export function getVisionStatus() {
  const providers = getProviders().map(provider => {
    const state = providerState.get(providerKey(provider.provider, provider.model)) || {};
    const ready = provider.provider === 'deepinfra'
      ? isDeepInfraConfigured()
      : isOllamaReady();

    return {
      provider: provider.provider,
      model: provider.model,
      configured: provider.provider === 'deepinfra' ? isDeepInfraConfigured() : true,
      ready,
      last_success_at: state.lastSuccessAt || 0,
      last_error_at: state.lastErrorAt || 0,
      last_error: state.lastError || '',
    };
  });

  return {
    ready: isVisionReady(),
    primary_provider: isDeepInfraConfigured() ? 'deepinfra' : 'ollama',
    deepinfra_configured: isDeepInfraConfigured(),
    providers,
    cache_entries: cache.size,
    last_success_at: getLastSuccessfulModelCallAt(),
  };
}
