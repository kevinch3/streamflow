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
let viewerHtml = '';
let liveHtml = '';
let serverJs = '';
let mediamtxYml = '';

before(() => {
  const root = path.resolve(__dirname, '..');
  indexHtml = fs.readFileSync(path.join(root, 'html', 'index.html'), 'utf8');
  viewerHtml = fs.readFileSync(path.join(root, 'html', 'viewer.html'), 'utf8');
  liveHtml = fs.readFileSync(path.join(root, 'html', 'live.html'), 'utf8');
  serverJs = fs.readFileSync(path.join(root, 'app', 'index.js'), 'utf8');
  mediamtxYml = fs.readFileSync(path.join(root, 'mediamtx.yml'), 'utf8');
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
});

describe('Public active streams page', () => {
  it('has dedicated live.html file', () => {
    assert.ok(liveHtml.includes('<title>StreamFlow — Live Streams</title>'));
  });

  it('subscribes to public SSE endpoint', () => {
    assert.ok(liveHtml.includes("new EventSource('/api/events/public')"));
  });

  it('shows viewer and HLS actions without disconnect controls', () => {
    assert.ok(liveHtml.includes('Open Viewer'));
    assert.ok(liveHtml.includes('Open HLS'));
    assert.ok(!liveHtml.includes('Disconnect'));
  });
});

describe('Strict stream path validation', () => {
  it('viewer validates strict session path format', () => {
    assert.ok(viewerHtml.includes('/^s\\/[a-f0-9]{16}\\/[A-Za-z0-9_-]{3,64}$/'));
  });

  it('server defines strict stream key and stream path validators', () => {
    assert.ok(serverJs.includes('function validStreamKey(key)'));
    assert.ok(serverJs.includes('/^[A-Za-z0-9_-]{3,64}$/'));
    assert.ok(serverJs.includes('function validSessionStreamPath(name)'));
    assert.ok(serverJs.includes('/^s\\/[a-f0-9]{16}\\/[A-Za-z0-9_-]{3,64}$/'));
  });
});

describe('Backend publish security endpoints', () => {
  it('exposes publish prepare endpoint', () => {
    assert.ok(serverJs.includes("app.post('/api/publish/prepare'"));
  });

  it('exposes internal mediamtx auth callback', () => {
    assert.ok(serverJs.includes("app.post('/api/internal/mediamtx/auth'"));
  });

  it('exposes public SSE endpoint', () => {
    assert.ok(serverJs.includes("app.get('/api/events/public'"));
  });

  it('enforces strict validation on viewer/live and disconnect endpoints', () => {
    assert.ok(serverJs.includes("app.get('/api/events/live/:name'"));
    assert.ok(serverJs.includes("app.get('/api/streams/:name/live'"));
    assert.ok(serverJs.includes("app.delete('/api/streams/:name'"));
    assert.ok(serverJs.includes('validSessionStreamPath(streamName)'));
  });

  it('applies quality classification thresholds', () => {
    assert.ok(serverJs.includes('if (bitrateKbps >= 4500) return \'excellent\''));
    assert.ok(serverJs.includes('if (bitrateKbps >= 2500) return \'good\''));
    assert.ok(serverJs.includes('if (bitrateKbps >= 1000) return \'fair\''));
    assert.ok(serverJs.includes("return 'poor'"));
  });
});

describe('MediaMTX config wiring', () => {
  it('uses HTTP auth callback in mediamtx.yml', () => {
    assert.ok(mediamtxYml.includes('authMethod: http'));
    assert.ok(mediamtxYml.includes('authHTTPAddress: http://app:80/api/internal/mediamtx/auth?secret=${MEDIAMTX_AUTH_SECRET}'));
  });

  it('excludes non-publish actions from HTTP auth', () => {
    assert.ok(mediamtxYml.includes('authHTTPExclude:'));
    assert.ok(mediamtxYml.includes('- action: api'));
    assert.ok(mediamtxYml.includes('- action: read'));
    assert.ok(mediamtxYml.includes('- action: playback'));
  });
});
