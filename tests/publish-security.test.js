/**
 * Security contract tests for signed publish tokens and strict ingest authorization logic.
 *
 * Run: node --test tests/publish-security.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, timingSafeEqual } = require('node:crypto');

const SECRET = 'test-secret';

function validStreamKey(key) {
  return /^[A-Za-z0-9_-]{3,64}$/.test(key);
}

function validSessionStreamPath(path) {
  return /^s\/[a-f0-9]{16}\/[A-Za-z0-9_-]{3,64}$/.test(path);
}

function safeEqualString(a, b) {
  const lhs = Buffer.from(String(a));
  const rhs = Buffer.from(String(b));
  if (lhs.length !== rhs.length) return false;
  return timingSafeEqual(lhs, rhs);
}

function signPayload(payloadB64) {
  return createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
}

function issueToken(payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadB64}.${signPayload(payloadB64)}`;
}

function verifyToken(token) {
  const [payloadB64, sig] = String(token || '').split('.');
  if (!payloadB64 || !sig) return { ok: false };
  const expected = signPayload(payloadB64);
  if (!safeEqualString(expected, sig)) return { ok: false };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }

  if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) return { ok: false };
  if (!validStreamKey(payload.key)) return { ok: false };
  return { ok: true, payload };
}

function authorizePublish({ streamPath, token, session }) {
  if (!validSessionStreamPath(streamPath)) return false;
  const verified = verifyToken(token);
  if (!verified.ok) return false;
  if (!session || session.credits <= 0) return false;

  const expectedPath = `${session.prefix}${verified.payload.key}`;
  return (
    streamPath === expectedPath &&
    verified.payload.sid === session.id &&
    verified.payload.pfx === session.prefix
  );
}

describe('Signed publish token', () => {
  it('verifies a valid token', () => {
    const tok = issueToken({ sid: '0123456789abcdef', pfx: 's/0123456789abcdef/', key: 'stream_1', bid: 'b_test', exp: Date.now() + 60_000 });
    assert.equal(verifyToken(tok).ok, true);
  });

  it('fails when token payload is tampered', () => {
    const tok = issueToken({ sid: '0123456789abcdef', pfx: 's/0123456789abcdef/', key: 'stream_1', bid: 'b_test', exp: Date.now() + 60_000 });
    const [payload, sig] = tok.split('.');
    const tampered = `${payload.slice(0, -1)}A.${sig}`;
    assert.equal(verifyToken(tampered).ok, false);
  });

  it('fails when token is expired', () => {
    const tok = issueToken({ sid: '0123456789abcdef', pfx: 's/0123456789abcdef/', key: 'stream_1', bid: '', exp: Date.now() - 1 });
    assert.equal(verifyToken(tok).ok, false);
  });
});

describe('Internal publish authorization logic', () => {
  const session = {
    id: '0123456789abcdef',
    prefix: 's/0123456789abcdef/',
    credits: 10,
  };

  it('authorizes valid stream path + token + session', () => {
    const token = issueToken({ sid: session.id, pfx: session.prefix, key: 'stream_1', bid: '', exp: Date.now() + 60_000 });
    assert.equal(authorizePublish({ streamPath: 's/0123456789abcdef/stream_1', token, session }), true);
  });

  it('rejects invalid stream path shape', () => {
    const token = issueToken({ sid: session.id, pfx: session.prefix, key: 'stream_1', bid: '', exp: Date.now() + 60_000 });
    assert.equal(authorizePublish({ streamPath: 'live/stream_1', token, session }), false);
  });

  it('rejects path/token mismatch', () => {
    const token = issueToken({ sid: session.id, pfx: session.prefix, key: 'stream_1', bid: '', exp: Date.now() + 60_000 });
    assert.equal(authorizePublish({ streamPath: 's/0123456789abcdef/other', token, session }), false);
  });

  it('rejects zero-credit session', () => {
    const token = issueToken({ sid: session.id, pfx: session.prefix, key: 'stream_1', bid: '', exp: Date.now() + 60_000 });
    assert.equal(authorizePublish({ streamPath: 's/0123456789abcdef/stream_1', token, session: { ...session, credits: 0 } }), false);
  });
});
