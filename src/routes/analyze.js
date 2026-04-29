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

function getMaxPendingForRequest(request) {
  const tierCap = Number(request.entitlements?.maxCaptchaSlotsPerDevice ?? 0);
  if (!Number.isFinite(tierCap) || tierCap < 1) return undefined;
  return Math.min(1000, Math.floor(tierCap));
}

export default async function analyzeRoutes(fastify) {
  fastify.post('/analyze', {
    config: {
      // Expensive endpoint: keep much tighter than global limiter.
      rateLimit: {
        max: 120,
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
    const { screenshot, task, context } = request.body;
    const start = Date.now();

    if (!isValidTask(task)) {
      return reply.code(400).send({
        error: 'invalid_task',
        message: `Unknown task "${task}". Valid tasks: ${VALID_TASK_LIST.join(', ')}`,
        fallback: true,
      });
    }

    const prompt = getPrompt(task, context);
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
      confidence: parsed.confidence,
    }, 'Vision analysis complete');

    return {
      task,
      result: parsed,
      confidence: estimateConfidence(task, parsed),
      reasoning: parsed.description || parsed.reason || parsed.message || '',
      provider: modelResult.provider,
      model: modelResult.model,
      latency_ms: latencyMs,
      queue_wait_ms: queueWaitMs,
      cached: modelResult.cached,
    };
  });

  fastify.post('/confirm-vote', {
    config: {
      rateLimit: {
        max: 180,
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
    default:
      return 0.5;
  }
}
