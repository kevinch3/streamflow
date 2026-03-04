const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { computeNextBalance } = require('../app/repo/creditsRepo');

describe('computeNextBalance', () => {
  it('applies normal deductions', () => {
    const result = computeNextBalance(100, -3);
    assert.deepEqual(result, { next: 97, appliedDelta: -3 });
  });

  it('clamps balance at zero', () => {
    const result = computeNextBalance(2, -5);
    assert.deepEqual(result, { next: 0, appliedDelta: -2 });
  });

  it('keeps zero when already empty', () => {
    const result = computeNextBalance(0, -5);
    assert.deepEqual(result, { next: 0, appliedDelta: 0 });
  });

  it('applies positive deltas', () => {
    const result = computeNextBalance(5, 7);
    assert.deepEqual(result, { next: 12, appliedDelta: 7 });
  });
});
