const REDACT_KEYS = /^(authorization|cookie|captcha-token|hwid|password|api[_-]?key|token|secret|refresh_token|access_token|screenshot|page_html|pagehtml|images|image_url)$/i;

export const MAX_PAYLOAD = 8 * 1024;
export const MAX_EXCERPT = 2000;

export function truncate(str, max = MAX_PAYLOAD) {
  if (str == null) return null;
  const s = typeof str === 'string' ? str : stringifySafe(str);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = REDACT_KEYS.test(key) ? '[Redacted]' : redact(nested);
    }
    return out;
  }
  return value;
}

export function stringifySafe(value) {
  try {
    return JSON.stringify(redact(value));
  } catch {
    return String(value);
  }
}

export function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const out = {};
  for (const [key, nested] of Object.entries(headers)) {
    out[key] = REDACT_KEYS.test(key) ? '[Redacted]' : String(nested).slice(0, 200);
  }
  return out;
}

export function sanitizeFtsQuery(raw) {
  const stop = new Set(['and', 'or', 'not', 'near']);
  const terms = String(raw || '')
    .replace(/['"^:*(){}[\]~+-]/g, ' ')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !stop.has(term.toLowerCase()))
    .slice(0, 12);
  if (!terms.length) return '';
  return terms.map((term) => `"${term}"`).join(' AND ');
}
