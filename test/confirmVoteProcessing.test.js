import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseResponse } from '../src/lib/parser.js';

describe('confirm_vote processing outcome', () => {
  it('parses explicit processing JSON with wait_seconds', () => {
    const raw = JSON.stringify({
      outcome: 'processing',
      confirmed: false,
      message: 'Hang on — processing your vote',
      can_retry: true,
      interference: 'processing_modal',
      wait_seconds: 9,
    });
    const result = parseResponse(raw, 'confirm_vote');
    assert.equal(result.error, undefined);
    assert.equal(result.outcome, 'processing');
    assert.equal(result.confirmed, false);
    assert.equal(result.can_retry, true);
    assert.equal(result.wait_seconds, 9);
    assert.equal(result.interference, 'processing_modal');
  });

  it('fallback maps processing modal text to processing not interference', () => {
    const raw = 'HANG ON! We are processing your vote. DO NOT CLOSE THIS TAB! Processing... 9s';
    const result = parseResponse(raw, 'confirm_vote');
    assert.equal(result.outcome, 'processing');
    assert.equal(result.confirmed, false);
    assert.equal(result.can_retry, true);
    assert.equal(result.wait_seconds, 9);
  });

  it('fallback still maps captcha blockers to interference', () => {
    const raw = 'Please complete the Cloudflare Turnstile challenge before voting';
    const result = parseResponse(raw, 'confirm_vote');
    assert.equal(result.outcome, 'interference');
    assert.equal(result.confirmed, false);
  });
});
