import { sanitizeCooldownFields } from './cooldownSanitize.js';

const TASK_SCHEMAS = {
  find_submit_button: {
    required: ['found'],
    defaults: {
      found: false,
      text: '',
      approximate_position: 'unknown',
      description: '',
      likely_selector_hint: '',
    },
  },
  detect_captcha: {
    required: ['present'],
    defaults: {
      present: false,
      active: false,
      type: 'unknown',
      description: '',
      position: 'unknown',
    },
  },
  check_page_ready: {
    required: ['ready'],
    defaults: {
      ready: false,
      reason: '',
      blocking_elements: [],
    },
  },
  find_input_fields: {
    required: ['fields'],
    defaults: {
      fields: [],
    },
  },
  detect_vote_result: {
    required: ['outcome'],
    defaults: {
      outcome: 'unknown',
      message: '',
      can_retry: false,
      cooldown_until_iso: '',
      cooldown_remaining_seconds: null,
    },
  },
  confirm_vote: {
    required: ['outcome', 'confirmed'],
    defaults: {
      outcome: 'unknown',
      confirmed: false,
      message: '',
      can_retry: false,
      interference: 'none',
      wait_seconds: null,
    },
  },
  locate_captcha_checkbox: {
    required: ['found'],
    defaults: {
      found: false,
      provider_hint: 'unknown',
      checkbox_center_norm: { x: 0.5, y: 0.5 },
      checkbox_bbox_norm: { x: 0, y: 0, width: 0, height: 0 },
      iframe_hint: false,
      description: '',
    },
  },
  locate_consent_checkbox: {
    required: ['found'],
    defaults: {
      found: false,
      provider_hint: 'unknown',
      checkbox_center_norm: { x: 0.5, y: 0.5 },
      checkbox_bbox_norm: { x: 0, y: 0, width: 0, height: 0 },
      iframe_hint: false,
      description: '',
    },
  },
  classify_vote_failure: {
    required: ['category', 'summary'],
    defaults: {
      category: 'other',
      summary: '',
      evidence_quote: '',
      suggested_autovoter_failure_type: 'UNKNOWN',
      cooldown_until_iso: '',
      cooldown_remaining_seconds: null,
    },
  },
};

function extractJson(raw) {
  if (typeof raw !== 'string') return null;
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  return raw.slice(firstBrace, lastBrace + 1);
}

function tryParse(raw) {
  const jsonStr = extractJson(raw);
  if (!jsonStr) return null;
  try {
    return JSON.parse(jsonStr);
  } catch {
    // moondream2 sometimes produces single-quoted or trailing-comma JSON
    try {
      const cleaned = jsonStr
        .replace(/'/g, '"')
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']');
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}

function extractFallbackFields(raw, task) {
  if (typeof raw !== 'string') return null;
  const lower = raw.toLowerCase();

  if (task === 'find_submit_button') {
    const found = lower.includes('vote') || lower.includes('submit') || lower.includes('button');
    return { found, text: '', approximate_position: 'unknown', description: raw.slice(0, 200), likely_selector_hint: '' };
  }
  if (task === 'detect_captcha') {
    const present = lower.includes('captcha') || lower.includes('recaptcha') || lower.includes('hcaptcha') || lower.includes('turnstile') || lower.includes('robot');
    return { present, active: present, type: 'unknown', description: raw.slice(0, 200), position: 'unknown' };
  }
  if (task === 'check_page_ready') {
    const ready = lower.includes('ready') || lower.includes('loaded') || lower.includes('visible');
    return { ready, reason: raw.slice(0, 200), blocking_elements: [] };
  }
  if (task === 'find_input_fields') {
    return { fields: [] };
  }
  if (task === 'detect_vote_result') {
    let outcome = 'unknown';
    if (lower.includes('success') || lower.includes('thank')) outcome = 'success';
    else if (lower.includes('already voted')) outcome = 'already_voted';
    else if (lower.includes('ip') && lower.includes('block')) outcome = 'ip_blocked';
    return { outcome, message: raw.slice(0, 200), can_retry: false };
  }
  if (task === 'confirm_vote') {
    let outcome = 'unknown';
    if (lower.includes('already voted') || lower.includes('vote again') || lower.includes('tomorrow')) outcome = 'already_voted';
    else if (lower.includes('success') || lower.includes('thank') || lower.includes('counted') || lower.includes('recorded')) outcome = 'success';
    else if (
      lower.includes('hang on') ||
      lower.includes('processing your vote') ||
      lower.includes('do not close this tab') ||
      lower.includes('do not close the tab') ||
      (lower.includes('processing') && (lower.includes('please wait') || /\d{1,2}\s*s\b/.test(lower)))
    ) outcome = 'processing';
    else if (lower.includes('captcha') || lower.includes('cloudflare') || lower.includes('turnstile')) outcome = 'interference';
    else if (lower.includes('failed') || lower.includes('invalid') || lower.includes('rejected') || lower.includes('error')) outcome = 'failure';
    const waitMatch = lower.match(/(\d{1,2})\s*s\b/);
    const wait_seconds = outcome === 'processing' && waitMatch
      ? Math.min(60, Math.max(1, parseInt(waitMatch[1], 10)))
      : null;
    return {
      outcome,
      confirmed: outcome === 'success' || outcome === 'already_voted',
      message: raw.slice(0, 200),
      can_retry: outcome === 'processing' || outcome === 'interference' || outcome === 'unknown',
      interference: outcome === 'processing' ? 'processing_modal' : outcome === 'interference' ? 'visible blocker' : 'none',
      wait_seconds,
    };
  }
  if (task === 'locate_captcha_checkbox') {
    // Text fallback has no real geometry — never invent a center click target.
    const provider_hint = lower.includes('hcaptcha')
      ? 'hcaptcha'
      : lower.includes('recaptcha')
      ? 'recaptcha'
      : lower.includes('turnstile')
      ? 'turnstile'
      : 'unknown';
    return {
      found: false,
      provider_hint,
      checkbox_center_norm: null,
      checkbox_bbox_norm: null,
      iframe_hint: lower.includes('iframe'),
      description: raw.slice(0, 200),
    };
  }
  if (task === 'locate_consent_checkbox') {
    // Text fallback has no real geometry — never invent a center click target.
    return {
      found: false,
      provider_hint: 'consent',
      checkbox_center_norm: null,
      checkbox_bbox_norm: null,
      iframe_hint: false,
      description: raw.slice(0, 200),
    };
  }
  if (task === 'classify_vote_failure') {
    let category = 'other';
    if (
      lower.includes('already voted') ||
      lower.includes('you have voted today') ||
      lower.includes('you voted today') ||
      lower.includes('vote again') ||
      lower.includes('tomorrow') ||
      lower.includes('cooldown')
    ) category = 'already_voted';
    else if (lower.includes('captcha') || lower.includes('robot') || lower.includes('turnstile') || lower.includes('hcaptcha')) category = 'captcha_failed';
    else if (lower.includes('ip') && (lower.includes('block') || lower.includes('banned'))) category = 'ip_blocked';
    else if (lower.includes('timeout') || lower.includes('connection') || lower.includes('network') || lower.includes('load')) category = 'network_or_load';
    else if (lower.includes('error') || lower.includes('500') || lower.includes('404')) category = 'site_error';
    return {
      category,
      summary: raw.slice(0, 400),
      evidence_quote: '',
      suggested_autovoter_failure_type: 'UNKNOWN',
    };
  }
  return null;
}

export function parseResponse(raw, task) {
  const schema = TASK_SCHEMAS[task];
  if (!schema) {
    return { error: 'parse_failed', message: `Unknown task: ${task}`, fallback: true };
  }

  let parsed = tryParse(raw);

  if (!parsed) {
    parsed = extractFallbackFields(raw, task);
  }

  if (!parsed) {
    return { error: 'parse_failed', message: 'Could not extract structured data from model response', fallback: true };
  }

  const result = { ...schema.defaults, ...parsed };
  if (task === 'locate_captcha_checkbox' || task === 'locate_consent_checkbox') {
    // Reject locate_* without real geometry — do not keep found=true with default/fake center.
    if (result.found && !hasRealLocateGeometry(parsed) && !hasRealLocateGeometry(result)) {
      result.found = false;
    }
    if (!result.found || !hasRealLocateGeometry(result)) {
      result.found = false;
      result.checkbox_center_norm = { ...schema.defaults.checkbox_center_norm };
      result.checkbox_bbox_norm = { ...schema.defaults.checkbox_bbox_norm };
    }
  }
  if (task === 'confirm_vote') {
    result.outcome = normalizeConfirmOutcome(result.outcome);
    const ws = result.wait_seconds;
    result.wait_seconds =
      ws != null && ws !== '' && Number.isFinite(Number(ws)) ? Math.min(60, Math.max(1, Math.round(Number(ws)))) : null;
    if (result.outcome === 'processing') {
      result.confirmed = false;
      result.can_retry = true;
      if (!result.interference || result.interference === 'none') {
        result.interference = 'processing_modal';
      }
    } else {
      result.confirmed = result.outcome === 'success' || result.outcome === 'already_voted'
        ? Boolean(result.confirmed)
        : false;
    }
  }
  if (task === 'detect_vote_result') {
    result.cooldown_until_iso = String(result.cooldown_until_iso || '').trim().slice(0, 64);
    const dcrs = result.cooldown_remaining_seconds;
    result.cooldown_remaining_seconds =
      dcrs != null && dcrs !== '' && Number.isFinite(Number(dcrs)) ? Number(dcrs) : null;
    sanitizeCooldownFields(result);
  }
  if (task === 'classify_vote_failure') {
    result.category = normalizeFailureCategory(result.category);
    result.summary = String(result.summary || '').slice(0, 8000);
    result.evidence_quote = String(result.evidence_quote || '').slice(0, 2000);
    result.suggested_autovoter_failure_type = normalizeSuggestedFailureType(result.suggested_autovoter_failure_type);
    result.cooldown_until_iso = String(result.cooldown_until_iso || '').trim().slice(0, 64);
    const ccrs = result.cooldown_remaining_seconds;
    result.cooldown_remaining_seconds =
      ccrs != null && ccrs !== '' && Number.isFinite(Number(ccrs)) ? Number(ccrs) : null;
    sanitizeCooldownFields(result);
  }

  const missing = schema.required.filter(k => result[k] === undefined);
  if (missing.length > 0) {
    return { error: 'parse_failed', message: `Missing required fields: ${missing.join(', ')}`, fallback: true };
  }

  return result;
}

/** True when the model supplied usable normalized checkbox coordinates. */
function hasRealLocateGeometry(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const c = obj.checkbox_center_norm;
  if (!c || typeof c !== 'object') return false;
  const x = Number(c.x);
  const y = Number(c.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const b = obj.checkbox_bbox_norm;
  const hasBbox =
    b &&
    typeof b === 'object' &&
    Number.isFinite(Number(b.width)) &&
    Number.isFinite(Number(b.height)) &&
    (Number(b.width) > 0 || Number(b.height) > 0);
  // Default center (0.5, 0.5) with empty bbox is invented geometry — reject.
  if (!hasBbox && x === 0.5 && y === 0.5) return false;
  return true;
}

function normalizeConfirmOutcome(outcome) {
  const value = String(outcome || '').toLowerCase();
  if (value === 'success') return 'success';
  if (value === 'already_voted' || value === 'already-voted' || value === 'already voted') return 'already_voted';
  if (value === 'processing' || value === 'in_progress' || value === 'in progress') return 'processing';
  if (value === 'interference' || value === 'captcha_required' || value === 'blocked' || value === 'ip_blocked') return 'interference';
  if (value === 'failure' || value === 'failed' || value === 'error') return 'failure';
  return 'unknown';
}

const FAILURE_CATEGORIES = new Set([
  'already_voted',
  'captcha_failed',
  'step_missing',
  'site_error',
  'network_or_load',
  'ip_blocked',
  'other',
]);

function normalizeFailureCategory(category) {
  const v = String(category || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (FAILURE_CATEGORIES.has(v)) return v;
  return 'other';
}

const SUGGESTED_FAILURE_TYPES = new Set([
  'PROXY_BLOCKED',
  'CAPTCHA_UNSOLVED',
  'CAPTCHA_UNSOLVABLE',
  'CAPTCHA_REJECTED',
  'PAGE_LOAD_FAILED',
  'PAGE_CLOSED',
  'FORM_ERROR',
  'VOTE_REJECTED',
  'IP_RELATED',
  'UNKNOWN',
]);

function normalizeSuggestedFailureType(raw) {
  const u = String(raw || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (SUGGESTED_FAILURE_TYPES.has(u)) return u;
  return 'UNKNOWN';
}
