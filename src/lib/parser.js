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
      type: 'none',
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
    const present = lower.includes('captcha') || lower.includes('recaptcha') || lower.includes('hcaptcha');
    return { present, active: present, type: present ? 'unknown' : 'none', description: raw.slice(0, 200), position: 'unknown' };
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

  const missing = schema.required.filter(k => result[k] === undefined);
  if (missing.length > 0) {
    return { error: 'parse_failed', message: `Missing required fields: ${missing.join(', ')}`, fallback: true };
  }

  return result;
}
