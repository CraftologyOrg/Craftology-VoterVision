import { enqueue } from './writer.js';
import { loggedFetch } from './network.js';
import { stringifySafe, truncate } from './redact.js';

const CHECKLIST_URL = 'https://api.deepinfra.com/payment/checklist?compute_owed=true';

function authHeader() {
  const key = process.env.DEEPINFRA_API_KEY || process.env.DEEPINFRA_TOKEN || '';
  return key ? { Authorization: `Bearer ${key}` } : null;
}

/** DeepInfra billing integers are cents; fractional values are already dollars. */
export function toUsd(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (Number.isInteger(n)) return n / 100;
  return n;
}

export function availableUsdFromStripeBalance(stripeBalance) {
  const usd = toUsd(stripeBalance);
  if (usd == null) return null;
  return usd < 0 ? -usd : 0;
}

export function owedUsdFromStripeBalance(stripeBalance) {
  const usd = toUsd(stripeBalance);
  if (usd == null) return null;
  return usd > 0 ? usd : 0;
}

function usageUrl(from = 'current') {
  const params = new URLSearchParams({ from: String(from) });
  return `https://api.deepinfra.com/payment/usage?${params}`;
}

async function fetchJson(url, service) {
  const headers = authHeader();
  if (!headers) throw new Error('DEEPINFRA_API_KEY is not configured');
  const resp = await loggedFetch(url, { headers, signal: AbortSignal.timeout(15000) }, {
    service,
    request_meta: { path: url },
  });
  const text = await resp.text().catch(() => '');
  if (!resp.ok) {
    throw new Error(`DeepInfra billing ${resp.status}: ${text.slice(0, 240)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('DeepInfra billing returned non-JSON');
  }
}

export async function pollDeepInfraBilling() {
  const headers = authHeader();
  if (!headers) return null;

  const ts = Date.now();
  try {
    const [checklist, usage] = await Promise.all([
      fetchJson(CHECKLIST_URL, 'billing'),
      fetchJson(usageUrl('current'), 'billing').catch((err) => ({ _error: err.message })),
    ]);

    const stripeBalance = checklist?.stripe_balance;
    const snapshot = {
      ts,
      stripe_balance: stripeBalance ?? null,
      available_usd: availableUsdFromStripeBalance(stripeBalance),
      owed_usd: owedUsdFromStripeBalance(stripeBalance),
      recent_usd: toUsd(checklist?.recent),
      spending_limit_usd: toUsd(checklist?.limit),
      suspended: checklist?.suspended ? 1 : 0,
      suspend_reason: checklist?.suspend_reason || null,
      usage_json: truncate(stringifySafe(usage), 16_000),
      checklist_json: truncate(stringifySafe({
        suspended: checklist?.suspended,
        overdue_invoices: checklist?.overdue_invoices,
        billing_type: checklist?.billing_type,
        topup: checklist?.topup,
        topup_amount: checklist?.topup_amount,
        topup_threshold: checklist?.topup_threshold,
        topup_failed: checklist?.topup_failed,
        payment_method: checklist?.payment_method,
        stripe_balance: checklist?.stripe_balance,
        recent: checklist?.recent,
        limit: checklist?.limit,
        suspend_reason: checklist?.suspend_reason,
      }), 8000),
      error: usage?._error || null,
    };
    enqueue('billing', snapshot);
    return snapshot;
  } catch (err) {
    const snapshot = {
      ts,
      stripe_balance: null,
      available_usd: null,
      owed_usd: null,
      recent_usd: null,
      spending_limit_usd: null,
      suspended: null,
      suspend_reason: null,
      usage_json: null,
      checklist_json: null,
      error: err.message || String(err),
    };
    enqueue('billing', snapshot);
    return snapshot;
  }
}
