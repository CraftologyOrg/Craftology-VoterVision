import 'dotenv/config';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import supabasePlugin from './plugins/supabase.js';
import authPlugin from './middleware/auth.js';
import analyzeRoutes from './routes/analyze.js';
import { checkModelAvailable, isModelReady } from './lib/ollama.js';

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
  process.exit(1);
});

const fastify = Fastify({
  logger: true,
  bodyLimit: 10 * 1024 * 1024, // 10MB for base64 screenshots
});

await fastify.register(rateLimit, {
  max: 30,
  timeWindow: '1 minute',
  errorResponseBuilder: () => ({ error: 'Too many requests', fallback: true }),
});

await fastify.register(supabasePlugin);
await fastify.register(authPlugin);
await fastify.register(analyzeRoutes);

// Health check always returns 200 — Railway must not kill the container
// just because the Ollama sidecar is temporarily unavailable.
fastify.get('/health', { config: { skipAuth: true } }, async () => {
  const ready = isModelReady();
  return { status: 'ok', model: 'moondream2', ready };
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
  } else {
    fastify.log.warn('moondream2 model is not yet available — requests will return model_unavailable until it is pulled');
  }

  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (publicDomain) {
    const pingUrl = `https://${publicDomain}/health`;
    const PING_INTERVAL_MS = 10 * 60 * 1000;

    setInterval(async () => {
      try {
        await fetch(pingUrl, { signal: AbortSignal.timeout(10000) });
        fastify.log.debug('Self-ping successful');
      } catch (err) {
        fastify.log.warn({ err: err.message }, 'Self-ping failed');
      }
    }, PING_INTERVAL_MS).unref();

    fastify.log.info({ pingUrl, intervalMinutes: 10 }, 'Self-ping keepalive configured');
  }
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
