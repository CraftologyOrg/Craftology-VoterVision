import { LEVEL_NAMES, SKIP_HTTP_PATHS } from './constants.js';
import { enqueue } from './writer.js';
import { redact, stringifySafe, truncate } from './redact.js';

function levelName(level) {
  if (typeof level === 'string') return level;
  return LEVEL_NAMES[level] || String(level);
}

function skipPinoObject(obj) {
  const url = obj.req?.url || obj.url || '';
  if (typeof url === 'string' && url.startsWith('/monitor')) return true;
  const msg = obj.msg || '';
  if (msg === 'monitor write failed' || msg.startsWith('[monitor]')) return true;
  return false;
}

export function ingestPinoLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('{')) return;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (skipPinoObject(obj)) return;

  const {
    pid, hostname, time, level, msg, req, res, err, ...rest
  } = obj;
  void pid;
  void hostname;
  void req;
  void res;

  enqueue('log', {
    ts: typeof time === 'number' ? time : Date.now(),
    level: levelName(level),
    msg: msg ? String(msg).slice(0, 2000) : null,
    request_id: obj.reqId || obj.req?.id || rest.request_id || null,
    task: rest.task || null,
    provider: rest.provider || null,
    model: rest.model || null,
    license_id: rest.license_id || rest.licenseId || null,
    error: err?.message || (typeof rest.error === 'string' ? rest.error : rest.error?.message) || null,
    payload: truncate(stringifySafe(redact(rest))),
  });
}

export function recordHttpRequest(request, reply) {
  const path = (request.routeOptions?.url || request.url || '').split('?')[0];
  if (!path || SKIP_HTTP_PATHS.has(path) || path.startsWith('/monitor')) return;

  const meta = request.monitorMeta || {};
  const task = meta.task
    || request.body?.task
    || (path === '/confirm-vote' ? 'confirm_vote' : null);

  enqueue('http', {
    ts: Date.now(),
    method: request.method,
    path,
    status: reply.statusCode,
    latency_ms: Math.round(reply.elapsedTime || 0),
    license_id: request.license?.id || null,
    user_id: request.user?.id || null,
    task,
    provider: meta.provider || null,
    model: meta.model || null,
    cached: meta.cached ? 1 : 0,
    error: meta.error || (reply.statusCode >= 400 ? String(reply.statusCode) : null),
    queue_wait_ms: meta.queue_wait_ms || 0,
    ip: request.ip || null,
    request_id: request.id || null,
  });
}

export function recordVisionEvent({
  task,
  success,
  cached,
  provider,
  model,
  latencyMs,
  error,
  attempts,
  licenseId,
  usage,
  queueWaitMs,
  requestId,
}) {
  enqueue('vision', {
    ts: Date.now(),
    task: task || null,
    success: success ? 1 : 0,
    cached: cached ? 1 : 0,
    provider: provider || null,
    model: model || null,
    latency_ms: latencyMs || 0,
    error: error || null,
    attempts_json: attempts ? truncate(stringifySafe(attempts), 4000) : null,
    license_id: licenseId || null,
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: usage?.completion_tokens ?? null,
    queue_wait_ms: queueWaitMs || 0,
    request_id: requestId || null,
  });
}

export function noteVisionRequest(request, details) {
  request.monitorMeta = {
    task: details.task || null,
    provider: details.provider || null,
    model: details.model || null,
    cached: details.cached ? 1 : 0,
    error: details.error || null,
    queue_wait_ms: details.queueWaitMs || 0,
  };
  recordVisionEvent({
    ...details,
    licenseId: request.license?.id || null,
    requestId: request.id || null,
  });
}
