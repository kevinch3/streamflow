const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { clampLimit } = require('../app/repo/ledgerRepo');

describe('clampLimit', () => {
  it('falls back to default for invalid input', () => {
    assert.equal(clampLimit('abc', 50), 50);
  });

  it('enforces minimum of 1', () => {
    assert.equal(clampLimit('0', 50), 1);
  });

  it('enforces maximum of 200', () => {
    assert.equal(clampLimit('999', 50), 200);
  });
});
