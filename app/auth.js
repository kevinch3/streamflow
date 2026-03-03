const { createHmac, randomBytes, timingSafeEqual } = require('crypto');
const {
  PUBLISH_TOKEN_SECRET,
  PUBLISH_TOKEN_TTL_MS,
  validBrowserId,
  validSessionStreamPath,
  validStreamKey,
  normalizePath,
} = require('./config');
const { sessions } = require('./sessions');

function generateToken() {
  return 'sf_' + randomBytes(21).toString('base64url');
}

const superToken = process.env.STREAM_API_TOKEN || generateToken();
if (!process.env.STREAM_API_TOKEN) {
  console.warn('[token] STREAM_API_TOKEN not set — generated ephemeral super token:', superToken);
}

function safeEqualString(a, b) {
  const lhs = Buffer.from(String(a));
  const rhs = Buffer.from(String(b));
  if (lhs.length !== rhs.length) return false;
  return timingSafeEqual(lhs, rhs);
}

function signPublishTokenPayload(payloadB64) {
  return createHmac('sha256', PUBLISH_TOKEN_SECRET).update(payloadB64).digest('base64url');
}

function createPublishToken({ session, streamKey, browserId }) {
  const payload = {
    sid: session.id,
    pfx: session.prefix,
    key: streamKey,
    bid: browserId,
    exp: Date.now() + PUBLISH_TOKEN_TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = signPublishTokenPayload(payloadB64);
  return { token: `${payloadB64}.${sig}`, payload };
}

function verifyPublishToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, reason: 'Malformed token' };
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: 'Malformed token' };
  }

  const [payloadB64, sig] = parts;
  const expectedSig = signPublishTokenPayload(payloadB64);
  if (!safeEqualString(sig, expectedSig)) {
    return { ok: false, reason: 'Invalid signature' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'Invalid payload' };
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'Invalid payload' };
  }

  if (typeof payload.sid !== 'string' || typeof payload.pfx !== 'string' || typeof payload.key !== 'string') {
    return { ok: false, reason: 'Invalid payload claims' };
  }

  if (typeof payload.bid !== 'string') {
    return { ok: false, reason: 'Invalid browser claim' };
  }

  if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) {
    return { ok: false, reason: 'Token expired' };
  }

  if (!validStreamKey(payload.key)) {
    return { ok: false, reason: 'Invalid key claim' };
  }

  if (!validBrowserId(payload.bid)) {
    return { ok: false, reason: 'Invalid browser claim' };
  }

  if (!payload.pfx.endsWith('/')) {
    return { ok: false, reason: 'Invalid prefix claim' };
  }

  return { ok: true, payload };
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const tok = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!tok) return res.status(401).json({ error: 'Unauthorized' });

  if (tok === superToken) {
    req.isSuperAdmin = true;
    req.userSession = null;
    return next();
  }

  const session = sessions.get(tok);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  req.isSuperAdmin = false;
  req.userSession = session;
  next();
}

function parseMediaMtxAuthPayload(rawBody) {
  if (rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)) {
    return rawBody;
  }

  if (typeof rawBody === 'string' && rawBody.trim()) {
    try {
      return JSON.parse(rawBody);
    } catch {
      const parsed = {};
      const params = new URLSearchParams(rawBody);
      for (const [k, v] of params.entries()) parsed[k] = v;
      return parsed;
    }
  }

  return {};
}

function extractSessionStreamPathFromAuthPath(rawPath) {
  const normalized = normalizePath(rawPath);
  const queryless = normalized.split('?')[0];
  const exact = validSessionStreamPath(queryless) ? queryless : null;
  if (exact) return exact;
  const match = queryless.match(/^s\/[a-f0-9]{16}\/[A-Za-z0-9_-]{3,64}/);
  return match ? match[0] : null;
}

module.exports = {
  auth,
  createPublishToken,
  extractSessionStreamPathFromAuthPath,
  generateToken,
  parseMediaMtxAuthPayload,
  safeEqualString,
  signPublishTokenPayload,
  superToken,
  verifyPublishToken,
};
