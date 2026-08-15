import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact, sanitizeFtsQuery } from '../src/lib/monitor/redact.js';
import { availableUsdFromStripeBalance, owedUsdFromStripeBalance, toUsd } from '../src/lib/monitor/billing.js';
import { classifyService } from '../src/lib/monitor/network.js';
import { closeMonitorDb, openMonitorDb } from '../src/lib/monitor/db.js';
import { enqueue, flushMonitorWrites } from '../src/lib/monitor/writer.js';
import { queryLogs, queryNetwork } from '../src/lib/monitor/queries.js';

test('sanitizeFtsQuery strips operators and quotes terms', () => {
  assert.equal(sanitizeFtsQuery('rate AND timeout'), '"rate" AND "timeout"');
  assert.equal(sanitizeFtsQuery('a "x" (boom)'), '"boom"');
  assert.equal(sanitizeFtsQuery('x'), '');
});

test('redact strips secrets and screenshots', () => {
  const out = redact({
    Authorization: 'Bearer secret',
    screenshot: 'aaaa',
    nested: { password: 'p', task: 'confirm_vote' },
  });
  assert.equal(out.Authorization, '[Redacted]');
  assert.equal(out.screenshot, '[Redacted]');
  assert.equal(out.nested.password, '[Redacted]');
  assert.equal(out.nested.task, 'confirm_vote');
});

test('DeepInfra stripe_balance conversion', () => {
  assert.equal(toUsd(-1250), -12.5);
  assert.equal(availableUsdFromStripeBalance(-1250), 12.5);
  assert.equal(owedUsdFromStripeBalance(-1250), 0);
  assert.equal(owedUsdFromStripeBalance(400), 4);
  assert.equal(toUsd(-12.5), -12.5);
});

test('classifyService maps outbound hosts', () => {
  assert.equal(classifyService('https://api.deepinfra.com/v1/openai/chat/completions'), 'deepinfra');
  assert.equal(classifyService('https://api.deepinfra.com/payment/checklist'), 'billing');
  assert.equal(classifyService('http://ollama.railway.internal:11434/api/generate'), 'ollama');
  assert.equal(classifyService('https://abc.supabase.co/rest/v1/failed_votes'), 'supabase');
});

test('monitor sqlite roundtrip stores logs and network rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-mon-'));
  process.env.MONITOR_DATA_DIR = dir;
  openMonitorDb();
  try {
    const ts = Date.now();
    enqueue('log', {
      ts, level: 'error', msg: 'DeepInfra timeout', request_id: 'req-1',
      task: 'confirm_vote', provider: 'deepinfra', model: 'qwen', license_id: null,
      error: 'timeout', payload: '{"attempts":1}',
    });
    enqueue('network', {
      ts, service: 'deepinfra', method: 'POST', url: 'https://api.deepinfra.com/v1/openai/chat/completions',
      status: 429, latency_ms: 120, error: 'HTTP 429', model: 'qwen', task: 'confirm_vote',
      prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, request_id: 'req-1',
      request_excerpt: '{"task":"confirm_vote"}', response_excerpt: 'rate limited',
    });
    flushMonitorWrites();
    const logs = queryLogs({ from: ts - 1000, to: ts + 1000, q: 'timeout' });
    assert.equal(logs.rows.length, 1);
    assert.equal(logs.rows[0].msg, 'DeepInfra timeout');
    const network = queryNetwork({ from: ts - 1000, to: ts + 1000, service: 'deepinfra' });
    assert.equal(network.rows.length, 1);
    assert.equal(network.rows[0].status, 429);
  } finally {
    closeMonitorDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
