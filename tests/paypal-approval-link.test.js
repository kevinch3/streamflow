const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCheckoutNowFallbackUrl,
  extractPayPalApprovalUrl,
} = require('../app/payments/paypal');

describe('PayPal approval URL extraction', () => {
  it('reads approve link from top-level links', () => {
    const url = extractPayPalApprovalUrl({
      id: 'ORDER123',
      links: [
        { rel: 'self', href: 'https://api.paypal.test/self' },
        { rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER123' },
      ],
    });
    assert.equal(url, 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER123');
  });

  it('reads payer-action link variants', () => {
    const dashed = extractPayPalApprovalUrl({
      id: 'ORDER123',
      links: [
        { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER123' },
      ],
    });
    assert.equal(dashed, 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER123');

    const underscored = extractPayPalApprovalUrl({
      id: 'ORDER124',
      links: [
        { rel: 'payer_action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER124' },
      ],
    });
    assert.equal(underscored, 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER124');
  });

  it('falls back to checkoutnow URL from order id', () => {
    const url = extractPayPalApprovalUrl({ id: 'ORDER125', links: [] });
    assert.ok(url.includes('checkoutnow?token=ORDER125'));
  });

  it('builds fallback URL only when order id exists', () => {
    assert.equal(buildCheckoutNowFallbackUrl(''), '');
    assert.equal(buildCheckoutNowFallbackUrl(null), '');
    assert.ok(buildCheckoutNowFallbackUrl('ORDER126').includes('ORDER126'));
  });
});
