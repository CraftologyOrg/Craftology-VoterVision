import { randomUUID } from 'crypto';
import { getPrompt, isValidTask, VALID_TASK_LIST } from '../lib/prompts.js';
import { parseResponse } from '../lib/parser.js';
import { createVisionQueueFromEnv, QueueError } from '../lib/requestQueue.js';
import { analyzeWithProviderFallback } from '../lib/visionModel.js';

export const visionQueue = createVisionQueueFromEnv();

const BODY_SCHEMA = {
  type: 'object',
  required: ['screenshot', 'task'],
  properties: {
    screenshot: {
      type: 'string',
      minLength: 100,
      maxLength: 10 * 1024 * 1024,
      // Basic base64 check (with optional data URL prefix).
      pattern: '^(data:image\\/(png|jpeg|jpg|webp);base64,)?[A-Za-z0-9+/=\\r\\n]+$',
    },
    task: { type: 'string', enum: VALID_TASK_LIST },
    context: { type: 'string', maxLength: 1024 },
    page_html: { type: 'string', maxLength: 120000 },
    target_url: { type: 'string', maxLength: 2048 },
    account_username: { type: 'string', maxLength: 128 },
    autovoter_failure_type: { type: 'string', maxLength: 64 },
    client_error_message: { type: 'string', maxLength: 4000 },
    attempt_id: { type: 'string', maxLength: 128 },
  },
  additionalProperties: false,
};

const CONFIRM_BODY_SCHEMA = {
  type: 'object',
  required: ['screenshot'],
  properties: {
    screenshot: BODY_SCHEMA.properties.screenshot,
    username: { type: 'string', maxLength: 128 },
    siteUrl: { type: 'string', maxLength: 2048 },
    checkpoint: { type: 'number', minimum: 1, maximum: 10 },
    totalCheckpoints: { type: 'number', minimum: 1, maximum: 10 },
    elapsedMs: { type: 'number', minimum: 0, maximum: 120000 },
    context: { type: 'string', maxLength: 1024 },
  },
  additionalProperties: false,
};

function createRequestAbortSignal(request) {
  const controller = new AbortController();
  request.raw.once('aborted', () => controller.abort());
  return controller.signal;
}

/** Max queued+running vision jobs per license/HWID — equals `products.tier_max_sessions_per_hwid` from auth entitlements. */
function getMaxPendingForRequest(request) {
  const tierCap = Number(request.entitlements?.maxCaptchaSlotsPerDevice ?? 0);
  if (!Number.isFinite(tierCap) || tierCap < 1) return undefined;
  return Math.max(1, Math.floor(tierCap));
}

export default async function analyzeRoutes(fastify) {
  fastify.post('/analyze', {
    config: {
      rateLimit: {
        max: parseInt(process.env.VISION_ANALYZE_RATE_LIMIT_PER_MIN, 10) || 6000,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.user?.id || request.license?.id || request.ip,
      },
    },
    schema: { body: BODY_SCHEMA },
  }, async (request, reply) => {
    if (!request.entitlements?.tier) {
      return reply.code(403).send({
        error: 'License is not valid for Autovoter vision',
        code: 'TIER_NOT_ALLOWED',
      });
    }
    const {
      screenshot,
      task,
      context,
      page_html: pageHtml,
      target_url: targetUrl,
      account_username: accountUsername,
      autovoter_failure_type: autovoterFailureType,
      client_error_message: clientErrorMessage,
      attempt_id: attemptId,
    } = request.body;
    const start = Date.now();

    if (!isValidTask(task)) {
      return reply.code(400).send({
        error: 'invalid_task',
        message: `Unknown task "${task}". Valid tasks: ${VALID_TASK_LIST.join(', ')}`,
        fallback: true,
      });
    }

    const promptContext = task === 'classify_vote_failure'
      ? buildClassifyVoteFailureContext({
        context,
        pageHtml,
        targetUrl,
        accountUsername,
        autovoterFailureType,
        clientErrorMessage,
        attemptId,
      })
      : context;

    const prompt = getPrompt(task, promptContext);
    const queueKey = getQueueKey(request);
    const requestSignal = createRequestAbortSignal(request);

    let modelResult;
    let queueWaitMs = 0;
    try {
      modelResult = await visionQueue.enqueue(queueKey, async (queueInfo) => {
        queueWaitMs = queueInfo.queueWaitMs;
        return analyzeWithProviderFallback({
          prompt,
          screenshot,
          task,
          parseResponse,
          signal: requestSignal,
        });
      }, {
        maxPendingPerUser: getMaxPendingForRequest(request),
      });
    } catch (err) {
      if (err instanceof QueueError) {
        request.log.warn({
          task,
          queueKey,
          error: err.code,
          latencyMs: Date.now() - start,
        }, 'Vision request queue rejected');

        return reply.code(err.statusCode).send({
          error: err.code,
          message: err.message,
          fallback: true,
        });
      }
      throw err;
    }

    if (modelResult.error) {
      const timeoutOnFallbackTask = task === 'locate_captcha_checkbox' && modelResult.error === 'timeout';
      const logger = timeoutOnFallbackTask ? request.log.info.bind(request.log) : request.log.warn.bind(request.log);
      logger({
        task,
        error: modelResult.error,
        attempts: summarizeAttempts(modelResult.attempts),
        latencyMs: Date.now() - start,
      }, timeoutOnFallbackTask ? 'Vision fallback timeout' : 'Vision model error');

      const statusCode = modelResult.error === 'parse_failed'
        ? 422
        : modelResult.error === 'timeout'
        ? 504
        : 503;

      return reply.code(statusCode).send({
        error: modelResult.error,
        message: modelResult.message,
        fallback: true,
      });
    }

    const parsed = modelResult.parsed;

    const latencyMs = modelResult.latencyMs || (Date.now() - start);

    request.log.info({
      task,
      latencyMs,
      totalLatencyMs: Date.now() - start,
      queueWaitMs,
      cached: modelResult.cached,
      provider: modelResult.provider,
      model: modelResult.model,
      attempts: summarizeAttempts(modelResult.attempts),
      confidence: parsed.confidence ?? estimateConfidence(task, parsed),
    }, 'Vision analysis complete');

    const confidence = estimateConfidence(task, parsed);

    let persistMeta = {};
    if (task === 'classify_vote_failure') {
      persistMeta = await persistClassifiedFailedVote(fastify, request, {
        parsed,
        modelResult,
        screenshot,
        targetUrl,
        accountUsername,
        autovoterFailureType,
        clientErrorMessage,
        attemptId,
        pageHtml,
        confidence,
      });
    }

    return {
      task,
      result: parsed,
      confidence,
      reasoning: parsed.description || parsed.reason || parsed.message || parsed.summary || '',
      provider: modelResult.provider,
      model: modelResult.model,
      latency_ms: latencyMs,
      queue_wait_ms: queueWaitMs,
      cached: modelResult.cached,
      ...persistMeta,
    };
  });

  fastify.post('/confirm-vote', {
    config: {
      rateLimit: {
        max: parseInt(process.env.VISION_CONFIRM_RATE_LIMIT_PER_MIN, 10) || 6000,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.user?.id || request.license?.id || request.ip,
      },
    },
    schema: { body: CONFIRM_BODY_SCHEMA },
  }, async (request, reply) => {
    if (!request.entitlements?.tier) {
      return reply.code(403).send({
        error: 'License is not valid for Autovoter vision',
        code: 'TIER_NOT_ALLOWED',
      });
    }
    const { screenshot, username, siteUrl, checkpoint, totalCheckpoints, elapsedMs, context } = request.body;
    const task = 'confirm_vote';
    const start = Date.now();
    const queueKey = getQueueKey(request);
    const promptContext = buildConfirmContext({
      username,
      siteUrl,
      checkpoint,
      totalCheckpoints,
      elapsedMs,
      context,
    });
    const prompt = getPrompt(task, promptContext);
    const requestSignal = createRequestAbortSignal(request);

    let modelResult;
    let queueWaitMs = 0;
    try {
      modelResult = await visionQueue.enqueue(queueKey, async (queueInfo) => {
        queueWaitMs = queueInfo.queueWaitMs;
        return analyzeWithProviderFallback({
          prompt,
          screenshot,
          task,
          parseResponse,
          signal: requestSignal,
        });
      }, {
        maxPendingPerUser: getMaxPendingForRequest(request),
      });
    } catch (err) {
      if (err instanceof QueueError) {
        request.log.warn({
          task,
          queueKey,
          checkpoint,
          error: err.code,
          latencyMs: Date.now() - start,
        }, 'Vote confirmation queue rejected');

        return reply.code(err.statusCode).send({
          error: err.code,
          message: err.message,
          fallback: true,
        });
      }
      throw err;
    }

    if (modelResult.error) {
      request.log.warn({
        task,
        checkpoint,
        error: modelResult.error,
        attempts: summarizeAttempts(modelResult.attempts),
        latencyMs: Date.now() - start,
      }, 'Vote confirmation model error');

      return reply.code(modelResult.error === 'parse_failed' ? 422 : modelResult.error === 'timeout' ? 504 : 503).send({
        error: modelResult.error,
        message: modelResult.message,
        fallback: true,
      });
    }

    const parsed = modelResult.parsed;
    const latencyMs = modelResult.latencyMs || (Date.now() - start);

    request.log.info({
      task,
      checkpoint,
      outcome: parsed.outcome,
      confirmed: parsed.confirmed,
      latencyMs,
      totalLatencyMs: Date.now() - start,
      queueWaitMs,
      provider: modelResult.provider,
      model: modelResult.model,
      cached: modelResult.cached,
    }, 'Vote confirmation complete');

    return {
      task,
      result: parsed,
      confirmed: Boolean(parsed.confirmed),
      outcome: parsed.outcome,
      confidence: estimateConfidence(task, parsed),
      provider: modelResult.provider,
      model: modelResult.model,
      latency_ms: latencyMs,
      queue_wait_ms: queueWaitMs,
      cached: modelResult.cached,
    };
  });
}

function buildClassifyVoteFailureContext({
  context,
  pageHtml,
  targetUrl,
  accountUsername,
  autovoterFailureType,
  clientErrorMessage,
  attemptId,
}) {
  const lines = [];
  if (context) lines.push(String(context));
  if (targetUrl) lines.push(`Autovoter target URL: ${targetUrl}`);
  if (accountUsername) lines.push(`Minecraft username: ${accountUsername}`);
  if (autovoterFailureType) lines.push(`Autovoter failure type hint: ${autovoterFailureType}`);
  if (clientErrorMessage) lines.push(`Client error: ${clientErrorMessage}`);
  if (attemptId) lines.push(`Attempt id: ${attemptId}`);
  const meta = lines.join('\n').slice(0, 4000);
  const html = pageHtml ? String(pageHtml).slice(0, 80000) : '';
  const htmlBlock = html ? `\n\nPage HTML excerpt:\n${html}` : '';
  return (meta + htmlBlock).slice(0, 120000);
}

/** Cooldown / already-voted outcomes are synced locally by the Autovoter — do not store as failed_votes. */
function shouldSkipFailedVotePersist(parsed) {
  const cat = String(parsed.category || '').toLowerCase().trim();
  if (cat === 'already_voted') return true;
  const s = String(parsed.summary || '').toLowerCase();
  const eq = String(parsed.evidence_quote || '').toLowerCase();
  const blob = `${s}\n${eq}`;
  const hints = [
    'already voted',
    'you voted today',
    'you have voted today',
    'you have already voted',
    'vote again in',
    'you can vote again',
    'try again in',
    'voted today',
    'come back tomorrow',
    'return tomorrow',
    'must wait until',
    'cooldown',
  ];
  return hints.some((h) => blob.includes(h));
}

async function persistClassifiedFailedVote(fastify, request, {
  parsed,
  modelResult,
  screenshot,
  targetUrl,
  accountUsername,
  autovoterFailureType,
  clientErrorMessage,
  attemptId,
  pageHtml,
  confidence,
}) {
  if (shouldSkipFailedVotePersist(parsed)) {
    request.log.info({
      category: parsed.category,
      targetUrl,
    }, 'classify_vote_failure: cooldown/already_voted — skipping failed_votes persistence');
    return {
      stored: false,
      skipped_reason: 'cooldown_or_already_voted',
      cooldown_persist_skipped: true,
    };
  }

  const license = request.license;
  if (!license?.id) {
    request.log.warn('classify_vote_failure persist skipped — no license id');
    return { stored: false };
  }

  const bucket = process.env.FAILED_VOTES_BUCKET || 'failed-vote-screenshots';
  const objectId = randomUUID();
  const storagePath = `${license.id}/${objectId}.png`;

  let b64 = String(screenshot || '')
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s/g, '');
  let buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
  } catch (e) {
    request.log.error(e, 'classify_vote_failure: invalid screenshot base64');
    return { stored: false };
  }
  if (!buffer.length) {
    request.log.warn('classify_vote_failure: empty screenshot buffer');
    return { stored: false };
  }

  const { error: uploadErr } = await fastify.supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType: 'image/png',
      upsert: false,
    });

  if (uploadErr) {
    request.log.error(uploadErr, 'failed_votes storage upload failed');
    return { stored: false };
  }

  const htmlSnippet = pageHtml ? String(pageHtml).slice(0, 96000) : null;
  const fullStorageRef = `${bucket}/${storagePath}`;

  const row = {
    license_id: license.id,
    user_id: license.user_id ?? null,
    target_url: targetUrl || null,
    account_username: accountUsername || null,
    autovoter_failure_type: autovoterFailureType || null,
    client_error_message: clientErrorMessage ? String(clientErrorMessage).slice(0, 4000) : null,
    attempt_id: attemptId || null,
    vision_category: parsed.category || 'other',
    vision_summary: (parsed.summary || '').slice(0, 8000),
    vision_confidence: confidence,
    vision_model: modelResult.model || null,
    vision_provider: modelResult.provider || null,
    vision_raw: { ...parsed },
    html_snippet: htmlSnippet,
    screenshot_storage_path: fullStorageRef,
  };

  const { data: inserted, error: insertErr } = await fastify.supabase
    .from('failed_votes')
    .insert(row)
    .select('id')
    .single();

  if (insertErr) {
    request.log.error(insertErr, 'failed_votes table insert failed');
    return { stored: false, screenshot_storage_path: fullStorageRef };
  }

  return {
    stored: true,
    failed_vote_id: inserted?.id ?? null,
    screenshot_storage_path: fullStorageRef,
  };
}

function getQueueKey(request) {
  return request.user?.id || request.license?.id || request.headers.hwid || request.ip;
}

function summarizeAttempts(attempts = []) {
  return attempts.map(attempt => ({
    provider: attempt.provider,
    model: attempt.model,
    error: attempt.error,
    latencyMs: attempt.latencyMs,
  }));
}

function buildConfirmContext({ username, siteUrl, checkpoint, totalCheckpoints, elapsedMs, context }) {
  const parts = [];
  if (username) parts.push(`Username: ${username}`);
  if (siteUrl) parts.push(`Site URL: ${siteUrl}`);
  if (checkpoint && totalCheckpoints) parts.push(`Checkpoint: ${checkpoint}/${totalCheckpoints}`);
  if (typeof elapsedMs === 'number') parts.push(`Elapsed since submit: ${Math.round(elapsedMs / 1000)}s`);
  if (context) parts.push(`Client context: ${context}`);
  return parts.join('\n').slice(0, 1024);
}

function estimateConfidence(task, parsed) {
  switch (task) {
    case 'find_submit_button':
      if (!parsed.found) return 0.8;
      if (parsed.text && parsed.description) return 0.9;
      if (parsed.text || parsed.description) return 0.7;
      return 0.5;
    case 'detect_captcha':
      // Model only answers present/active; higher confidence when both are explicit booleans
      if (!parsed.present) return 0.88;
      if (parsed.present && parsed.active && parsed.description) return 0.9;
      if (parsed.present && parsed.active) return 0.88;
      return 0.72;
    case 'check_page_ready':
      if (parsed.ready && (!parsed.blocking_elements || parsed.blocking_elements.length === 0)) return 0.9;
      return 0.7;
    case 'find_input_fields':
      if (parsed.fields && parsed.fields.length > 0) return 0.8;
      return 0.7;
    case 'detect_vote_result':
      if (parsed.outcome === 'success' || parsed.outcome === 'already_voted') return 0.85;
      if (parsed.outcome === 'unknown') return 0.4;
      return 0.7;
    case 'confirm_vote':
      if (parsed.outcome === 'success' || parsed.outcome === 'already_voted') return parsed.message ? 0.92 : 0.82;
      if (parsed.outcome === 'interference' || parsed.outcome === 'failure') return parsed.message ? 0.84 : 0.7;
      return 0.35;
    case 'locate_captcha_checkbox':
      if (!parsed.found) return 0.7;
      if (parsed.checkbox_center_norm && typeof parsed.checkbox_center_norm.x === 'number' && typeof parsed.checkbox_center_norm.y === 'number') {
        return 0.86;
      }
      return 0.6;
    case 'locate_consent_checkbox':
      if (!parsed.found) return 0.7;
      if (parsed.checkbox_center_norm && typeof parsed.checkbox_center_norm.x === 'number' && typeof parsed.checkbox_center_norm.y === 'number') {
        return 0.84;
      }
      return 0.58;
    case 'classify_vote_failure':
      if (parsed.summary && parsed.summary.length > 20 && parsed.category && parsed.category !== 'other') return 0.82;
      if (parsed.summary && parsed.summary.length > 12) return 0.68;
      return 0.45;
    default:
      return 0.5;
  }
}
