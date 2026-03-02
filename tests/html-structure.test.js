/**
 * HTML structure tests for StreamFlow dashboard.
 *
 * Reads the actual HTML files and validates structural expectations
 * for the UX improvements (gate, banner, overlay, card order, z-index).
 *
 * Run:  node --test tests/html-structure.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let indexHtml = '';
let viewerHtml = '';
let serverJs = '';

before(() => {
  const root = path.resolve(__dirname, '..');
  indexHtml = fs.readFileSync(path.join(root, 'html', 'index.html'), 'utf8');
  viewerHtml = fs.readFileSync(path.join(root, 'html', 'viewer.html'), 'utf8');
  serverJs = fs.readFileSync(path.join(root, 'app', 'index.js'), 'utf8');
});

// ---------------------------------------------------------------------------
// Welcome gate
// ---------------------------------------------------------------------------

describe('Welcome gate HTML', () => {
  it('exists in index.html', () => {
    assert.ok(indexHtml.includes('id="welcomeGate"'));
  });

  it('has a promo code input', () => {
    assert.ok(indexHtml.includes('id="gatePromoInput"'));
  });

  it('has a redeem button calling gateRedeem()', () => {
    assert.ok(indexHtml.includes('gateRedeem()'));
  });

  it('has a status display element', () => {
    assert.ok(indexHtml.includes('id="gatePromoStatus"'));
  });

  it('starts hidden (display:none)', () => {
    assert.ok(indexHtml.includes('id="welcomeGate" style="display:none"'));
  });

  it('shows credit package preview cards', () => {
    assert.ok(indexHtml.includes('gate-pkg-grid'));
    assert.ok(indexHtml.includes('Credit packages available after activation'));
  });

  it('has Enter key support on input', () => {
    assert.ok(indexHtml.includes('onkeydown="if(event.key===\'Enter\')gateRedeem()"'));
  });
});

// ---------------------------------------------------------------------------
// Low credits banner
// ---------------------------------------------------------------------------

describe('Low credits banner HTML', () => {
  it('exists in index.html', () => {
    assert.ok(indexHtml.includes('id="lowCreditsBanner"'));
  });

  it('has a credits count element', () => {
    assert.ok(indexHtml.includes('id="lowCreditsCount"'));
  });

  it('has an "Add more" button', () => {
    assert.ok(indexHtml.includes('Add more'));
  });

  it('is placed between header and main', () => {
    const headerEnd = indexHtml.indexOf('</header>');
    const bannerStart = indexHtml.indexOf('id="lowCreditsBanner"');
    const mainStart = indexHtml.indexOf('<main>');
    assert.ok(headerEnd < bannerStart);
    assert.ok(bannerStart < mainStart);
  });
});

// ---------------------------------------------------------------------------
// Zero credits overlay
// ---------------------------------------------------------------------------

describe('Zero credits overlay HTML', () => {
  it('exists in index.html', () => {
    assert.ok(indexHtml.includes('id="zeroCreditOverlay"'));
  });

  it('has a promo code input', () => {
    assert.ok(indexHtml.includes('id="zeroPromoInput"'));
  });

  it('has a redeem button calling zeroRedeemPromo()', () => {
    assert.ok(indexHtml.includes('zeroRedeemPromo()'));
  });

  it('has credit package cards for purchasing', () => {
    // The overlay should have all 3 package options
    const overlayStart = indexHtml.indexOf('id="zeroCreditOverlay"');
    const overlaySection = indexHtml.slice(overlayStart, overlayStart + 2000);
    assert.ok(overlaySection.includes('Starter'));
    assert.ok(overlaySection.includes('Standard'));
    assert.ok(overlaySection.includes('Pro'));
  });

  it('shows "Credits Exhausted" title', () => {
    assert.ok(indexHtml.includes('Credits Exhausted'));
  });

  it('has Enter key support on promo input', () => {
    assert.ok(indexHtml.includes('onkeydown="if(event.key===\'Enter\')zeroRedeemPromo()"'));
  });
});

// ---------------------------------------------------------------------------
// Card ordering
// ---------------------------------------------------------------------------

describe('Dashboard card ordering', () => {
  it('Credits card appears before Connect card', () => {
    const creditsPos = indexHtml.indexOf('id="creditsCard"');
    const connectPos = indexHtml.indexOf('<h2>Connect</h2>');
    assert.ok(creditsPos > 0, 'Credits card should exist');
    assert.ok(connectPos > 0, 'Connect card should exist');
    assert.ok(creditsPos < connectPos, 'Credits must come before Connect');
  });

  it('Connect card appears before Active Streams card', () => {
    const connectPos = indexHtml.indexOf('<h2>Connect</h2>');
    const streamsPos = indexHtml.indexOf('<h2>Active Streams</h2>');
    assert.ok(connectPos < streamsPos, 'Connect must come before Active Streams');
  });

  it('Active Streams card appears before Player card', () => {
    const streamsPos = indexHtml.indexOf('<h2>Active Streams</h2>');
    const playerPos = indexHtml.indexOf('id="playerCard"');
    assert.ok(streamsPos < playerPos, 'Active Streams must come before Player');
  });

  it('Credits card is the first card inside main', () => {
    const mainStart = indexHtml.indexOf('<main>');
    const creditsCard = indexHtml.indexOf('id="creditsCard"', mainStart);
    const connectCard = indexHtml.indexOf('<h2>Connect</h2>', mainStart);
    // Credits card should appear before any other card
    assert.ok(creditsCard > mainStart, 'Credits card should be inside main');
    assert.ok(creditsCard < connectCard, 'Credits card should be the first card');
  });
});

// ---------------------------------------------------------------------------
// Z-index layering (CSS)
// ---------------------------------------------------------------------------

describe('Z-index layering in CSS', () => {
  it('welcome gate has z-index: 200', () => {
    assert.ok(indexHtml.includes('#welcomeGate'));
    // Check the CSS rule
    const gateCSS = indexHtml.match(/#welcomeGate\s*\{[^}]*z-index:\s*(\d+)/);
    assert.ok(gateCSS, 'Should have z-index in welcomeGate CSS');
    assert.equal(gateCSS[1], '200');
  });

  it('zero credits overlay has z-index: 150', () => {
    const overlayCSS = indexHtml.match(/#zeroCreditOverlay\s*\{[^}]*z-index:\s*(\d+)/);
    assert.ok(overlayCSS, 'Should have z-index in zeroCreditOverlay CSS');
    assert.equal(overlayCSS[1], '150');
  });

  it('payment modal has z-index: 160 (above zero overlay)', () => {
    const modalCSS = indexHtml.match(/\.pay-modal-bg\s*\{[^}]*z-index:\s*(\d+)/);
    assert.ok(modalCSS, 'Should have z-index in pay-modal-bg CSS');
    assert.equal(modalCSS[1], '160');
  });
});

// ---------------------------------------------------------------------------
// JavaScript functions
// ---------------------------------------------------------------------------

describe('JavaScript functions exist', () => {
  it('showGate function is defined', () => {
    assert.ok(indexHtml.includes('function showGate()'));
  });

  it('hideGate function is defined', () => {
    assert.ok(indexHtml.includes('function hideGate()'));
  });

  it('gateRedeem function is defined', () => {
    assert.ok(indexHtml.includes('async function gateRedeem()'));
  });

  it('updateZeroOverlay function is defined', () => {
    assert.ok(indexHtml.includes('function updateZeroOverlay('));
  });

  it('zeroRedeemPromo function is defined', () => {
    assert.ok(indexHtml.includes('async function zeroRedeemPromo()'));
  });

  it('updateCredits calls updateZeroOverlay', () => {
    assert.ok(indexHtml.includes('updateZeroOverlay(n)'));
  });

  it('updateCredits handles low credits banner', () => {
    assert.ok(indexHtml.includes("getElementById('lowCreditsBanner')"));
    assert.ok(indexHtml.includes("getElementById('lowCreditsCount')"));
  });
});

// ---------------------------------------------------------------------------
// Init logic
// ---------------------------------------------------------------------------

describe('Init logic', () => {
  it('checks for token before deciding gate vs SSE', () => {
    assert.ok(indexHtml.includes('if (getToken())'));
    assert.ok(indexHtml.includes('showGate()'));
  });

  it('connectSSE shows gate on auth failure', () => {
    // When SSE fails and never connected, should show gate
    assert.ok(indexHtml.includes("localStorage.removeItem('sf_token')"));
    // The onerror handler should call showGate
    const sseSection = indexHtml.slice(
      indexHtml.indexOf('function connectSSE()'),
      indexHtml.indexOf('function connectSSE()') + 1500
    );
    assert.ok(sseSection.includes('showGate()'));
  });
});

// ---------------------------------------------------------------------------
// Server initial credits
// ---------------------------------------------------------------------------

describe('Server initial credits', () => {
  it('credits starts at 0', () => {
    assert.ok(serverJs.includes('let credits = 0;'));
    assert.ok(!serverJs.includes('let credits = 100;'));
  });

  it('sseCache starts with credits: 0', () => {
    assert.ok(serverJs.includes('credits: 0, status:'));
  });
});

// ---------------------------------------------------------------------------
// Server disconnect routing
// ---------------------------------------------------------------------------

describe('Server disconnect routing', () => {
  it('has kickUrl helper function', () => {
    assert.ok(serverJs.includes('function kickUrl(conn)'));
  });

  it('kickUrl routes WebRTC to webrtcsessions/kick', () => {
    assert.ok(serverJs.includes('/v3/webrtcsessions/kick/'));
  });

  it('kickUrl routes RTMP to rtmpconns/kick', () => {
    assert.ok(serverJs.includes('/v3/rtmpconns/kick/'));
  });

  it('DELETE endpoint uses kickUrl (not hardcoded rtmpconns)', () => {
    // Find the DELETE handler
    const start = serverJs.indexOf("app.delete('/api/streams/:name'");
    assert.ok(start > 0, 'DELETE endpoint should exist');
    const deleteHandler = serverJs.slice(start, start + 500);
    assert.ok(deleteHandler.includes('kickUrl(conn)'),
      `DELETE /api/streams/:name should use kickUrl(conn). Got: ${deleteHandler.slice(0, 200)}`);
  });

  it('kickAllStreams uses kickUrl', () => {
    const kickAll = serverJs.slice(
      serverJs.indexOf('async function kickAllStreams()'),
      serverJs.indexOf('async function kickAllStreams()') + 300
    );
    assert.ok(kickAll.includes('kickUrl(c)'),
      'kickAllStreams should use kickUrl helper');
  });

  it('WebRTC publishers are tagged with _type: webrtc', () => {
    assert.ok(serverJs.includes("_type: 'webrtc'"));
  });
});

// ---------------------------------------------------------------------------
// Viewer page (unchanged, but validate existing behavior)
// ---------------------------------------------------------------------------

describe('Viewer page structure', () => {
  it('has offline overlay', () => {
    assert.ok(viewerHtml.includes('id="offlineOverlay"'));
  });

  it('handles credits exhaustion in overlay', () => {
    assert.ok(viewerHtml.includes('Credits exhausted'));
    assert.ok(viewerHtml.includes('ran out of credits'));
  });

  it('handles normal stream end in overlay', () => {
    assert.ok(viewerHtml.includes('Stream ended'));
    assert.ok(viewerHtml.includes('stopped streaming'));
  });

  it('validates stream name', () => {
    assert.ok(viewerHtml.includes('/^[a-zA-Z0-9_\\-/]{1,200}$/'));
  });
});

// ---------------------------------------------------------------------------
// Security checks
// ---------------------------------------------------------------------------

describe('Security', () => {
  it('promo redeem endpoint uses POST method in gate', () => {
    const gateSection = indexHtml.slice(
      indexHtml.indexOf('function gateRedeem()'),
      indexHtml.indexOf('function gateRedeem()') + 800
    );
    assert.ok(gateSection.includes("method: 'POST'"));
  });

  it('promo redeem sends Content-Type: application/json', () => {
    const gateSection = indexHtml.slice(
      indexHtml.indexOf('function gateRedeem()'),
      indexHtml.indexOf('function gateRedeem()') + 800
    );
    assert.ok(gateSection.includes("'Content-Type': 'application/json'"));
  });

  it('gate stores token in localStorage after successful redeem', () => {
    const gateSection = indexHtml.slice(
      indexHtml.indexOf('function gateRedeem()'),
      indexHtml.indexOf('function gateRedeem()') + 800
    );
    assert.ok(gateSection.includes("localStorage.setItem('sf_token'"));
  });

  it('SSE auth failure clears stale token', () => {
    assert.ok(indexHtml.includes("localStorage.removeItem('sf_token')"));
  });
});

// ---------------------------------------------------------------------------
// Stream lifecycle cohesion
// ---------------------------------------------------------------------------

describe('Stream lifecycle cohesion', () => {
  it('declares watchingStream variable', () => {
    assert.ok(indexHtml.includes('let watchingStream = null'));
  });

  it('watchStream sets watchingStream', () => {
    const fn = indexHtml.slice(
      indexHtml.indexOf('function watchStream('),
      indexHtml.indexOf('function watchStream(') + 300
    );
    assert.ok(fn.includes('watchingStream = name'), 'watchStream should set watchingStream');
  });

  it('closePlayer clears watchingStream', () => {
    const fn = indexHtml.slice(
      indexHtml.indexOf('function closePlayer()'),
      indexHtml.indexOf('function closePlayer()') + 300
    );
    assert.ok(fn.includes('watchingStream = null'), 'closePlayer should clear watchingStream');
  });

  it('SSE onmessage auto-closes player when watched stream disappears', () => {
    const handler = indexHtml.slice(
      indexHtml.indexOf('sseConn.onmessage'),
      indexHtml.indexOf('sseConn.onerror')
    );
    assert.ok(handler.includes('activeNames'), 'should build set of active stream names');
    assert.ok(handler.includes('watchingStream') && handler.includes('closePlayer()'),
      'should auto-close player when watched stream is gone');
  });

  it('SSE onmessage auto-resets test stream UI when externally disconnected', () => {
    const handler = indexHtml.slice(
      indexHtml.indexOf('sseConn.onmessage'),
      indexHtml.indexOf('sseConn.onerror')
    );
    assert.ok(handler.includes('testPC') && handler.includes('cleanupTestStream()'),
      'should cleanup test stream when its path disappears');
    assert.ok(handler.includes('updateTestStreamUI(false)'),
      'should reset test stream button');
  });

  it('disconnectStream immediately cleans up player and test stream on success', () => {
    const fn = indexHtml.slice(
      indexHtml.indexOf('function disconnectStream('),
      indexHtml.indexOf('function disconnectStream(') + 800
    );
    assert.ok(fn.includes('watchingStream === name') && fn.includes('closePlayer()'),
      'should close player if disconnecting the watched stream');
    assert.ok(fn.includes('cleanupTestStream()') && fn.includes('updateTestStreamUI(false)'),
      'should reset test stream UI if disconnecting the test stream');
  });

  it('disconnectStream returns early on error (does not clean up)', () => {
    const fn = indexHtml.slice(
      indexHtml.indexOf('function disconnectStream('),
      indexHtml.indexOf('function disconnectStream(') + 800
    );
    // The error branch should return before the cleanup code
    const alertIdx = fn.indexOf("alert(d.error");
    const returnIdx = fn.indexOf('return;');
    const cleanupIdx = fn.indexOf('closePlayer()');
    assert.ok(returnIdx > 0 && returnIdx < cleanupIdx,
      'should return after alert, before cleanup');
  });
});
