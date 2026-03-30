import { getPrompt, isValidTask, VALID_TASK_LIST } from '../lib/prompts.js';
import { queryModel } from '../lib/ollama.js';
import { parseResponse } from '../lib/parser.js';

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
    const { screenshot, task, context } = request.body;
    const start = Date.now();

    if (!isValidTask(task)) {
      return reply.code(400).send({
        error: 'invalid_task',
        message: `Unknown task "${task}". Valid tasks: find_submit_button, detect_captcha, check_page_ready, find_input_fields, detect_vote_result, locate_captcha_checkbox`,
        fallback: true,
      });
    }

    const prompt = getPrompt(task, context);

    const modelResult = await queryModel(prompt, screenshot, task);

    if (modelResult.error) {
      const timeoutOnFallbackTask = task === 'locate_captcha_checkbox' && modelResult.error === 'timeout';
      const logger = timeoutOnFallbackTask ? request.log.info.bind(request.log) : request.log.warn.bind(request.log);
      logger({
        task,
        error: modelResult.error,
        latencyMs: Date.now() - start,
      }, timeoutOnFallbackTask ? 'Vision fallback timeout' : 'Vision model error');

      return reply.code(modelResult.error === 'timeout' ? 504 : 503).send({
        error: modelResult.error,
        message: modelResult.message,
        fallback: true,
      });
    }

    const parsed = parseResponse(modelResult.response, task);

    if (parsed.error) {
      request.log.warn({
        task,
        parseError: parsed.error,
        rawResponse: modelResult.response?.slice(0, 300),
        latencyMs: Date.now() - start,
      }, 'Vision response parse failed');

      return reply.code(422).send({
        error: parsed.error,
        message: parsed.message,
        fallback: true,
      });
    }

    const latencyMs = modelResult.latencyMs || (Date.now() - start);

    request.log.info({
      task,
      latencyMs,
      cached: modelResult.cached,
      confidence: parsed.confidence,
    }, 'Vision analysis complete');

    return {
      task,
      result: parsed,
      confidence: estimateConfidence(task, parsed),
      reasoning: parsed.description || parsed.reason || parsed.message || '',
      model: 'moondream2',
      latency_ms: latencyMs,
    };
  });
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
