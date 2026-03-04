const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  PromoRedeemError,
  isPromoRedeemError,
  normalizePromoCode,
} = require('../app/repo/promosRepo');

describe('promo repository helpers', () => {
  it('normalizes promo code input', () => {
    assert.equal(normalizePromoCode(' flow26 '), 'FLOW26');
    assert.equal(normalizePromoCode(''), '');
  });

  it('exposes typed promo redemption errors', () => {
    const err = new PromoRedeemError('promo_already_redeemed', 'already redeemed');
    assert.equal(isPromoRedeemError(err), true);
    assert.equal(isPromoRedeemError(err, 'promo_already_redeemed'), true);
    assert.equal(isPromoRedeemError(err, 'promo_exhausted'), false);
    assert.equal(isPromoRedeemError(new Error('x')), false);
  });
});
