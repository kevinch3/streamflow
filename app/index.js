const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createHmac, randomBytes, timingSafeEqual } = require('crypto');
const { version: APP_VERSION } = require('./package.json');

const MEDIAMTX_API = process.env.MEDIAMTX_API || 'http://mediamtx:9997';
const MEDIA_ROOT = path.join(__dirname, '..', 'html');
const MEDIAMTX_TIMEOUT = 5000;
const PUBLISH_TOKEN_TTL_MS = 10 * 60 * 1000;

const DEV_PUBLISH_TOKEN_SECRET = 'streamflow-dev-publish-token-secret';
const DEV_MEDIAMTX_AUTH_SECRET = 'streamflow-dev-mediamtx-auth-secret';

const PUBLISH_TOKEN_SECRET = process.env.PUBLISH_TOKEN_SECRET || DEV_PUBLISH_TOKEN_SECRET;
if (!process.env.PUBLISH_TOKEN_SECRET) {
  console.warn('[security] PUBLISH_TOKEN_SECRET not set — using development fallback secret');
}

const MEDIAMTX_AUTH_SECRET = process.env.MEDIAMTX_AUTH_SECRET || DEV_MEDIAMTX_AUTH_SECRET;
if (!process.env.MEDIAMTX_AUTH_SECRET) {
  console.warn('[security] MEDIAMTX_AUTH_SECRET not set — using development fallback secret');
}

// --- Token ---
function generateToken() {
  return 'sf_' + randomBytes(21).toString('base64url'); // 168 bits entropy
}

// Super admin token — full access, sees everything
const superToken = process.env.STREAM_API_TOKEN || generateToken();
if (!process.env.STREAM_API_TOKEN) {
  console.warn('[token] STREAM_API_TOKEN not set — generated ephemeral super token:', superToken);
}

// --- Sessions ---
// Map<sessionToken, Session>
// Session = { id, token, credits, prefix, createdAt }
const sessions = new Map();

function createSession(initialCredits) {
  const id = randomBytes(8).toString('hex');
  const sessionToken = generateToken();
  const prefix = `s/${id}/`;
  const session = { id, token: sessionToken, credits: initialCredits, prefix, createdAt: Date.now() };
  sessions.set(sessionToken, session);
  console.log(`[session] Created ${id}, prefix=${prefix}, credits=${initialCredits}`);
  return session;
}

function findSessionByPath(streamPath) {
  for (const session of sessions.values()) {
    if (streamPath.startsWith(session.prefix)) return session;
  }
  return null;
}

function findSessionById(sessionId) {
  for (const session of sessions.values()) {
    if (session.id === sessionId) return session;
  }
  return null;
}

// --- Credits ---
const CREDIT_PACKAGES = {
  starter: { credits: 100, label: 'Starter', price: '$ 5.00' },
  standard: { credits: 500, label: 'Standard', price: '$ 20.00' },
  pro: { credits: 2000, label: 'Pro', price: '$ 50.00' },
};

// --- Promo codes (in-memory, resets on restart) ---
const PROMO_CODES = {
  FLOW26: { credits: 200, label: 'Promo FLOW26', maxUses: 1500 },
};
const promoUsage = new Map(); // code -> use count

// --- Validation helpers ---
function validStreamKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(key);
}

function validSessionStreamPath(name) {
  return typeof name === 'string' && /^s\/[a-f0-9]{16}\/[A-Za-z0-9_-]{3,64}$/.test(name);
}

function validBrowserId(browserId) {
  return browserId === '' || /^[A-Za-z0-9._:-]{1,128}$/.test(browserId);
}

function normalizePath(streamPath) {
  return String(streamPath || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function extractStreamKeyFromPath(streamPath) {
  const parts = String(streamPath || '').split('/');
  return parts[2] || '';
}

function extractSessionStreamPathFromWhipPath(whipPath) {
  const normalized = normalizePath(whipPath);
  const match = normalized.match(/^s\/[a-f0-9]{16}\/[A-Za-z0-9_-]{3,64}/);
  if (match) return match[0].replace(/\/$/, '');
  return validSessionStreamPath(normalized) ? normalized : null;
}

function safeEqualString(a, b) {
  const lhs = Buffer.from(String(a));
  const rhs = Buffer.from(String(b));
  if (lhs.length !== rhs.length) return false;
  return timingSafeEqual(lhs, rhs);
}

// --- Publish token helpers ---
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

  if (!payload.pfx.endsWith('/')) {
    return { ok: false, reason: 'Invalid prefix claim' };
  }

  return { ok: true, payload };
}

function classifyQuality(bitrateKbps) {
  if (typeof bitrateKbps !== 'number' || bitrateKbps <= 0) return 'unknown';
  if (bitrateKbps >= 4500) return 'excellent';
  if (bitrateKbps >= 2500) return 'good';
  if (bitrateKbps >= 1000) return 'fair';
  return 'poor';
}

function getRequestHost(req) {
  const host = req.get('x-forwarded-host') || req.get('host') || req.hostname || 'localhost';
  const ipv6 = host.match(/^\[[^\]]+\]/);
  if (ipv6) return ipv6[0];
  const idx = host.indexOf(':');
  return idx === -1 ? host : host.slice(0, idx);
}

// --- MediaMTX helpers ---
async function mtxFetch(urlPath, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MEDIAMTX_TIMEOUT);
  try {
    return await fetch(`${MEDIAMTX_API}${urlPath}`, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getPublishers() {
  const seen = new Set();
  const publishers = [];

  // RTMP publishers
  const rtmp = await mtxFetch('/v3/rtmpconns/list');
  for (const c of (await rtmp.json()).items || []) {
    if (c.state === 'publish' && !seen.has(c.path)) {
      seen.add(c.path);
      publishers.push(c);
    }
  }

  // WebRTC publishers (WHIP test streams)
  const webrtc = await mtxFetch('/v3/webrtcsessions/list');
  for (const c of (await webrtc.json()).items || []) {
    if (!seen.has(c.path)) {
      seen.add(c.path);
      publishers.push({ ...c, bytesReceived: c.bytesReceived || 0, _type: 'webrtc' });
    }
  }

  return publishers;
}

async function getPathInfo(name) {
  try {
    const r = await mtxFetch(`/v3/paths/get/${encodeURIComponent(name)}`);
    if (r.ok) return await r.json();
  } catch {
    // ignore
  }
  return {};
}

function kickUrl(conn) {
  return conn._type === 'webrtc'
    ? `/v3/webrtcsessions/kick/${conn.id}`
    : `/v3/rtmpconns/kick/${conn.id}`;
}

async function buildStreamDescriptor(conn) {
  const info = await getPathInfo(conn.path);
  const uptime = info.readyTime
    ? Math.floor((Date.now() - new Date(info.readyTime).getTime()) / 1000)
    : 0;
  const bitrateKbps = computeBitrate(conn.path, conn.bytesReceived || 0);
  return {
    name: conn.path,
    uptime,
    tracks: info.tracks || [],
    bitrateKbps,
    quality: classifyQuality(bitrateKbps),
    listed: isStreamListed(conn.path),
  };
}

async function buildLivePayload(streamName, publishers, descriptorByName = null) {
  const conn = publishers.find(c => c.path === streamName);
  const ownerSession = findSessionByPath(streamName);
  const sessionCredits = ownerSession ? ownerSession.credits : 0;

  if (!conn) return { live: false, credits: sessionCredits, quality: 'unknown' };

  const stream = descriptorByName?.get(streamName) || await buildStreamDescriptor(conn);
  return {
    live: true,
    credits: sessionCredits,
    tracks: stream.tracks,
    bitrateKbps: stream.bitrateKbps,
    quality: stream.quality,
    uptime: stream.uptime,
  };
}

// Kick streams belonging to a specific session
async function kickSessionStreams(session) {
  try {
    const publishers = await getPublishers();
    const owned = publishers.filter(c => c.path.startsWith(session.prefix));
    await Promise.all(owned.map(c => mtxFetch(kickUrl(c), { method: 'POST' })));
    console.log(`[credits] Session ${session.id}: ${owned.length} stream(s) disconnected (credits exhausted)`);
  } catch (e) {
    console.error(`[credits] Session ${session.id}: Failed to kick streams:`, e.message);
  }
}

// Per-session credit deduction: 1 credit/min per active stream under each session's prefix
setInterval(async () => {
  try {
    const publishers = await getPublishers();
    for (const session of sessions.values()) {
      const owned = publishers.filter(c => c.path.startsWith(session.prefix));
      const active = owned.length;
      if (active > 0 && session.credits > 0) {
        session.credits = Math.max(0, session.credits - active);
        console.log(`[credits] Session ${session.id}: -${active} (${active} stream${active > 1 ? 's' : ''}), balance: ${session.credits}`);
        if (session.credits === 0) await kickSessionStreams(session);
      }
    }
  } catch {
    // MediaMTX not reachable yet
  }
}, 60_000);

// Session cleanup: remove idle sessions with 0 credits and no streams (every hour)
setInterval(async () => {
  const now = Date.now();
  const maxIdle = 24 * 60 * 60 * 1000; // 24 hours
  let publishers;
  try {
    publishers = await getPublishers();
  } catch {
    return;
  }

  const activePaths = new Set(publishers.map(c => c.path));
  for (const [tok, session] of sessions) {
    if (session.credits > 0) continue;
    const hasStreams = publishers.some(c => c.path.startsWith(session.prefix));
    if (hasStreams) continue;
    if (now - session.createdAt > maxIdle) {
      sessions.delete(tok);
      console.log(`[session] Cleaned up idle session ${session.id}`);
    }
  }
  // Clean stale unlisted entries for streams no longer active
  for (const path of unlistedStreams) {
    if (!activePaths.has(path)) unlistedStreams.delete(path);
  }
}, 60 * 60 * 1000);

// --- Bitrate tracking ---
const prevBytes = new Map();

function computeBitrate(name, bytesReceived) {
  const now = Date.now();
  const prev = prevBytes.get(name);
  prevBytes.set(name, { bytes: bytesReceived, time: now });
  if (!prev || now === prev.time) return null;
  const kbps = Math.round(((bytesReceived - prev.bytes) * 8) / ((now - prev.time) / 1000) / 1000);
  return kbps > 0 ? kbps : null;
}

// --- Stream visibility (listed by default) ---
const unlistedStreams = new Set(); // streamPath -> unlisted

function isStreamListed(streamPath) {
  return !unlistedStreams.has(streamPath);
}

// --- SSE client registries ---
const adminClients = new Map(); // res -> { session: Session|null, isSuperAdmin: boolean }
const viewerClients = new Map(); // streamName -> Set<res>
const publicClients = new Map(); // res -> { ip }
const PUBLIC_SSE_MAX_TOTAL = 200;
const PUBLIC_SSE_MAX_PER_IP = 5;

// Cached all-streams list for immediate send on new connections
let sseCacheStreams = [];
let sseCacheStatus = 'ok';

function buildAdminPayload(allStreams, clientInfo, status = 'ok') {
  const streams = clientInfo.isSuperAdmin
    ? allStreams
    : allStreams.filter(s => s.name.startsWith(clientInfo.session.prefix));

  let sessionCredits;
  if (clientInfo.isSuperAdmin) {
    sessionCredits = 0;
    for (const s of sessions.values()) sessionCredits += s.credits;
  } else {
    sessionCredits = clientInfo.session.credits;
  }

  return {
    streams,
    credits: sessionCredits,
    prefix: clientInfo.isSuperAdmin ? null : clientInfo.session.prefix,
    status,
    uptime: Math.floor(process.uptime()),
    version: APP_VERSION,
  };
}

function buildPublicPayload(allStreams, status = 'ok') {
  return {
    streams: allStreams.filter(s => isStreamListed(s.name)),
    status,
    uptime: Math.floor(process.uptime()),
  };
}

// Server-side broadcast loop — runs every 3s and pushes to all connected SSE clients.
setInterval(async () => {
  const hasClients = adminClients.size > 0 || viewerClients.size > 0 || publicClients.size > 0;
  if (!hasClients) return;

  try {
    const publishers = await getPublishers();

    const allStreams = await Promise.all(
      publishers.map(conn => buildStreamDescriptor(conn))
    );

    sseCacheStreams = allStreams;
    sseCacheStatus = 'ok';

    const descriptorByName = new Map(allStreams.map(s => [s.name, s]));

    if (adminClients.size > 0) {
      for (const [res, clientInfo] of adminClients) {
        const payload = buildAdminPayload(allStreams, clientInfo, 'ok');
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    }

    if (publicClients.size > 0) {
      const payload = `data: ${JSON.stringify(buildPublicPayload(allStreams, 'ok'))}\n\n`;
      for (const res of publicClients.keys()) res.write(payload);
    }

    for (const [name, clients] of viewerClients) {
      if (!clients.size) continue;
      const payload = await buildLivePayload(name, publishers, descriptorByName);
      const msg = `data: ${JSON.stringify(payload)}\n\n`;
      for (const res of clients) res.write(msg);
    }
  } catch {
    sseCacheStreams = [];
    sseCacheStatus = 'error';

    if (adminClients.size > 0) {
      for (const [res, clientInfo] of adminClients) {
        const payload = buildAdminPayload([], clientInfo, 'error');
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    }

    if (publicClients.size > 0) {
      const payload = `data: ${JSON.stringify(buildPublicPayload([], 'error'))}\n\n`;
      for (const res of publicClients.keys()) res.write(payload);
    }
  }
}, 3000);

// --- Express ---
const app = express();
app.set('trust proxy', 1);

app.use((req, res, next) => {
  const isPublicPage = req.path === '/viewer.html' || req.path === '/live.html';
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ['*', 'blob:'],
        connectSrc: ["'self'", '*:8888'],
        scriptSrcAttr: ["'unsafe-inline'"],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: isPublicPage ? ['*'] : ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })(req, res, next);
});

// Rate limit mutation endpoints
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api/token', strictLimiter);
app.use('/api/credits/purchase', strictLimiter);
app.use('/api/credits/redeem', strictLimiter);
app.use('/api/publish/prepare', strictLimiter);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.text({ type: ['application/sdp', 'application/trickle-ice-sdpfrag'] }));
app.use(express.static(MEDIA_ROOT));

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

// --- Internal MediaMTX auth callback ---
app.post('/api/internal/mediamtx/auth', express.text({ type: '*/*' }), (req, res) => {
  const providedSecret = String(req.query.secret || req.get('x-mediamtx-auth-secret') || '');
  if (!providedSecret || !safeEqualString(providedSecret, MEDIAMTX_AUTH_SECRET)) {
    return res.status(401).end();
  }

  const payload = parseMediaMtxAuthPayload(req.body);
  const action = String(payload.action || '').toLowerCase();
  if (action !== 'publish') {
    return res.status(401).end();
  }

  let rawPath = normalizePath(payload.path || '');
  let query = typeof payload.query === 'string' ? payload.query : '';

  const queryIdx = rawPath.indexOf('?');
  if (queryIdx >= 0) {
    if (!query) query = rawPath.slice(queryIdx + 1);
    rawPath = rawPath.slice(0, queryIdx);
  }

  const streamPath = extractSessionStreamPathFromAuthPath(rawPath);
  if (!validSessionStreamPath(streamPath)) {
    console.log(`[mtx-auth] rejected: invalid path "${rawPath}"`);
    return res.status(401).end();
  }

  const search = new URLSearchParams(query);
  const pt = search.get('pt');
  if (!pt) {
    console.log(`[mtx-auth] rejected: no publish token for ${streamPath}`);
    return res.status(401).end();
  }

  const verified = verifyPublishToken(pt);
  if (!verified.ok) {
    console.log(`[mtx-auth] rejected: ${verified.reason} for ${streamPath}`);
    return res.status(401).end();
  }

  const ownerSession = findSessionById(verified.payload.sid);
  if (!ownerSession || ownerSession.credits <= 0) {
    console.log(`[mtx-auth] rejected: session ${verified.payload.sid} not found or 0 credits`);
    return res.status(401).end();
  }

  const expectedPath = `${ownerSession.prefix}${verified.payload.key}`;
  if (streamPath !== expectedPath || verified.payload.pfx !== ownerSession.prefix) {
    console.log(`[mtx-auth] rejected: path/prefix mismatch for ${streamPath}`);
    return res.status(401).end();
  }

  if (extractStreamKeyFromPath(streamPath) !== verified.payload.key) {
    return res.status(401).end();
  }

  console.log(`[mtx-auth] allowed: ${streamPath} (session ${ownerSession.id}, ${payload.protocol || 'unknown'})`);
  return res.status(200).json({ ok: true });
});

// --- SSE endpoints ---

// Admin SSE — EventSource doesn't support custom headers so auth via ?token= query param
app.get('/api/events', (req, res) => {
  const tok = req.query.token;
  if (!tok) return res.status(401).end();

  let clientInfo;
  if (tok === superToken) {
    clientInfo = { session: null, isSuperAdmin: true };
  } else {
    const session = sessions.get(tok);
    if (!session) return res.status(401).end();
    clientInfo = { session, isSuperAdmin: false };
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const payload = buildAdminPayload(sseCacheStreams, clientInfo, sseCacheStatus);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);

  adminClients.set(res, clientInfo);
  req.on('close', () => adminClients.delete(res));
});

// Public SSE for public active streams page (connection-limited)
app.get('/api/events/public', (req, res) => {
  if (publicClients.size >= PUBLIC_SSE_MAX_TOTAL) {
    return res.status(503).json({ error: 'Too many connections. Try again later.' });
  }
  const ip = req.ip || req.socket.remoteAddress || '';
  let ipCount = 0;
  for (const info of publicClients.values()) {
    if (info.ip === ip) ipCount++;
  }
  if (ipCount >= PUBLIC_SSE_MAX_PER_IP) {
    return res.status(429).json({ error: 'Too many connections from your address.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const payload = buildPublicPayload(sseCacheStreams, sseCacheStatus);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);

  publicClients.set(res, { ip });
  req.on('close', () => publicClients.delete(res));
});

// Viewer SSE — public, scoped to a single stream path
app.get('/api/events/live/:name', async (req, res) => {
  const streamName = decodeURIComponent(req.params.name);
  if (!validSessionStreamPath(streamName)) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const publishers = await getPublishers();
    const payload = await buildLivePayload(streamName, publishers);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    res.write(`data: ${JSON.stringify({ live: false, credits: 0, quality: 'unknown' })}\n\n`);
  }

  if (!viewerClients.has(streamName)) viewerClients.set(streamName, new Set());
  viewerClients.get(streamName).add(res);

  req.on('close', () => {
    const clients = viewerClients.get(streamName);
    if (clients) {
      clients.delete(res);
      if (!clients.size) viewerClients.delete(streamName);
    }
  });
});

// --- Public REST endpoints (kept for curl/API use) ---
app.get('/api/status', async (_req, res) => {
  try {
    const r = await mtxFetch('/v3/rtmpconns/list');
    res.json({ status: r.ok ? 'ok' : 'error', uptime: Math.floor(process.uptime()), version: APP_VERSION });
  } catch {
    res.status(503).json({ status: 'error', uptime: Math.floor(process.uptime()), version: APP_VERSION });
  }
});

app.get('/api/credits', (req, res) => {
  const header = req.headers.authorization || '';
  const tok = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (tok && sessions.has(tok)) {
    res.json({ credits: sessions.get(tok).credits });
  } else if (tok === superToken) {
    let total = 0;
    for (const s of sessions.values()) total += s.credits;
    res.json({ credits: total });
  } else {
    res.json({ credits: 0 });
  }
});

app.get('/api/streams/:name/live', async (req, res) => {
  try {
    const streamName = decodeURIComponent(req.params.name);
    if (!validSessionStreamPath(streamName)) return res.status(400).json({ error: 'Invalid stream path' });
    const publishers = await getPublishers();
    const payload = await buildLivePayload(streamName, publishers);
    res.json(payload);
  } catch {
    res.json({ live: false, credits: 0, quality: 'unknown' });
  }
});

// --- Promo code redemption (public — no auth required, creates/extends sessions) ---
app.post('/api/credits/redeem', (req, res) => {
  const code = String(req.body?.code || '').toUpperCase().trim();
  const promo = PROMO_CODES[code];
  if (!promo) return res.status(400).json({ error: 'Invalid promo code' });

  const used = promoUsage.get(code) || 0;
  if (used >= promo.maxUses) return res.status(410).json({ error: 'Promo code already used' });

  promoUsage.set(code, used + 1);

  const header = req.headers.authorization || '';
  const existingTok = header.startsWith('Bearer ') ? header.slice(7) : null;
  const existingSession = existingTok ? sessions.get(existingTok) : null;

  if (existingSession) {
    existingSession.credits += promo.credits;
    console.log(`[credits] +${promo.credits} (${promo.label}) to session ${existingSession.id}, balance: ${existingSession.credits}`);
    res.json({ credits: existingSession.credits, added: promo.credits, token: existingSession.token, prefix: existingSession.prefix });
  } else {
    const session = createSession(promo.credits);
    console.log(`[credits] +${promo.credits} (${promo.label}), new session ${session.id}`);
    res.json({ credits: session.credits, added: promo.credits, token: session.token, prefix: session.prefix });
  }
});

// --- Authenticated REST endpoints ---
app.post('/api/publish/prepare', auth, (req, res) => {
  if (req.isSuperAdmin) {
    return res.status(400).json({ error: 'Super admin cannot prepare stream credentials. Use a session token.' });
  }

  const streamKey = String(req.body?.streamKey || '').trim();
  if (!validStreamKey(streamKey)) {
    return res.status(400).json({ error: 'Invalid stream key. Use 3-64 chars: letters, numbers, _ or -.' });
  }

  const browserId = String(req.body?.browserId || '').trim();
  if (!validBrowserId(browserId)) {
    return res.status(400).json({ error: 'Invalid browser ID format.' });
  }

  if (req.userSession.credits <= 0) {
    return res.status(402).json({ error: 'Insufficient credits to start streaming.' });
  }

  const streamPath = `${req.userSession.prefix}${streamKey}`;
  if (!validSessionStreamPath(streamPath)) {
    return res.status(400).json({ error: 'Invalid stream path.' });
  }

  const { token: publishToken, payload } = createPublishToken({
    session: req.userSession,
    streamKey,
    browserId,
  });

  const obsHost = getRequestHost(req);
  const obsServer = `rtmp://${obsHost}:1935`;
  const encodedToken = encodeURIComponent(publishToken);

  return res.json({
    streamPath,
    obsServer,
    obsStreamKey: `${streamPath}?pt=${encodedToken}`,
    viewerUrl: `/viewer.html?stream=${encodeURIComponent(streamPath)}`,
    hlsUrl: `/hls/${streamPath}/index.m3u8`,
    expiresAt: payload.exp,
  });
});

app.get('/api/streams', auth, async (req, res) => {
  try {
    const publishers = await getPublishers();
    const filtered = req.isSuperAdmin
      ? publishers
      : publishers.filter(c => c.path.startsWith(req.userSession.prefix));

    const streams = await Promise.all(filtered.map(conn => buildStreamDescriptor(conn)));
    res.json({ streams });
  } catch {
    res.status(503).json({ error: 'Cannot reach media server' });
  }
});

// WHIP proxy — browser authenticates with Bearer token, Express forwards to MediaMTX
app.post('/api/whip/:path(*)', auth, async (req, res) => {
  try {
    if (req.isSuperAdmin) {
      return res.status(400).json({ error: 'Super admin cannot publish streams directly.' });
    }

    const whipPath = normalizePath(decodeURIComponent(req.params.path));
    if (!validSessionStreamPath(whipPath)) {
      return res.status(400).json({ error: 'Invalid stream path.' });
    }

    if (!whipPath.startsWith(req.userSession.prefix)) {
      return res.status(403).json({ error: 'Stream path does not match your session prefix' });
    }

    const publishToken = String(req.query.pt || '');
    const verified = verifyPublishToken(publishToken);
    if (!verified.ok) {
      return res.status(403).json({ error: 'Invalid or expired publish token.' });
    }

    const expectedPath = `${req.userSession.prefix}${verified.payload.key}`;
    if (whipPath !== expectedPath || verified.payload.sid !== req.userSession.id || verified.payload.pfx !== req.userSession.prefix) {
      return res.status(403).json({ error: 'Publish token does not match this stream path.' });
    }

    if (req.userSession.credits <= 0) {
      return res.status(402).json({ error: 'Insufficient credits to start streaming.' });
    }

    const qs = new URLSearchParams({ pt: publishToken }).toString();
    const whipUrl = `http://mediamtx:8889/${whipPath}/whip?${qs}`;
    const headers = { 'Content-Type': 'application/sdp' };

    const r = await fetch(whipUrl, { method: 'POST', headers, body: req.body });
    const body = await r.text();

    if (r.headers.get('location')) {
      res.set('Location', `/api/whip/${r.headers.get('location').replace(/^\//, '')}`);
    }
    res.status(r.status).type('application/sdp').send(body);
  } catch (e) {
    console.error('[whip] Proxy error:', e.message);
    res.status(502).json({ error: 'WHIP proxy error: ' + e.message });
  }
});

app.patch('/api/whip/:path(*)', auth, async (req, res) => {
  try {
    const whipPath = normalizePath(decodeURIComponent(req.params.path));
    const streamPath = extractSessionStreamPathFromWhipPath(whipPath);
    if (!streamPath) return res.status(400).json({ error: 'Invalid WHIP resource path.' });

    if (!req.isSuperAdmin && !streamPath.startsWith(req.userSession.prefix)) {
      return res.status(403).json({ error: 'Cannot update stream resources you do not own.' });
    }

    const url = `http://mediamtx:8889/${whipPath}`;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': req.get('Content-Type') || 'application/trickle-ice-sdpfrag' },
      body: req.body,
    });
    res.status(r.status).send(await r.text());
  } catch (e) {
    res.status(502).json({ error: 'WHIP proxy error: ' + e.message });
  }
});

app.delete('/api/whip/:path(*)', auth, async (req, res) => {
  try {
    const whipPath = normalizePath(decodeURIComponent(req.params.path));
    const streamPath = extractSessionStreamPathFromWhipPath(whipPath);
    if (!streamPath) return res.status(400).json({ error: 'Invalid WHIP resource path.' });

    if (!req.isSuperAdmin && !streamPath.startsWith(req.userSession.prefix)) {
      return res.status(403).json({ error: 'Cannot delete stream resources you do not own.' });
    }

    const url = `http://mediamtx:8889/${whipPath}`;
    const r = await fetch(url, { method: 'DELETE' });
    res.status(r.status).send(await r.text());
  } catch (e) {
    res.status(502).json({ error: 'WHIP proxy error: ' + e.message });
  }
});

app.delete('/api/streams/:name', auth, async (req, res) => {
  try {
    const streamName = decodeURIComponent(req.params.name);
    if (!validSessionStreamPath(streamName)) return res.status(400).json({ error: 'Invalid stream path' });

    if (!req.isSuperAdmin && !streamName.startsWith(req.userSession.prefix)) {
      return res.status(403).json({ error: 'Cannot disconnect streams you do not own' });
    }

    const publishers = await getPublishers();
    const conn = publishers.find(c => c.path === streamName);
    if (!conn) return res.status(404).json({ error: 'Stream not found' });
    await mtxFetch(kickUrl(conn), { method: 'POST' });
    res.json({ success: true });
  } catch {
    res.status(503).json({ error: 'Cannot reach media server' });
  }
});

app.patch('/api/streams/:name/visibility', auth, (req, res) => {
  const streamName = decodeURIComponent(req.params.name);
  if (!validSessionStreamPath(streamName)) return res.status(400).json({ error: 'Invalid stream path' });

  if (!req.isSuperAdmin && !streamName.startsWith(req.userSession.prefix)) {
    return res.status(403).json({ error: 'Cannot change visibility for streams you do not own' });
  }

  const listed = req.body?.listed;
  if (typeof listed !== 'boolean') {
    return res.status(400).json({ error: 'Body must include { listed: true|false }' });
  }

  if (listed) {
    unlistedStreams.delete(streamName);
  } else {
    unlistedStreams.add(streamName);
  }

  console.log(`[visibility] ${streamName}: ${listed ? 'listed' : 'unlisted'}`);
  res.json({ name: streamName, listed });
});

app.post('/api/credits/purchase', auth, (req, res) => {
  const pkg = CREDIT_PACKAGES[req.body?.package];
  if (!pkg) return res.status(400).json({ error: 'Invalid package' });

  if (req.isSuperAdmin) {
    return res.status(400).json({ error: 'Super admin cannot purchase credits. Use a session token.' });
  }

  req.userSession.credits += pkg.credits;
  console.log(`[credits] Session ${req.userSession.id}: +${pkg.credits} (${pkg.label}), balance: ${req.userSession.credits}`);
  res.json({ credits: req.userSession.credits, added: pkg.credits, token: req.userSession.token });
});

app.post('/api/token/regenerate', auth, (req, res) => {
  if (req.isSuperAdmin) {
    return res.status(400).json({ error: 'Super admin token is managed via STREAM_API_TOKEN env var' });
  }
  const oldToken = req.userSession.token;
  const newToken = generateToken();
  req.userSession.token = newToken;
  sessions.delete(oldToken);
  sessions.set(newToken, req.userSession);
  console.log(`[token] Session ${req.userSession.id}: token regenerated`);
  res.json({ token: newToken });
});

const PORT = parseInt(process.env.PORT || '80', 10);
app.listen(PORT, () => {
  console.log(`[streamflow] dashboard and API listening on port ${PORT}`);
});
