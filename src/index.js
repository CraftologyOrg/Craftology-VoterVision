import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import supabasePlugin from './plugins/supabase.js';
import authPlugin from './middleware/auth.js';
import analyzeRoutes, { visionQueue } from './routes/analyze.js';
import monitorRoutes from './routes/monitor.js';
import { checkProvidersAvailable, getVisionStatus, isVisionReady, warmupModel } from './lib/visionModel.js';
import { loggedFetch } from './lib/monitor/network.js';
import {
  createPinoStream,
  initMonitor,
  registerMonitorHttpHook,
  shutdownMonitor,
  startMonitorBackground,
} from './lib/monitor/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

initMonitor();

const fastify = Fastify({
  logger: {
    stream: createPinoStream(),
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["captcha-token"]',
        'req.headers.hwid',
        '*.screenshot',
        '*.page_html',
        '*.pageHtml',
        '*.password',
        '*.access_token',
        '*.refresh_token',
      ],
      censor: '[Redacted]',
    },
  },
  disableRequestLogging: true,
  trustProxy: process.env.TRUST_PROXY === 'true',
  bodyLimit: 10 * 1024 * 1024, // 10MB for base64 screenshots
});

registerMonitorHttpHook(fastify);

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
    .finally(() => {
      shutdownMonitor();
      process.exit(1);
    });
});

await fastify.register(cookie, {
  secret: process.env.MONITOR_COOKIE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-monitor-cookie',
  hook: 'onRequest',
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
await fastify.register(monitorRoutes);

await fastify.register(fastifyStatic, {
  root: path.join(__dirname, '../public/monitor'),
  prefix: '/monitor/static/',
  decorateReply: true,
  index: false,
});

// Health check always returns 200 — Railway must not kill the container
// just because the Ollama sidecar is temporarily unavailable.
fastify.get('/live', {
  config: { skipAuth: true, rateLimit: false },
}, async () => {
  const vision = getVisionStatus();
  return { status: 'ok', ready: vision.ready, vision, queue: visionQueue.stats() };
});

// Backward compatibility alias.
fastify.get('/health', {
  config: { skipAuth: true, rateLimit: false },
}, async () => {
  const vision = getVisionStatus();
  return { status: 'ok', ready: vision.ready, vision, queue: visionQueue.stats() };
});

fastify.get('/ready', {
  config: { skipAuth: true, rateLimit: false },
}, async (_request, reply) => {
  // Probe dependency availability directly; do not depend on user traffic.
  const available = await checkProvidersAvailable();
  const vision = getVisionStatus();
  if (!available || !isVisionReady()) {
    return reply.code(503).send({ status: 'not_ready', ready: false, vision, queue: visionQueue.stats() });
  }
  return { status: 'ready', ready: true, vision, queue: visionQueue.stats() };
});

const port = parseInt(process.env.PORT) || 3000;

const shutdown = async (signal) => {
  fastify.log.info(`Received ${signal} — shutting down gracefully`);
  await fastify.close();
  shutdownMonitor();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await fastify.listen({ port, host: '0.0.0.0' });

  const available = await checkProvidersAvailable();
  if (available) {
    fastify.log.info(getVisionStatus(), 'Vision providers are available');
    warmupModel().then(() => fastify.log.info('Ollama fallback warmup complete'))
                  .catch(() => {});
  } else {
    fastify.log.warn(getVisionStatus(), 'No vision provider is available — requests will return model_unavailable');
  }

  startMonitorBackground(fastify.log);

  const STATUS_INTERVAL_MS = 2 * 60 * 1000;
  setInterval(async () => {
    await checkProvidersAvailable();
    const vision = getVisionStatus();

    let supabaseStatus = 'unknown';
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && supabaseKey) {
      try {
        const resp = await loggedFetch(`${supabaseUrl}/rest/v1/`, {
          headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
          signal: AbortSignal.timeout(5000),
        }, { service: 'supabase', request_meta: { probe: 'status' } });
        supabaseStatus = resp.ok || resp.status < 500 ? 'connected' : 'degraded';
      } catch {
        supabaseStatus = 'unreachable';
      }
    } else {
      supabaseStatus = 'not configured';
    }

    fastify.log.info({ vision, queue: visionQueue.stats(), supabase: supabaseStatus }, 'Service status');
  }, STATUS_INTERVAL_MS).unref();
} catch (err) {
  fastify.log.error(err);
  shutdownMonitor();
  process.exit(1);
}
