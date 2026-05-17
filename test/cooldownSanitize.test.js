import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  textHasExplicitCooldownDuration,
  sanitizeCooldownFields,
  MAX_COOLDOWN_SECONDS,
} from '../src/lib/cooldownSanitize.js';
import { parseResponse } from '../src/lib/parser.js';

describe('textHasExplicitCooldownDuration', () => {
  it('returns false for topminecraftservers already-voted without timer', () => {
    const msg = "Someone has already voted for this server using the username 'CrankerFrank'";
    assert.equal(textHasExplicitCooldownDuration(msg), false);
  });

  it('returns true for visible duration text', () => {
    assert.equal(textHasExplicitCooldownDuration('You can vote again in 4h 59m'), true);
    assert.equal(textHasExplicitCooldownDuration('vote again in 12 hours'), true);
  });
});

describe('sanitizeCooldownFields', () => {
  it('clears bogus cooldown_remaining_seconds when no duration in message', () => {
    const result = sanitizeCooldownFields({
      outcome: 'already_voted',
      message: "Someone has already voted for this server using the username 'CrankerFrank'",
      cooldown_remaining_seconds: 255000,
      cooldown_until_iso: '',
    });
    assert.equal(result.cooldown_remaining_seconds, null);
    assert.equal(result.cooldown_until_iso, '');
  });

  it('caps seconds when duration is explicit in message', () => {
    const result = sanitizeCooldownFields({
      outcome: 'already_voted',
      message: 'Vote again in 4h 59m',
      cooldown_remaining_seconds: 255000,
      cooldown_until_iso: '',
    });
    assert.equal(result.cooldown_remaining_seconds, MAX_COOLDOWN_SECONDS);
  });

  it('preserves valid seconds under cap', () => {
    const result = sanitizeCooldownFields({
      message: 'Try again in 2 hours',
      cooldown_remaining_seconds: 7200,
      cooldown_until_iso: '',
    });
    assert.equal(result.cooldown_remaining_seconds, 7200);
  });
});

describe('parseResponse cooldown integration', () => {
  it('sanitizes detect_vote_result JSON with bogus seconds', () => {
    const raw = JSON.stringify({
      outcome: 'already_voted',
      message: "Someone has already voted for this server using the username 'CrankerFrank'",
      can_retry: false,
      cooldown_remaining_seconds: 255000,
      cooldown_until_iso: '',
    });
    const result = parseResponse(raw, 'detect_vote_result');
    assert.equal(result.cooldown_remaining_seconds, null);
    assert.equal(result.cooldown_until_iso, '');
  });
});
