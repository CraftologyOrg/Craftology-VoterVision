class QueueError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

class GlobalLimiter {
  constructor(concurrency) {
    this.concurrency =
      concurrency === Infinity || !Number.isFinite(concurrency) || concurrency <= 0
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, Math.floor(concurrency));
    this.active = 0;
    this.waiters = [];
  }

  acquire(signal) {
    if (signal?.aborted) {
      return Promise.reject(new QueueError('queue_timeout', 'Vision queue wait timed out', 503));
    }

    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };

      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new QueueError('queue_timeout', 'Vision queue wait timed out', 503));
      };

      waiter.resolve = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active += 1;
        resolve(() => this.release());
      };

      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next.resolve();
  }

  stats() {
    return {
      active: this.active,
      waiting_global: this.waiters.length,
      concurrency: this.concurrency,
    };
  }
}

/**
 * Parallel vision: many in-flight model runs per license/HWID up to maxPendingPerUser
 * (tier `tier_max_sessions_per_hwid`). GlobalLimiter caps total concurrent runs **on this process
 * for all tenants** (raise for many users × parallel tabs; `0`/`-1` env = unlimited here).
 */
export class VisionRequestQueue {
  constructor({
    globalConcurrency = 4096,
    maxPendingPerUser = 128,
    queueTimeoutMs = 30000,
  } = {}) {
    this.maxPendingPerUser = Math.max(1, maxPendingPerUser);
    this.queueTimeoutMs = Math.max(1000, queueTimeoutMs);
    this.pendingByUser = new Map();
    this.limiter = new GlobalLimiter(globalConcurrency);
  }

  _incUser(key) {
    this.pendingByUser.set(key, (this.pendingByUser.get(key) || 0) + 1);
  }

  _decUser(key) {
    const n = (this.pendingByUser.get(key) || 1) - 1;
    if (n <= 0) this.pendingByUser.delete(key);
    else this.pendingByUser.set(key, n);
  }

  _pendingForUser(key) {
    return this.pendingByUser.get(key) || 0;
  }

  enqueue(userKey, job, options = {}) {
    const key = String(userKey || 'anonymous');
    const maxPendingForRequest = Number.isFinite(Number(options.maxPendingPerUser))
      ? Math.max(1, Math.floor(Number(options.maxPendingPerUser)))
      : this.maxPendingPerUser;

    if (this._pendingForUser(key) >= maxPendingForRequest) {
      throw new QueueError('queue_full', 'Too many pending vision requests for this user', 429);
    }

    this._incUser(key);

    const queuedAt = Date.now();
    const controller = new AbortController();

    return (async () => {
      const slotTimer = setTimeout(() => {
        controller.abort();
      }, this.queueTimeoutMs);

      let release;
      try {
        release = await this.limiter.acquire(controller.signal);
        clearTimeout(slotTimer);

        const startedAt = Date.now();
        return await job({
          queueWaitMs: startedAt - queuedAt,
          queuedAt,
          startedAt,
        });
      } catch (err) {
        if (err instanceof QueueError) throw err;
        if (controller.signal.aborted) {
          throw new QueueError('queue_timeout', 'Vision queue wait timed out', 503);
        }
        throw err;
      } finally {
        clearTimeout(slotTimer);
        if (release) release();
        this._decUser(key);
      }
    })();
  }

  stats() {
    let pending = 0;
    for (const n of this.pendingByUser.values()) pending += n;

    return {
      users: this.pendingByUser.size,
      pending,
      max_pending_per_user: this.maxPendingPerUser,
      queue_timeout_ms: this.queueTimeoutMs,
      ...this.limiter.stats(),
    };
  }
}

function parseConcurrencyEnv(raw, fallback) {
  const n = parseInt(raw, 10);
  if (n === 0 || n === -1) return Number.MAX_SAFE_INTEGER;
  if (Number.isFinite(n) && n > 0) return n;
  return fallback;
}

export function createVisionQueueFromEnv() {
  return new VisionRequestQueue({
    globalConcurrency: parseConcurrencyEnv(process.env.VISION_GLOBAL_CONCURRENCY, 4096),
    maxPendingPerUser: parseInt(process.env.VISION_QUEUE_MAX_PENDING_PER_USER, 10) || 128,
    queueTimeoutMs: parseInt(process.env.VISION_QUEUE_TIMEOUT_MS, 10) || 30000,
  });
}

export { QueueError };
