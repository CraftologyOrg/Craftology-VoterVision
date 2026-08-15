import { Writable } from 'node:stream';
import { openMonitorDb, closeMonitorDb, isMonitorReady, getMonitorPaths } from './db.js';
import { enqueue, flushMonitorWrites, pruneExpiredRows } from './writer.js';
import { ingestPinoLine, recordHttpRequest, noteVisionRequest, recordVisionEvent } from './ingest.js';
import { loggedFetch, recordNetworkCall, classifyService } from './network.js';
import { pollDeepInfraBilling } from './billing.js';
import { BILLING_POLL_MS, RETENTION_INTERVAL_MS } from './constants.js';

let billingTimer = null;
let retentionTimer = null;
let started = false;

export function initMonitor() {
  if (isMonitorReady()) return getMonitorPaths();
  openMonitorDb();
  return getMonitorPaths();
}

export function createPinoStream() {
  return new Writable({
    write(chunk, _enc, cb) {
      try {
        process.stdout.write(chunk);
        const text = chunk.toString();
        for (const line of text.split('\n')) ingestPinoLine(line);
      } catch {
        // never break logging
      }
      cb();
    },
  });
}

export function registerMonitorHttpHook(fastify) {
  fastify.addHook('onResponse', (request, reply, done) => {
    try {
      recordHttpRequest(request, reply);
    } catch {
      // ignore
    }
    done();
  });
}

export function startMonitorBackground(log) {
  if (started) return;
  started = true;
  pollDeepInfraBilling().catch((err) => {
    log?.warn?.({ err }, 'DeepInfra billing poll failed');
  });
  try {
    pruneExpiredRows();
  } catch (err) {
    log?.warn?.({ err }, 'Monitor retention prune failed');
  }

  billingTimer = setInterval(() => {
    pollDeepInfraBilling().catch((err) => {
      log?.warn?.({ err }, 'DeepInfra billing poll failed');
    });
  }, BILLING_POLL_MS);
  billingTimer.unref?.();

  retentionTimer = setInterval(() => {
    try {
      flushMonitorWrites();
      pruneExpiredRows();
    } catch (err) {
      log?.warn?.({ err }, 'Monitor retention prune failed');
    }
  }, RETENTION_INTERVAL_MS);
  retentionTimer.unref?.();
}

export function shutdownMonitor() {
  if (billingTimer) clearInterval(billingTimer);
  if (retentionTimer) clearInterval(retentionTimer);
  billingTimer = null;
  retentionTimer = null;
  started = false;
  try {
    flushMonitorWrites();
  } catch {
    // ignore
  }
  closeMonitorDb();
}

export {
  enqueue,
  flushMonitorWrites,
  loggedFetch,
  recordNetworkCall,
  classifyService,
  noteVisionRequest,
  recordVisionEvent,
  pollDeepInfraBilling,
  isMonitorReady,
  getMonitorPaths,
};
