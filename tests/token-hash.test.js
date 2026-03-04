const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { hashToken } = require('../app/repo/sessionsRepo');

describe('session token hashing', () => {
  it('is deterministic for the same token', () => {
    const token = 'sf_test_token';
    assert.equal(hashToken(token), hashToken(token));
  });

  it('changes when token changes', () => {
    assert.notEqual(hashToken('sf_a'), hashToken('sf_b'));
  });

  it('uses hex-encoded sha256 shape', () => {
    const hashed = hashToken('sf_shape_test');
    assert.equal(hashed.length, 64);
    assert.match(hashed, /^[a-f0-9]{64}$/);
  });
});
