export const RETENTION_MS = 60 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'vv_monitor_sid';
export const MAX_PAYLOAD = 8 * 1024;
export const MAX_EXCERPT = 2000;
export const FLUSH_INTERVAL_MS = 100;
export const FLUSH_BATCH_SIZE = 50;
export const BILLING_POLL_MS = 3 * 60 * 1000;
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
export const SCHEMA_VERSION = 1;

export const SKIP_HTTP_PATHS = new Set(['/', '/health', '/live', '/ready']);

export const LEVEL_NAMES = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};
