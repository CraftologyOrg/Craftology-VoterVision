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
    this.concurrency = Math.max(1, concurrency);
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

export class VisionRequestQueue {
  constructor({
    globalConcurrency = 4,
    maxPendingPerUser = 8,
    queueTimeoutMs = 30000,
  } = {}) {
    this.maxPendingPerUser = Math.max(1, maxPendingPerUser);
    this.queueTimeoutMs = Math.max(1000, queueTimeoutMs);
    this.users = new Map();
    this.limiter = new GlobalLimiter(globalConcurrency);
  }

  enqueue(userKey, job, options = {}) {
    const key = String(userKey || 'anonymous');
    const state = this.users.get(key) || { queue: [], running: false };
    const maxPendingForRequest = Number.isFinite(Number(options.maxPendingPerUser))
      ? Math.max(1, Math.floor(Number(options.maxPendingPerUser)))
      : this.maxPendingPerUser;
    const pending = state.queue.length + (state.running ? 1 : 0);

    if (pending >= maxPendingForRequest) {
      throw new QueueError('queue_full', 'Too many pending vision requests for this user', 429);
    }

    this.users.set(key, state);

    const queuedAt = Date.now();
    const controller = new AbortController();
    let timeout;

    const promise = new Promise((resolve, reject) => {
      const item = {
        job,
        queuedAt,
        controller,
        cancelled: false,
        resolve,
        reject,
      };

      timeout = setTimeout(() => {
        item.cancelled = true;
        controller.abort();
        reject(new QueueError('queue_timeout', 'Vision queue wait timed out', 503));
        this.processUser(key);
      }, this.queueTimeoutMs);

      item.clearTimer = () => clearTimeout(timeout);
      state.queue.push(item);
      this.processUser(key);
    });

    return promise;
  }

  processUser(key) {
    const state = this.users.get(key);
    if (!state || state.running) return;

    const item = state.queue.shift();
    if (!item) {
      this.users.delete(key);
      return;
    }

    if (item.cancelled) {
      item.clearTimer();
      this.processUser(key);
      return;
    }

    state.running = true;

    this.runItem(key, state, item).catch(() => {
      // Errors are delivered to the request promise; this keeps the queue worker alive.
    });
  }

  async runItem(key, state, item) {
    let release;
    try {
      release = await this.limiter.acquire(item.controller.signal);
      item.clearTimer();

      const startedAt = Date.now();
      const result = await item.job({
        queueWaitMs: startedAt - item.queuedAt,
        queuedAt: item.queuedAt,
        startedAt,
      });
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    } finally {
      if (release) release();
      item.clearTimer();
      state.running = false;
      if (state.queue.length === 0 && this.users.get(key) === state) {
        this.users.delete(key);
      } else {
        this.processUser(key);
      }
    }
  }

  stats() {
    let pending = 0;
    for (const state of this.users.values()) {
      pending += state.queue.length + (state.running ? 1 : 0);
    }

    return {
      users: this.users.size,
      pending,
      max_pending_per_user: this.maxPendingPerUser,
      queue_timeout_ms: this.queueTimeoutMs,
      ...this.limiter.stats(),
    };
  }
}

export function createVisionQueueFromEnv() {
  return new VisionRequestQueue({
    globalConcurrency: parseInt(process.env.VISION_GLOBAL_CONCURRENCY, 10) || 4,
    maxPendingPerUser: parseInt(process.env.VISION_QUEUE_MAX_PENDING_PER_USER, 10) || 8,
    queueTimeoutMs: parseInt(process.env.VISION_QUEUE_TIMEOUT_MS, 10) || 30000,
  });
}

export { QueueError };
