import { enqueue } from './writer.js';
import { redactHeaders, stringifySafe, truncate, MAX_EXCERPT } from './redact.js';

export function classifyService(url) {
  const value = String(url || '').toLowerCase();
  if (value.includes('/payment/') || value.includes('deepinfra.com/payment')) return 'billing';
  if (value.includes('deepinfra.com')) return 'deepinfra';
  if (value.includes('supabase.co') || value.includes('supabase.in')) return 'supabase';
  if (value.includes('11434') || value.includes('ollama')) return 'ollama';
  return 'other';
}

export function recordNetworkCall(partial) {
  const url = stripSensitiveUrl(partial.url || '');
  const promptTokens = partial.prompt_tokens ?? partial.usage?.prompt_tokens ?? null;
  const completionTokens = partial.completion_tokens ?? partial.usage?.completion_tokens ?? null;
  const totalTokens = partial.total_tokens
    ?? partial.usage?.total_tokens
    ?? ((promptTokens || 0) + (completionTokens || 0) || null);

  enqueue('network', {
    ts: partial.ts || Date.now(),
    service: partial.service || classifyService(url),
    method: partial.method || 'GET',
    url,
    status: partial.status ?? null,
    latency_ms: partial.latency_ms ?? null,
    error: partial.error ? String(partial.error).slice(0, 1000) : null,
    model: partial.model || null,
    task: partial.task || null,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    request_id: partial.request_id || null,
    request_excerpt: truncate(partial.request_excerpt, MAX_EXCERPT),
    response_excerpt: truncate(partial.response_excerpt, MAX_EXCERPT),
  });
}

export async function loggedFetch(url, options = {}, meta = {}) {
  const start = Date.now();
  const method = options.method || 'GET';
  try {
    const resp = await fetch(url, options);
    recordNetworkCall({
      ...meta,
      service: meta.service || classifyService(url),
      method,
      url,
      status: resp.status,
      latency_ms: Date.now() - start,
      request_excerpt: meta.request_excerpt || stringifySafe({
        headers: redactHeaders(options.headers),
        ...(meta.request_meta || {}),
      }),
    });
    return resp;
  } catch (err) {
    recordNetworkCall({
      ...meta,
      service: meta.service || classifyService(url),
      method,
      url,
      status: null,
      latency_ms: Date.now() - start,
      error: err.message || String(err),
      request_excerpt: meta.request_excerpt || stringifySafe({
        headers: redactHeaders(options.headers),
        ...(meta.request_meta || {}),
      }),
    });
    throw err;
  }
}

function stripSensitiveUrl(url) {
  try {
    const parsed = new URL(url, 'http://localhost');
    parsed.searchParams.delete('apikey');
    parsed.searchParams.delete('api_key');
    parsed.searchParams.delete('token');
    parsed.searchParams.delete('access_token');
    const qs = parsed.searchParams.toString();
    return `${parsed.origin}${parsed.pathname}${qs ? `?${qs}` : ''}`;
  } catch {
    return String(url).slice(0, 500);
  }
}
