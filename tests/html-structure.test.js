/**
 * Structural checks for StreamFlow dashboard/viewer/public pages and server wiring.
 *
 * Run: node --test tests/html-structure.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let indexHtml = '';
let viewerJs = '';
let liveHtml = '';
let liveJs = '';
let configJs = '';
let streamsJs = '';
let adminRoutesJs = '';
let publicRoutesJs = '';
let eventsRoutesJs = '';
let internalRoutesJs = '';
let mediamtxYml = '';
let composeYml = '';
let dashboardJs = '';

before(() => {
  const root = path.resolve(__dirname, '..');
  indexHtml = fs.readFileSync(path.join(root, 'html', 'index.html'), 'utf8');
  viewerJs = fs.readFileSync(path.join(root, 'html', 'js', 'viewer.js'), 'utf8');
  liveHtml = fs.readFileSync(path.join(root, 'html', 'live.html'), 'utf8');
  liveJs = fs.readFileSync(path.join(root, 'html', 'js', 'live.js'), 'utf8');
  dashboardJs = fs.readFileSync(path.join(root, 'html', 'js', 'dashboard.js'), 'utf8');

  configJs = fs.readFileSync(path.join(root, 'app', 'config.js'), 'utf8');
  streamsJs = fs.readFileSync(path.join(root, 'app', 'streams.js'), 'utf8');
  adminRoutesJs = fs.readFileSync(path.join(root, 'app', 'routes', 'admin.js'), 'utf8');
  publicRoutesJs = fs.readFileSync(path.join(root, 'app', 'routes', 'public.js'), 'utf8');
  eventsRoutesJs = fs.readFileSync(path.join(root, 'app', 'routes', 'events.js'), 'utf8');
  internalRoutesJs = fs.readFileSync(path.join(root, 'app', 'routes', 'internal.js'), 'utf8');

  mediamtxYml = fs.readFileSync(path.join(root, 'mediamtx.yml'), 'utf8');
  composeYml = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
});

describe('Connect diagnostics UI', () => {
  it('contains secure OBS stream key field', () => {
    assert.ok(indexHtml.includes('id="obsStreamKey"'));
  });

  it('contains diagnostics chips for path/discovery/quality', () => {
    assert.ok(indexHtml.includes('id="diagPath"'));
    assert.ok(indexHtml.includes('id="diagDiscovery"'));
    assert.ok(indexHtml.includes('id="diagQuality"'));
  });

  it('contains connect feedback message area', () => {
    assert.ok(indexHtml.includes('id="connectFeedbackMsg"'));
  });

  it('contains quick actions including refresh and public page link', () => {
    assert.ok(indexHtml.includes('id="refreshSecureBtn"'));
    assert.ok(indexHtml.includes('href="/live.html"'));
  });

  it('contains sticky payment recovery elements', () => {
    assert.ok(indexHtml.includes('id="paymentResumeBanner"'));
    assert.ok(indexHtml.includes('id="paypalButtonsWrap"'));
    assert.ok(indexHtml.includes('id="payStatusMsg"'));
  });
});

describe('Public active streams page', () => {
  it('has dedicated live.html file', () => {
    assert.ok(liveHtml.includes('<title>StreamFlow — Live Streams</title>'));
  });

  it('subscribes to public SSE endpoint', () => {
    assert.ok(liveJs.includes("new EventSource('/api/events/public')"));
  });

  it('shows viewer action without disconnect controls', () => {
    assert.ok(liveJs.includes('Watch'));
    assert.ok(!liveJs.includes('Disconnect'));
  });
});

describe('Strict stream path validation', () => {
  it('viewer reads stream from URL and subscribes to stream-scoped SSE', () => {
    assert.ok(viewerJs.includes("new URLSearchParams(window.location.search).get('stream')"));
    assert.ok(viewerJs.includes('new EventSource(`/api/events/live/${encodeURIComponent(streamName)}`)'));
  });

  it('server defines strict stream key and stream path validators', () => {
    assert.ok(configJs.includes('function validStreamKey(key)'));
    assert.ok(configJs.includes('/^[A-Za-z0-9_-]{3,64}$/'));
    assert.ok(configJs.includes('function validSessionStreamPath(name)'));
    assert.ok(configJs.includes('/^s\\/[a-f0-9]{16}\\/[A-Za-z0-9_-]{3,64}$/'));
  });
});

describe('Backend publish security endpoints', () => {
  it('exposes publish prepare endpoint', () => {
    assert.ok(adminRoutesJs.includes("router.post('/publish/prepare'"));
  });

  it('exposes internal mediamtx auth callback', () => {
    assert.ok(internalRoutesJs.includes("router.post('/internal/mediamtx/auth'"));
  });

  it('exposes public SSE endpoint', () => {
    assert.ok(eventsRoutesJs.includes("router.get('/events/public'"));
  });

  it('exposes PayPal public config endpoint', () => {
    assert.ok(publicRoutesJs.includes("router.get('/payments/paypal/config'"));
  });

  it('enforces strict validation on live/read/disconnect endpoints', () => {
    assert.ok(eventsRoutesJs.includes("router.get('/events/live/:name'"));
    assert.ok(publicRoutesJs.includes("router.get('/streams/:name/live'"));
    assert.ok(adminRoutesJs.includes("router.delete('/streams/:name'"));
    assert.ok(adminRoutesJs.includes('validSessionStreamPath(streamName)'));
    assert.ok(publicRoutesJs.includes('validSessionStreamPath(streamName)'));
  });

  it('applies quality classification thresholds', () => {
    assert.ok(streamsJs.includes("if (bitrateKbps >= 4500) return 'excellent'"));
    assert.ok(streamsJs.includes("if (bitrateKbps >= 2500) return 'good'"));
    assert.ok(streamsJs.includes("if (bitrateKbps >= 1000) return 'fair'"));
    assert.ok(streamsJs.includes("return 'poor'"));
  });
});

describe('Sticky checkout state wiring', () => {
  it('stores checkout progress in localStorage with a fixed key', () => {
    assert.ok(dashboardJs.includes("CHECKOUT_STORAGE_KEY = 'sf_paypal_checkout_v1'"));
  });

  it('handles PayPal return params and explicit modal close', () => {
    assert.ok(dashboardJs.includes('function handlePaypalReturn()'));
    assert.ok(dashboardJs.includes('function requestClosePayModal()'));
    assert.ok(dashboardJs.includes('function resumePaymentModal()'));
  });
});

describe('MediaMTX config wiring', () => {
  it('uses HTTP auth callback wiring for publish auth', () => {
    assert.ok(mediamtxYml.includes('authMethod: http'));
    assert.ok(mediamtxYml.includes('authHTTPExclude:'));
    assert.ok(composeYml.includes('MTX_AUTHHTTPADDRESS=http://app:80/api/internal/mediamtx/auth?secret=${MEDIAMTX_AUTH_SECRET:-streamflow-dev-mediamtx-auth-secret}'));
  });

  it('excludes non-publish actions from HTTP auth', () => {
    assert.ok(mediamtxYml.includes('- action: api'));
    assert.ok(mediamtxYml.includes('- action: read'));
    assert.ok(mediamtxYml.includes('- action: playback'));
  });
});
