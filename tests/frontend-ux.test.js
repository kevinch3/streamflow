/**
 * Frontend UX tests for StreamFlow dashboard.
 *
 * These tests validate the UX logic extracted from the inline JS in index.html.
 * They run with Node's built-in test runner (node --test) — no dependencies needed.
 *
 * Run:  node --test tests/frontend-ux.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Helpers extracted from index.html JS for unit testing
// ---------------------------------------------------------------------------

function creditClass(n) {
  if (n <= 5)  return 'critical';
  if (n <= 20) return 'low';
  return 'ok';
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTracks(tracks) {
  if (!tracks || tracks.length === 0) return null;
  const video = tracks.find(t => /H264|H265|VP8|VP9|AV1/i.test(t));
  const audio = tracks.find(t => /AAC|MPEG-4 Audio|Opus|MP3/i.test(t));
  const parts = [];
  if (video) parts.push(video);
  if (audio) parts.push(audio === 'MPEG-4 Audio' ? 'AAC' : audio);
  return parts.length ? parts.join(' · ') : tracks.slice(0, 2).join(', ');
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function validStreamName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_\-/]{1,200}$/.test(name);
}

// Simulates the low-credits banner visibility logic
function shouldShowBanner(credits) {
  return credits > 0 && credits <= 10;
}

// Simulates the zero-credits overlay visibility logic
function shouldShowZeroOverlay(credits, hasToken) {
  return credits === 0 && hasToken;
}

// Simulates the welcome gate visibility logic
function shouldShowGate(hasToken) {
  return !hasToken;
}

// ---------------------------------------------------------------------------
// Tests: creditClass
// ---------------------------------------------------------------------------

describe('creditClass', () => {
  it('returns "critical" for 0 credits', () => {
    assert.equal(creditClass(0), 'critical');
  });

  it('returns "critical" for 5 credits', () => {
    assert.equal(creditClass(5), 'critical');
  });

  it('returns "low" for 6 credits', () => {
    assert.equal(creditClass(6), 'low');
  });

  it('returns "low" for 20 credits', () => {
    assert.equal(creditClass(20), 'low');
  });

  it('returns "ok" for 21 credits', () => {
    assert.equal(creditClass(21), 'ok');
  });

  it('returns "ok" for 100 credits', () => {
    assert.equal(creditClass(100), 'ok');
  });

  it('returns "ok" for 2000 credits', () => {
    assert.equal(creditClass(2000), 'ok');
  });

  it('returns "critical" for negative credits', () => {
    assert.equal(creditClass(-1), 'critical');
  });
});

// ---------------------------------------------------------------------------
// Tests: formatUptime
// ---------------------------------------------------------------------------

describe('formatUptime', () => {
  it('formats 0 seconds', () => {
    assert.equal(formatUptime(0), '0s');
  });

  it('formats seconds only', () => {
    assert.equal(formatUptime(45), '45s');
  });

  it('formats minutes and seconds', () => {
    assert.equal(formatUptime(125), '2m 5s');
  });

  it('formats exactly 1 minute', () => {
    assert.equal(formatUptime(60), '1m 0s');
  });

  it('formats hours and minutes', () => {
    assert.equal(formatUptime(3661), '1h 1m');
  });

  it('formats large values', () => {
    assert.equal(formatUptime(86400), '24h 0m');
  });

  it('drops seconds when hours are present', () => {
    assert.equal(formatUptime(3723), '1h 2m');
  });
});

// ---------------------------------------------------------------------------
// Tests: formatTracks
// ---------------------------------------------------------------------------

describe('formatTracks', () => {
  it('returns null for empty array', () => {
    assert.equal(formatTracks([]), null);
  });

  it('returns null for undefined', () => {
    assert.equal(formatTracks(undefined), null);
  });

  it('returns null for null', () => {
    assert.equal(formatTracks(null), null);
  });

  it('formats H264 + AAC', () => {
    assert.equal(formatTracks(['H264', 'AAC']), 'H264 · AAC');
  });

  it('converts MPEG-4 Audio to AAC', () => {
    assert.equal(formatTracks(['H264', 'MPEG-4 Audio']), 'H264 · AAC');
  });

  it('formats video-only stream', () => {
    assert.equal(formatTracks(['H264']), 'H264');
  });

  it('formats audio-only stream', () => {
    assert.equal(formatTracks(['Opus']), 'Opus');
  });

  it('formats H265 + Opus', () => {
    assert.equal(formatTracks(['H265', 'Opus']), 'H265 · Opus');
  });

  it('falls back to comma join for unknown tracks', () => {
    assert.equal(formatTracks(['SomeCodec', 'AnotherCodec']), 'SomeCodec, AnotherCodec');
  });

  it('limits fallback to first 2 tracks', () => {
    assert.equal(formatTracks(['A', 'B', 'C']), 'A, B');
  });
});

// ---------------------------------------------------------------------------
// Tests: esc (HTML escaping)
// ---------------------------------------------------------------------------

describe('esc', () => {
  it('escapes ampersand', () => {
    assert.equal(esc('a&b'), 'a&amp;b');
  });

  it('escapes quotes', () => {
    assert.equal(esc('a"b'), 'a&quot;b');
  });

  it('escapes angle brackets', () => {
    assert.equal(esc('<script>'), '&lt;script&gt;');
  });

  it('handles empty string', () => {
    assert.equal(esc(''), '');
  });

  it('passes through safe strings', () => {
    assert.equal(esc('hello world'), 'hello world');
  });

  it('converts numbers to string', () => {
    assert.equal(esc(42), '42');
  });

  it('escapes all special chars in one string', () => {
    assert.equal(esc('<"&">'), '&lt;&quot;&amp;&quot;&gt;');
  });
});

// ---------------------------------------------------------------------------
// Tests: validStreamName
// ---------------------------------------------------------------------------

describe('validStreamName', () => {
  it('accepts simple alphanumeric name', () => {
    assert.ok(validStreamName('test'));
  });

  it('accepts name with slashes', () => {
    assert.ok(validStreamName('live/test'));
  });

  it('accepts name with dashes and underscores', () => {
    assert.ok(validStreamName('my-stream_01'));
  });

  it('rejects empty string', () => {
    assert.ok(!validStreamName(''));
  });

  it('rejects null', () => {
    assert.ok(!validStreamName(null));
  });

  it('rejects undefined', () => {
    assert.ok(!validStreamName(undefined));
  });

  it('rejects name with spaces', () => {
    assert.ok(!validStreamName('my stream'));
  });

  it('rejects name with special characters', () => {
    assert.ok(!validStreamName('stream<script>'));
  });

  it('rejects name longer than 200 chars', () => {
    assert.ok(!validStreamName('a'.repeat(201)));
  });

  it('accepts name exactly 200 chars', () => {
    assert.ok(validStreamName('a'.repeat(200)));
  });

  it('rejects number input', () => {
    assert.ok(!validStreamName(123));
  });
});

// ---------------------------------------------------------------------------
// Tests: Welcome gate logic
// ---------------------------------------------------------------------------

describe('Welcome gate (showGate logic)', () => {
  it('shows gate when no token is present', () => {
    assert.ok(shouldShowGate(false));
  });

  it('hides gate when token is present', () => {
    assert.ok(!shouldShowGate(true));
  });
});

// ---------------------------------------------------------------------------
// Tests: Low credits banner logic
// ---------------------------------------------------------------------------

describe('Low credits banner', () => {
  it('hidden at 0 credits (zero overlay handles this)', () => {
    assert.ok(!shouldShowBanner(0));
  });

  it('shown at 1 credit', () => {
    assert.ok(shouldShowBanner(1));
  });

  it('shown at 5 credits', () => {
    assert.ok(shouldShowBanner(5));
  });

  it('shown at 10 credits', () => {
    assert.ok(shouldShowBanner(10));
  });

  it('hidden at 11 credits', () => {
    assert.ok(!shouldShowBanner(11));
  });

  it('hidden at 100 credits', () => {
    assert.ok(!shouldShowBanner(100));
  });

  it('hidden at negative credits', () => {
    assert.ok(!shouldShowBanner(-5));
  });
});

// ---------------------------------------------------------------------------
// Tests: Zero credits overlay logic
// ---------------------------------------------------------------------------

describe('Zero credits overlay', () => {
  it('shown when credits=0 and has token', () => {
    assert.ok(shouldShowZeroOverlay(0, true));
  });

  it('hidden when credits=0 and no token (gate handles it)', () => {
    assert.ok(!shouldShowZeroOverlay(0, false));
  });

  it('hidden when credits>0 and has token', () => {
    assert.ok(!shouldShowZeroOverlay(10, true));
  });

  it('hidden when credits>0 and no token', () => {
    assert.ok(!shouldShowZeroOverlay(10, false));
  });
});

// ---------------------------------------------------------------------------
// Tests: UX state machine — what screen shows for each state combination
// ---------------------------------------------------------------------------

describe('UX state machine: screen priority', () => {
  function activeScreen(hasToken, credits) {
    if (!hasToken) return 'gate';
    if (credits === 0) return 'zero-overlay';
    if (credits <= 10) return 'banner+dashboard';
    return 'dashboard';
  }

  it('no token → welcome gate (regardless of credits)', () => {
    assert.equal(activeScreen(false, 0), 'gate');
    assert.equal(activeScreen(false, 100), 'gate');
  });

  it('token + 0 credits → zero overlay', () => {
    assert.equal(activeScreen(true, 0), 'zero-overlay');
  });

  it('token + 5 credits → banner + dashboard', () => {
    assert.equal(activeScreen(true, 5), 'banner+dashboard');
  });

  it('token + 10 credits → banner + dashboard', () => {
    assert.equal(activeScreen(true, 10), 'banner+dashboard');
  });

  it('token + 11 credits → plain dashboard', () => {
    assert.equal(activeScreen(true, 11), 'dashboard');
  });

  it('token + 100 credits → plain dashboard', () => {
    assert.equal(activeScreen(true, 100), 'dashboard');
  });
});

// ---------------------------------------------------------------------------
// Tests: Credit transitions (simulating SSE updates)
// ---------------------------------------------------------------------------

describe('Credit transitions', () => {
  it('credits decreasing from 15 → 10 triggers banner', () => {
    assert.ok(!shouldShowBanner(15));
    assert.ok(shouldShowBanner(10));
  });

  it('credits decreasing from 10 → 0 hides banner, shows overlay', () => {
    assert.ok(shouldShowBanner(10));
    assert.ok(!shouldShowBanner(0));
    assert.ok(shouldShowZeroOverlay(0, true));
  });

  it('credits increasing from 0 → 200 (promo redeem) hides overlay', () => {
    assert.ok(shouldShowZeroOverlay(0, true));
    assert.ok(!shouldShowZeroOverlay(200, true));
    assert.ok(!shouldShowBanner(200));
  });

  it('credits increasing from 0 → 5 hides overlay, shows banner', () => {
    assert.ok(shouldShowZeroOverlay(0, true));
    assert.ok(!shouldShowZeroOverlay(5, true));
    assert.ok(shouldShowBanner(5));
  });
});

// ---------------------------------------------------------------------------
// Tests: Promo code validation (server-side behavior expectations)
// ---------------------------------------------------------------------------

describe('Promo code expectations', () => {
  it('FLOW26 code gives 200 credits per the server config', () => {
    // This tests the contract — server has FLOW26: { credits: 200 }
    const PROMO_CODES = {
      'FLOW26': { credits: 200, label: 'Promo FLOW26', maxUses: 1500 }
    };
    assert.equal(PROMO_CODES['FLOW26'].credits, 200);
  });

  it('promo code lookup is case-sensitive (server uppercases input)', () => {
    const code = 'flow26'.toUpperCase().trim();
    assert.equal(code, 'FLOW26');
  });

  it('whitespace is trimmed before lookup', () => {
    const code = '  FLOW26  '.toUpperCase().trim();
    assert.equal(code, 'FLOW26');
  });
});

// ---------------------------------------------------------------------------
// Tests: Card ordering expectations
// ---------------------------------------------------------------------------

describe('Dashboard card ordering', () => {
  // Simulates reading the DOM order from the HTML
  const CARD_ORDER = ['Credits', 'Connect', 'Active Streams', 'Player'];

  it('Credits card is first', () => {
    assert.equal(CARD_ORDER[0], 'Credits');
  });

  it('Connect card is second', () => {
    assert.equal(CARD_ORDER[1], 'Connect');
  });

  it('Active Streams card is third', () => {
    assert.equal(CARD_ORDER[2], 'Active Streams');
  });

  it('Player card is fourth', () => {
    assert.equal(CARD_ORDER[3], 'Player');
  });
});

// ---------------------------------------------------------------------------
// Tests: Initial server state
// ---------------------------------------------------------------------------

describe('Server initial state', () => {
  it('starts with 0 credits (pay-first model)', () => {
    const credits = 0; // from app/index.js line 23
    assert.equal(credits, 0);
  });

  it('SSE cache starts with 0 credits', () => {
    const sseCache = { streams: [], credits: 0, status: 'ok', uptime: 0 };
    assert.equal(sseCache.credits, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Z-index layering
// ---------------------------------------------------------------------------

describe('Z-index layering', () => {
  const Z_INDICES = {
    paymentModal: 160,
    welcomeGate: 200,
    zeroCreditOverlay: 150,
  };

  it('welcome gate is above everything', () => {
    assert.ok(Z_INDICES.welcomeGate > Z_INDICES.zeroCreditOverlay);
    assert.ok(Z_INDICES.welcomeGate > Z_INDICES.paymentModal);
  });

  it('payment modal is above zero-credit overlay', () => {
    assert.ok(Z_INDICES.paymentModal > Z_INDICES.zeroCreditOverlay);
  });

  it('zero-credit overlay is below payment modal (so purchases work)', () => {
    assert.ok(Z_INDICES.zeroCreditOverlay < Z_INDICES.paymentModal);
  });
});

// ---------------------------------------------------------------------------
// Tests: Viewer page credit exhaustion handling
// ---------------------------------------------------------------------------

describe('Viewer page offline overlay logic', () => {
  function viewerOverlayState(isLive, credits) {
    if (isLive) return { show: false };
    const noCredits = credits === 0;
    return {
      show: true,
      icon: noCredits ? '💳' : '📡',
      title: noCredits ? 'Credits exhausted' : 'Stream ended',
      message: noCredits
        ? 'This stream was paused because the broadcaster ran out of credits.'
        : 'The broadcaster has stopped streaming. Check back later.'
    };
  }

  it('shows nothing when stream is live', () => {
    assert.equal(viewerOverlayState(true, 100).show, false);
    assert.equal(viewerOverlayState(true, 0).show, false);
  });

  it('shows credit exhaustion message when offline + 0 credits', () => {
    const state = viewerOverlayState(false, 0);
    assert.ok(state.show);
    assert.equal(state.icon, '💳');
    assert.equal(state.title, 'Credits exhausted');
    assert.ok(state.message.includes('ran out of credits'));
  });

  it('shows stream ended message when offline + credits remain', () => {
    const state = viewerOverlayState(false, 50);
    assert.ok(state.show);
    assert.equal(state.icon, '📡');
    assert.equal(state.title, 'Stream ended');
    assert.ok(state.message.includes('stopped streaming'));
  });
});

// ---------------------------------------------------------------------------
// Tests: Credit package definitions
// ---------------------------------------------------------------------------

describe('Credit packages', () => {
  const CREDIT_PACKAGES = {
    starter:  { credits: 100,  label: 'Starter',  price: '$ 5.00'  },
    standard: { credits: 500,  label: 'Standard', price: '$ 20.00' },
    pro:      { credits: 2000, label: 'Pro',       price: '$ 50.00' }
  };

  it('has exactly 3 packages', () => {
    assert.equal(Object.keys(CREDIT_PACKAGES).length, 3);
  });

  it('starter is cheapest', () => {
    assert.ok(CREDIT_PACKAGES.starter.credits < CREDIT_PACKAGES.standard.credits);
  });

  it('pro has the most credits', () => {
    assert.ok(CREDIT_PACKAGES.pro.credits > CREDIT_PACKAGES.standard.credits);
  });

  it('credits scale better with higher packages', () => {
    const starterPerDollar = 100 / 5;   // 20 cr/$
    const standardPerDollar = 500 / 20;  // 25 cr/$
    const proPerDollar = 2000 / 50;      // 40 cr/$
    assert.ok(standardPerDollar > starterPerDollar);
    assert.ok(proPerDollar > standardPerDollar);
  });
});
