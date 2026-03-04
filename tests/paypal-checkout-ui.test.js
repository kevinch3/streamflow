/**
 * Contract checks for popup-first PayPal checkout UX wiring in dashboard.js.
 *
 * Run: node --test tests/paypal-checkout-ui.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let dashboardJs = '';

before(() => {
  const root = path.resolve(__dirname, '..');
  dashboardJs = fs.readFileSync(path.join(root, 'html', 'js', 'dashboard.js'), 'utf8');
});

describe('Checkout persistence', () => {
  it('uses the required checkout storage key', () => {
    assert.ok(dashboardJs.includes("CHECKOUT_STORAGE_KEY = 'sf_paypal_checkout_v1'"));
  });

  it('defines checkout TTL as 30 minutes', () => {
    assert.ok(dashboardJs.includes('CHECKOUT_TTL_MS = 30 * 60 * 1000'));
  });

  it('tracks required pending statuses', () => {
    assert.ok(dashboardJs.includes("'creating'"));
    assert.ok(dashboardJs.includes("'awaiting_approval'"));
    assert.ok(dashboardJs.includes("'capturing'"));
    assert.ok(dashboardJs.includes("'returning'"));
  });
});

describe('Popup + fallback behavior', () => {
  it('loads PayPal SDK dynamically', () => {
    assert.ok(dashboardJs.includes('https://www.paypal.com/sdk/js?client-id='));
  });

  it('passes CSP nonce to PayPal SDK loader when available', () => {
    assert.ok(dashboardJs.includes("function getCspNonce()"));
    assert.ok(dashboardJs.includes("script.setAttribute('data-csp-nonce', cspNonce)"));
    assert.ok(dashboardJs.includes('script.nonce = cspNonce'));
  });

  it('supports redirect fallback function', () => {
    assert.ok(dashboardJs.includes('async function startRedirectFallback('));
  });

  it('supports sticky modal resume controls', () => {
    assert.ok(dashboardJs.includes('function requestClosePayModal()'));
    assert.ok(dashboardJs.includes('async function resumePaymentModal()'));
    assert.ok(dashboardJs.includes('function updateResumeBanner()'));
  });

  it('has popup-approval watchdog fallback to redirect', () => {
    assert.ok(dashboardJs.includes('POPUP_APPROVAL_TIMEOUT_MS = 12 * 1000'));
    assert.ok(dashboardJs.includes('function schedulePopupApprovalWatchdog(checkout)'));
    assert.ok(dashboardJs.includes('Popup blocked or not opened. Redirecting to PayPal…'));
  });
});
