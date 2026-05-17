/** Max vote cooldown for Minecraft list sites (24 hours). */
export const MAX_COOLDOWN_SECONDS = 24 * 60 * 60;
const MIN_COOLDOWN_SECONDS = 30;

/**
 * True when text contains an explicit wait duration (timer, "4h 59m", "12 hours", etc.).
 */
export function textHasExplicitCooldownDuration(text) {
  const lower = (text || '').toLowerCase().replace(/["'`]/g, '');
  if (!lower.trim()) return false;

  const hMatch = lower.match(/(\d+)\s*(?:hours?|hrs?)\b/);
  const mMatch = lower.match(/(\d+)\s*(?:minutes?|mins?)\b/);
  const sMatch = lower.match(/(\d+)\s*(?:seconds?|secs?)\b/);
  const compactH = lower.match(/\b(\d+)\s*h\b(?!\s*[a-z])/);
  const compactM = lower.match(/\b(\d+)\s*m\b(?!\s*[a-z])/);
  const compactS = lower.match(/\b(\d+)\s*s\b(?!\s*[a-z])/);

  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (hMatch) hours += parseInt(hMatch[1], 10);
  if (mMatch) minutes += parseInt(mMatch[1], 10);
  if (sMatch) seconds += parseInt(sMatch[1], 10);
  if (compactH && !hMatch) hours += parseInt(compactH[1], 10);
  if (compactM && !mMatch) minutes += parseInt(compactM[1], 10);
  if (compactS && !sMatch) seconds += parseInt(compactS[1], 10);

  const totalSec = hours * 3600 + minutes * 60 + seconds;
  return totalSec >= MIN_COOLDOWN_SECONDS && totalSec <= MAX_COOLDOWN_SECONDS;
}

function cooldownEvidenceBlob(result) {
  return [
    result.message,
    result.summary,
    result.evidence_quote,
  ].filter(Boolean).join(' \n ');
}

/**
 * Clears or caps cooldown fields on detect_vote_result / classify_vote_failure results.
 */
export function sanitizeCooldownFields(result) {
  const blob = cooldownEvidenceBlob(result);
  const hasExplicitDuration = textHasExplicitCooldownDuration(blob);

  if (!hasExplicitDuration) {
    result.cooldown_until_iso = '';
    result.cooldown_remaining_seconds = null;
    return result;
  }

  const now = Date.now();
  const maxUntil = now + MAX_COOLDOWN_SECONDS * 1000;

  const secsRaw = result.cooldown_remaining_seconds;
  if (secsRaw != null && secsRaw !== '' && Number.isFinite(Number(secsRaw))) {
    let n = Math.floor(Number(secsRaw));
    if (n < MIN_COOLDOWN_SECONDS) n = MIN_COOLDOWN_SECONDS;
    if (n > MAX_COOLDOWN_SECONDS) n = MAX_COOLDOWN_SECONDS;
    result.cooldown_remaining_seconds = n;
  }

  const iso = String(result.cooldown_until_iso || '').trim();
  if (iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()) || d.getTime() <= now + MIN_COOLDOWN_SECONDS * 1000) {
      result.cooldown_until_iso = '';
    } else {
      const clamped = Math.min(d.getTime(), maxUntil);
      result.cooldown_until_iso = new Date(clamped).toISOString();
    }
  }

  return result;
}
