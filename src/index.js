import 'dotenv/config';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import supabasePlugin from './plugins/supabase.js';
import authPlugin from './middleware/auth.js';
import analyzeRoutes from './routes/analyze.js';
import { checkModelAvailable, isModelReady, warmupModel } from './lib/ollama.js';

const fastify = Fastify({
  logger: true,
  trustProxy: process.env.TRUST_PROXY === 'true',
  bodyLimit: 10 * 1024 * 1024, // 10MB for base64 screenshots
});

// Production: log promise rejections without tearing down the server (orchestrator can still restart on crash).
process.on('unhandledRejection', (reason) => {
  fastify.log.error({ reason }, 'unhandledRejection');
});

// Uncaught exceptions leave the process in an undefined state — close HTTP gracefully, then exit for a clean restart.
process.on('uncaughtException', (err) => {
  fastify.log.fatal(err, 'uncaughtException');
  fastify
    .close()
    .catch(() => {})
    .finally(() => process.exit(1));
});

await fastify.register(rateLimit, {
  max: 4000,
  timeWindow: '1 minute',
  // Pre-auth limiter must not trust client-provided identity headers.
  keyGenerator: (request) => request.ip,
  errorResponseBuilder: () => ({ error: 'Too many requests', fallback: true }),
});

await fastify.register(supabasePlugin);
await fastify.register(authPlugin);
await fastify.register(analyzeRoutes);

// Health check always returns 200 — Railway must not kill the container
// just because the Ollama sidecar is temporarily unavailable.
fastify.get('/live', {
  config: { skipAuth: true, rateLimit: false },
}, async () => {
  const ready = isModelReady();
  return { status: 'ok', model: 'moondream2', ready };
});

// Backward compatibility alias.
fastify.get('/health', {
  config: { skipAuth: true, rateLimit: false },
}, async () => {
  const ready = isModelReady();
  return { status: 'ok', model: 'moondream2', ready };
});

fastify.get('/ready', {
  config: { skipAuth: true, rateLimit: false },
}, async (_request, reply) => {
  // Probe dependency availability directly; do not depend on user traffic.
  const available = await checkModelAvailable();
  if (!available || !isModelReady()) {
    return reply.code(503).send({ status: 'not_ready', model: 'moondream2', ready: false });
  }
  return { status: 'ready', model: 'moondream2', ready: true };
});

const port = parseInt(process.env.PORT) || 3000;

const shutdown = async (signal) => {
  fastify.log.info(`Received ${signal} — shutting down gracefully`);
  await fastify.close();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await fastify.listen({ port, host: '0.0.0.0' });

  const available = await checkModelAvailable();
  if (available) {
    fastify.log.info('moondream2 model is available and ready');
    warmupModel().then(() => fastify.log.info('moondream2 warmup complete'))
                  .catch(() => {});
  } else {
    fastify.log.warn('moondream2 model is not yet available — requests will return model_unavailable until it is pulled');
  }

  const STATUS_INTERVAL_MS = 2 * 60 * 1000;
  setInterval(async () => {
    const ollamaAvailable = await checkModelAvailable();

    let supabaseStatus = 'unknown';
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && supabaseKey) {
      try {
        const resp = await fetch(`${supabaseUrl}/rest/v1/`, {
          headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
          signal: AbortSignal.timeout(5000),
        });
        supabaseStatus = resp.ok || resp.status < 500 ? 'connected' : 'degraded';
      } catch {
        supabaseStatus = 'unreachable';
      }
    } else {
      supabaseStatus = 'not configured';
    }

    fastify.log.info({ ollama: ollamaAvailable ? 'available' : 'unavailable', supabase: supabaseStatus }, 'Service status');
  }, STATUS_INTERVAL_MS).unref();
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
