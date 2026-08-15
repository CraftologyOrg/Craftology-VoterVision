import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from './constants.js';

let db = null;
let dataDir = null;

export function getDataDir() {
  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH
    || process.env.MONITOR_DATA_DIR
    || path.join(process.cwd(), 'data');
  return path.join(mount, 'monitor');
}

export function getDb() {
  if (!db) throw new Error('Monitor database is not initialized');
  return db;
}

export function isMonitorReady() {
  return Boolean(db);
}

export function openMonitorDb() {
  dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'monitor.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function closeMonitorDb() {
  if (!db) return;
  try {
    db.close();
  } catch {
    // already closed
  }
  db = null;
}

export function getMonitorPaths() {
  return {
    dataDir,
    dbFile: dataDir ? path.join(dataDir, 'monitor.db') : null,
    volumeMount: process.env.RAILWAY_VOLUME_MOUNT_PATH || null,
  };
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      level TEXT NOT NULL,
      msg TEXT,
      request_id TEXT,
      task TEXT,
      provider TEXT,
      model TEXT,
      license_id TEXT,
      error TEXT,
      payload TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_app_logs_ts ON app_logs(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_app_logs_level_ts ON app_logs(level, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_app_logs_task_ts ON app_logs(task, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_app_logs_req ON app_logs(request_id);

    CREATE TABLE IF NOT EXISTS http_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      method TEXT,
      path TEXT,
      status INTEGER,
      latency_ms INTEGER,
      license_id TEXT,
      user_id TEXT,
      task TEXT,
      provider TEXT,
      model TEXT,
      cached INTEGER,
      error TEXT,
      queue_wait_ms INTEGER,
      ip TEXT,
      request_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_http_ts ON http_requests(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_http_status_ts ON http_requests(status, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_http_path_ts ON http_requests(path, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_http_task_ts ON http_requests(task, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_http_license ON http_requests(license_id, ts DESC);

    CREATE TABLE IF NOT EXISTS network_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      service TEXT,
      method TEXT,
      url TEXT,
      status INTEGER,
      latency_ms INTEGER,
      error TEXT,
      model TEXT,
      task TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      request_id TEXT,
      request_excerpt TEXT,
      response_excerpt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_net_ts ON network_calls(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_net_service_ts ON network_calls(service, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_net_status_ts ON network_calls(status, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_net_model_ts ON network_calls(model, ts DESC);

    CREATE TABLE IF NOT EXISTS vision_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      task TEXT,
      success INTEGER NOT NULL,
      cached INTEGER,
      provider TEXT,
      model TEXT,
      latency_ms INTEGER,
      error TEXT,
      attempts_json TEXT,
      license_id TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      queue_wait_ms INTEGER,
      request_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_vision_ts ON vision_events(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_vision_task_ts ON vision_events(task, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_vision_provider_ts ON vision_events(provider, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_vision_success_ts ON vision_events(success, ts DESC);

    CREATE TABLE IF NOT EXISTS metrics_minute (
      ts INTEGER PRIMARY KEY,
      requests INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      latency_sum INTEGER DEFAULT 0,
      latency_count INTEGER DEFAULT 0,
      latency_max INTEGER DEFAULT 0,
      tokens INTEGER DEFAULT 0,
      deepinfra_calls INTEGER DEFAULT 0,
      ollama_calls INTEGER DEFAULT 0,
      supabase_calls INTEGER DEFAULT 0,
      cache_hits INTEGER DEFAULT 0,
      vision_success INTEGER DEFAULT 0,
      vision_fail INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS billing_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      stripe_balance REAL,
      available_usd REAL,
      owed_usd REAL,
      recent_usd REAL,
      spending_limit_usd REAL,
      suspended INTEGER,
      suspend_reason TEXT,
      usage_json TEXT,
      checklist_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_billing_ts ON billing_snapshots(ts DESC);

    CREATE TABLE IF NOT EXISTS staff_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_exp ON staff_sessions(expires_at);
  `);

  ensureFts(database, 'app_logs', 'app_logs_fts', ['msg', 'error', 'payload', 'task', 'provider', 'model']);
  ensureFts(database, 'network_calls', 'network_calls_fts', ['url', 'error', 'request_excerpt', 'response_excerpt', 'service', 'model', 'task']);

  database.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
}

function ensureFts(database, table, ftsName, columns) {
  const exists = database.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(ftsName);
  if (exists) return;

  const colList = columns.join(', ');
  const newCols = columns.map((c) => `new.${c}`).join(', ');
  const oldCols = columns.map((c) => `old.${c}`).join(', ');
  database.exec(`
    CREATE VIRTUAL TABLE ${ftsName} USING fts5(
      ${colList},
      content='${table}',
      content_rowid='id',
      tokenize='unicode61'
    );
    CREATE TRIGGER ${table}_ai AFTER INSERT ON ${table} BEGIN
      INSERT INTO ${ftsName}(rowid, ${colList}) VALUES (new.id, ${newCols});
    END;
    CREATE TRIGGER ${table}_ad AFTER DELETE ON ${table} BEGIN
      INSERT INTO ${ftsName}(${ftsName}, rowid, ${colList}) VALUES ('delete', old.id, ${oldCols});
    END;
  `);
}
