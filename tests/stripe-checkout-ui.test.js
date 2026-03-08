/**
 * Contract checks for Stripe checkout wiring in dashboard.js.
 *
 * Run: node --test tests/stripe-checkout-ui.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let src = '';

before(() => {
  const root = path.resolve(__dirname, '..');
  src = fs.readFileSync(path.join(root, 'html', 'js', 'dashboard.js'), 'utf8');
});

// ---------------------------------------------------------------------------
// confirmPayment call
// ---------------------------------------------------------------------------
describe('confirmPayment options', () => {
  it('passes return_url so redirect-only methods (e.g. Amazon Pay) work', () => {
    assert.ok(
      src.includes("confirmParams: { return_url: window.location.href }"),
      'confirmPayment must include confirmParams.return_url'
    );
  });

  it('uses redirect: if_required to skip redirect for card payments', () => {
    assert.ok(src.includes("redirect: 'if_required'"));
  });

  it('passes the mounted elements object to confirmPayment', () => {
    // elements: stripeElements must appear inside the confirmPayment call block
    const callIdx = src.indexOf('stripeInstance.confirmPayment(');
    assert.ok(callIdx !== -1, 'confirmPayment call not found');
    const callBlock = src.slice(callIdx, callIdx + 300);
    assert.ok(callBlock.includes('elements: stripeElements'));
  });
});

// ---------------------------------------------------------------------------
// SDK loading
// ---------------------------------------------------------------------------
describe('Stripe SDK loading', () => {
  it('loads from the official Stripe v3 URL', () => {
    assert.ok(src.includes("script.src = 'https://js.stripe.com/v3/'"));
  });

  it('caches the SDK promise so it is only loaded once', () => {
    assert.ok(src.includes('if (stripeSdkPromise) return stripeSdkPromise'));
  });

  it('resolves immediately when window.Stripe already exists', () => {
    assert.ok(src.includes('if (window.Stripe) { resolve(window.Stripe); return; }'));
  });

  it('rejects the promise on script load error', () => {
    assert.ok(src.includes("script.onerror = () => reject(new Error('Failed to load Stripe SDK'))"));
  });

  it('applies CSP nonce to the injected script tag', () => {
    assert.ok(src.includes('if (nonce) script.nonce = nonce'));
  });
});

// ---------------------------------------------------------------------------
// Payment Element mounting
// ---------------------------------------------------------------------------
describe('mountStripeElement', () => {
  it('creates a payment element (not card element)', () => {
    assert.ok(src.includes("stripeElements.create('payment')"));
  });

  it('passes clientSecret when creating elements', () => {
    const mountIdx = src.indexOf('async function mountStripeElement(');
    const mountBlock = src.slice(mountIdx, mountIdx + 600);
    assert.ok(mountBlock.includes('clientSecret,'));
  });

  it('uses the night theme to match the dark dashboard', () => {
    assert.ok(src.includes("theme: 'night'"));
  });

  it('clears the container before mounting to avoid duplicate elements', () => {
    assert.ok(src.includes("container.innerHTML = ''"));
  });
});

// ---------------------------------------------------------------------------
// API request wiring
// ---------------------------------------------------------------------------
describe('requestCreateStripeIntent', () => {
  it('posts to /api/credits/purchase', () => {
    assert.ok(src.includes("async function requestCreateStripeIntent("));
    const fnIdx = src.indexOf('async function requestCreateStripeIntent(');
    const fnBlock = src.slice(fnIdx, fnIdx + 300);
    assert.ok(fnBlock.includes("'/api/credits/purchase'"));
  });

  it('sends method:stripe and action:create', () => {
    const fnIdx = src.indexOf('async function requestCreateStripeIntent(');
    const fnBlock = src.slice(fnIdx, fnIdx + 300);
    assert.ok(fnBlock.includes("method: 'stripe'"));
    assert.ok(fnBlock.includes("action: 'create'"));
  });
});

describe('requestConfirmStripe', () => {
  it('posts to /api/credits/purchase', () => {
    const fnIdx = src.indexOf('async function requestConfirmStripe(');
    const fnBlock = src.slice(fnIdx, fnIdx + 300);
    assert.ok(fnBlock.includes("'/api/credits/purchase'"));
  });

  it('sends method:stripe and action:confirm', () => {
    const fnIdx = src.indexOf('async function requestConfirmStripe(');
    const fnBlock = src.slice(fnIdx, fnIdx + 300);
    assert.ok(fnBlock.includes("method: 'stripe'"));
    assert.ok(fnBlock.includes("action: 'confirm'"));
  });

  it('includes paymentIntentId in the body', () => {
    const fnIdx = src.indexOf('async function requestConfirmStripe(');
    const fnBlock = src.slice(fnIdx, fnIdx + 300);
    assert.ok(fnBlock.includes('paymentIntentId'));
  });
});

// ---------------------------------------------------------------------------
// Checkout state machine
// ---------------------------------------------------------------------------
describe('purchaseWithStripe state transitions', () => {
  it('sets status to creating before calling the API', () => {
    const fnIdx = src.indexOf('async function purchaseWithStripe(');
    const fnBlock = src.slice(fnIdx, fnIdx + 600);
    assert.ok(fnBlock.includes("status: 'creating'"));
  });

  it('advances to awaiting_approval after intent is created', () => {
    const fnIdx = src.indexOf('async function purchaseWithStripe(');
    const fnBlock = src.slice(fnIdx, fnIdx + 600);
    assert.ok(fnBlock.includes("status: 'awaiting_approval'"));
  });

  it('falls back to failed status when intent creation throws', () => {
    const fnIdx = src.indexOf('async function purchaseWithStripe(');
    const fnBlock = src.slice(fnIdx, fnIdx + 700);
    assert.ok(fnBlock.includes("status: 'failed'"));
  });

  it('stores clientSecret in the checkout session for re-mount on resume', () => {
    const fnIdx = src.indexOf('async function purchaseWithStripe(');
    const fnBlock = src.slice(fnIdx, fnIdx + 700);
    assert.ok(fnBlock.includes('clientSecret,'));
  });

  it('guards against starting if Stripe is not configured', () => {
    assert.ok(src.includes("if (!stripeEnabled) { alert('Stripe is not configured on this server yet.')"));
  });
});

describe('confirmStripeElement state transitions', () => {
  it('sets status to capturing before calling confirmPayment', () => {
    const fnIdx = src.indexOf('async function confirmStripeElement(');
    const fnBlock = src.slice(fnIdx, fnIdx + 200);
    assert.ok(fnBlock.includes("status: 'capturing'"));
  });

  it('sets status to success and includes credit message on success', () => {
    const fnIdx = src.indexOf('async function confirmStripeElement(');
    const fnBlock = src.slice(fnIdx, fnIdx + 1000);
    assert.ok(fnBlock.includes("status: 'success'"));
    assert.ok(fnBlock.includes('credits added. Balance:'));
  });

  it('re-mounts the element after a confirmPayment error so user can retry', () => {
    const fnIdx = src.indexOf('async function confirmStripeElement(');
    const fnBlock = src.slice(fnIdx, fnIdx + 1200);
    // After an error branch, clientSecret is preserved and mountStripeElement is called
    assert.ok(fnBlock.includes('await mountStripeElement(stripeClientSecret)'));
  });

  it('preserves clientSecret from session when confirmPayment returns an error', () => {
    const fnIdx = src.indexOf('async function confirmStripeElement(');
    const fnBlock = src.slice(fnIdx, fnIdx + 800);
    assert.ok(fnBlock.includes("readCheckoutSession()?.clientSecret || stripeClientSecret"));
  });
});

// ---------------------------------------------------------------------------
// Redirect return handling (Amazon Pay / iDEAL path)
// ---------------------------------------------------------------------------
describe('handleStripeReturn', () => {
  it('reads payment_intent from URL search params', () => {
    assert.ok(src.includes("url.searchParams.get('payment_intent')"));
  });

  it('reads redirect_status from URL search params', () => {
    assert.ok(src.includes("url.searchParams.get('redirect_status')"));
  });

  it('cleans up all three Stripe return params from the URL', () => {
    assert.ok(src.includes("url.searchParams.delete('payment_intent')"));
    assert.ok(src.includes("url.searchParams.delete('payment_intent_client_secret')"));
    assert.ok(src.includes("url.searchParams.delete('redirect_status')"));
  });

  it('calls requestConfirmStripe with the payment intent id on succeeded status', () => {
    const fnIdx = src.indexOf('async function handleStripeReturn(');
    const fnBlock = src.slice(fnIdx, fnIdx + 800);
    assert.ok(fnBlock.includes("redirectStatus === 'succeeded'"));
    assert.ok(fnBlock.includes('await requestConfirmStripe(piId)'));
  });

  it('sets status to cancelled when redirect_status is not succeeded', () => {
    const fnIdx = src.indexOf('async function handleStripeReturn(');
    const fnBlock = src.slice(fnIdx, fnIdx + 800);
    assert.ok(fnBlock.includes("status: 'cancelled'"));
    assert.ok(fnBlock.includes("'Payment was not completed.'"));
  });

  it('exits early if payment_intent param is absent', () => {
    assert.ok(src.includes('if (!piId || !redirectStatus) return'));
  });

  it('is called on page load to handle post-redirect flow', () => {
    assert.ok(src.includes('handleStripeReturn()'));
  });
});

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
describe('Stripe UI wiring', () => {
  it('has a dedicated Stripe confirm button', () => {
    assert.ok(src.includes("'payStripeConfirmBtn'"));
  });

  it('has a dedicated Stripe element container', () => {
    assert.ok(src.includes("'stripeElement'"));
    assert.ok(src.includes("'stripeElementWrap'"));
  });

  it('shows Stripe element wrap when status is awaiting_approval', () => {
    const renderIdx = src.indexOf('function renderCheckoutState(');
    const renderBlock = src.slice(renderIdx, renderIdx + 2000);
    assert.ok(renderBlock.includes("stripeWrap.style.display = ''") || renderBlock.includes("stripeWrap.style.display=''"));
  });

  it('reflects enabled/disabled state on the payment method tag', () => {
    assert.ok(src.includes("stripeEnabled ? 'enabled' : 'soon'"));
  });

  it('resets stripe instances on modal close', () => {
    assert.ok(src.includes('stripeClientSecret = null'));
    assert.ok(src.includes('stripeElements = null'));
    assert.ok(src.includes('stripeInstance = null'));
  });
});
