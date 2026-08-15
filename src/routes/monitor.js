import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SESSION_COOKIE,
  getMonitorCookieOptions,
  getSessionIdFromRequest,
  loginStaff,
  resolveStaffSession,
  staffAuthHook,
} from '../middleware/staffAuth.js';
import { deleteStaffSession } from '../lib/monitor/sessions.js';
import {
  queryBillingHistory,
  queryFacets,
  queryHttp,
  queryLogs,
  queryNetwork,
  queryOverview,
  querySeries,
  queryStorageStats,
  queryVision,
} from '../lib/monitor/queries.js';
import { pollDeepInfraBilling } from '../lib/monitor/billing.js';
import { flushMonitorWrites, getMonitorPaths } from '../lib/monitor/index.js';
import { getVisionStatus } from '../lib/visionModel.js';
import { visionQueue } from './analyze.js';
import fp from 'fastify-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONITOR_HTML = readFileSync(path.join(__dirname, '../../public/monitor/index.html'), 'utf8');

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function monitorRoutes(fastify) {
  fastify.get('/monitor', {
    config: { skipAuth: true, rateLimit: false },
  }, async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(MONITOR_HTML);
  });

  fastify.get('/monitor/', {
    config: { skipAuth: true, rateLimit: false },
  }, async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(MONITOR_HTML);
  });

  fastify.post('/monitor/api/auth/login', {
    config: {
      skipAuth: true,
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body || {};
    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password are required' });
    }
    const result = await loginStaff(fastify, email, password);
    if (!result.ok) {
      return reply.code(result.status).send({ error: result.error });
    }
    reply.setCookie(SESSION_COOKIE, result.sessionId, getMonitorCookieOptions());
    return { ok: true, user: result.user };
  });

  fastify.post('/monitor/api/auth/logout', {
    config: { skipAuth: true, rateLimit: false },
  }, async (request, reply) => {
    const sessionId = getSessionIdFromRequest(request);
    deleteStaffSession(sessionId);
    reply.clearCookie(SESSION_COOKIE, getMonitorCookieOptions());
    return { ok: true };
  });

  fastify.get('/monitor/api/auth/me', {
    config: { skipAuth: true, rateLimit: false },
  }, async (request, reply) => {
    const sessionId = getSessionIdFromRequest(request);
    const staff = await resolveStaffSession(fastify, sessionId);
    if (!staff) return reply.code(401).send({ error: 'Staff login required' });
    return { user: { id: staff.id, email: staff.email } };
  });

  const api = async (instance) => {
    instance.addHook('onRoute', (routeOptions) => {
      routeOptions.config = { ...(routeOptions.config || {}), skipAuth: true };
    });
    instance.addHook('onRequest', staffAuthHook);

    instance.get('/overview', async (request) => {
      flushMonitorWrites();
      return queryOverview(request.query || {});
    });

    instance.get('/series', async (request) => querySeries(request.query || {}));
    instance.get('/logs', async (request) => queryLogs(request.query || {}));
    instance.get('/network', async (request) => queryNetwork(request.query || {}));
    instance.get('/http', async (request) => queryHttp(request.query || {}));
    instance.get('/vision', async (request) => queryVision(request.query || {}));
    instance.get('/facets', async (request) => queryFacets(request.query || {}));
    instance.get('/storage', async () => queryStorageStats());

    instance.get('/billing', async (request) => {
      flushMonitorWrites();
      return queryBillingHistory(request.query || {});
    });

    instance.post('/billing/refresh', async () => {
      const snapshot = await pollDeepInfraBilling();
      flushMonitorWrites();
      return { ok: true, snapshot };
    });

    instance.get('/status', async () => ({
      vision: getVisionStatus(),
      queue: visionQueue.stats(),
      monitor: getMonitorPaths(),
    }));

    instance.get('/logs.csv', async (request, reply) => {
      const { rows } = queryLogs({ ...(request.query || {}), limit: 2000 });
      const header = ['id', 'ts', 'level', 'msg', 'task', 'provider', 'model', 'license_id', 'error', 'request_id'];
      const lines = [header.join(',')];
      for (const row of rows) {
        lines.push(header.map((key) => csvEscape(row[key])).join(','));
      }
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="vision-logs.csv"');
      return lines.join('\n');
    });

    instance.get('/network.csv', async (request, reply) => {
      const { rows } = queryNetwork({ ...(request.query || {}), limit: 2000 });
      const header = ['id', 'ts', 'service', 'method', 'url', 'status', 'latency_ms', 'model', 'task', 'error', 'total_tokens'];
      const lines = [header.join(',')];
      for (const row of rows) {
        lines.push(header.map((key) => csvEscape(row[key])).join(','));
      }
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="vision-network.csv"');
      return lines.join('\n');
    });
  };

  await fastify.register(api, {
    prefix: '/monitor/api',
  });
}

export default fp(monitorRoutes, { name: 'monitor-routes' });
