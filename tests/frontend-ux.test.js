/**
 * Frontend logic tests for strict stream key/path handling and connect diagnostics.
 *
 * Run: node --test tests/frontend-ux.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function isValidStreamKey(key) {
  return /^[A-Za-z0-9_-]{3,64}$/.test(key);
}

function isValidSessionStreamPath(path) {
  return /^s\/[a-f0-9]{16}\/[A-Za-z0-9_-]{3,64}$/.test(path);
}

function classifyQuality(bitrateKbps) {
  if (typeof bitrateKbps !== 'number' || bitrateKbps <= 0) return 'unknown';
  if (bitrateKbps >= 4500) return 'excellent';
  if (bitrateKbps >= 2500) return 'good';
  if (bitrateKbps >= 1000) return 'fair';
  return 'poor';
}

function discoveryState({ keyValid, hasPreparedCreds, isLive }) {
  if (!keyValid) return 'not discovered';
  if (isLive) return 'live';
  return hasPreparedCreds ? 'discovered' : 'not discovered';
}

describe('Stream key validation', () => {
  it('accepts valid key with letters numbers underscore and dash', () => {
    assert.ok(isValidStreamKey('stream_key-01'));
  });

  it('rejects too short keys', () => {
    assert.equal(isValidStreamKey('ab'), false);
  });

  it('rejects too long keys', () => {
    assert.equal(isValidStreamKey('a'.repeat(65)), false);
  });

  it('rejects slash and whitespace', () => {
    assert.equal(isValidStreamKey('my/key'), false);
    assert.equal(isValidStreamKey('my key'), false);
  });
});

describe('Session stream path validation', () => {
  it('accepts strict session path', () => {
    assert.ok(isValidSessionStreamPath('s/0123456789abcdef/stream_1'));
  });

  it('rejects non-session prefixes', () => {
    assert.equal(isValidSessionStreamPath('live/test'), false);
  });

  it('rejects invalid session id shape', () => {
    assert.equal(isValidSessionStreamPath('s/xyz/stream'), false);
  });

  it('rejects invalid key shape inside path', () => {
    assert.equal(isValidSessionStreamPath('s/0123456789abcdef/stream/key'), false);
  });
});

describe('Quality classification', () => {
  it('maps unknown when bitrate missing/non-positive', () => {
    assert.equal(classifyQuality(null), 'unknown');
    assert.equal(classifyQuality(0), 'unknown');
  });

  it('maps poor/fair/good/excellent thresholds', () => {
    assert.equal(classifyQuality(999), 'poor');
    assert.equal(classifyQuality(1000), 'fair');
    assert.equal(classifyQuality(2500), 'good');
    assert.equal(classifyQuality(4500), 'excellent');
  });
});

describe('Discovery state machine', () => {
  it('invalid key always reports not discovered', () => {
    assert.equal(discoveryState({ keyValid: false, hasPreparedCreds: true, isLive: true }), 'not discovered');
  });

  it('valid key + prepared creds + not live reports discovered', () => {
    assert.equal(discoveryState({ keyValid: true, hasPreparedCreds: true, isLive: false }), 'discovered');
  });

  it('valid key + live stream reports live', () => {
    assert.equal(discoveryState({ keyValid: true, hasPreparedCreds: true, isLive: true }), 'live');
  });

  it('valid key without prepared creds reports not discovered', () => {
    assert.equal(discoveryState({ keyValid: true, hasPreparedCreds: false, isLive: false }), 'not discovered');
  });
});
