const express   = require('express');
const path      = require('path');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const { randomBytes } = require('crypto');

const MEDIAMTX_API     = process.env.MEDIAMTX_API || 'http://mediamtx:9997';
const MEDIA_ROOT       = path.join(__dirname, '..', 'html');
const MEDIAMTX_TIMEOUT = 5000;

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

// --- Credits ---
const CREDIT_PACKAGES = {
  starter:  { credits: 100,  label: 'Starter',  price: '$ 5.00'  },
  standard: { credits: 500,  label: 'Standard', price: '$ 20.00' },
  pro:      { credits: 2000, label: 'Pro',       price: '$ 50.00' }
};

// --- Promo codes (in-memory, resets on restart) ---
const PROMO_CODES = {
  'FLOW26': { credits: 200, label: 'Promo FLOW26', maxUses: 1500 }
};
const promoUsage = new Map(); // code → use count

// --- MediaMTX helpers ---

async function mtxFetch(urlPath, options = {}) {
  const ctrl  = new AbortController();
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
  } catch { /* ignore */ }
  return {};
}

function kickUrl(conn) {
  return conn._type === 'webrtc'
    ? `/v3/webrtcsessions/kick/${conn.id}`
    : `/v3/rtmpconns/kick/${conn.id}`;
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
  } catch { /* MediaMTX not reachable yet */ }
}, 60_000);

// Session cleanup: remove idle sessions with 0 credits and no streams (every hour)
setInterval(async () => {
  const now = Date.now();
  const maxIdle = 24 * 60 * 60 * 1000; // 24 hours
  let publishers;
  try { publishers = await getPublishers(); } catch { return; }
  for (const [tok, session] of sessions) {
    if (session.credits > 0) continue;
    const hasStreams = publishers.some(c => c.path.startsWith(session.prefix));
    if (hasStreams) continue;
    if (now - session.createdAt > maxIdle) {
      sessions.delete(tok);
      console.log(`[session] Cleaned up idle session ${session.id}`);
    }
  }
}, 60 * 60 * 1000);

// --- Bitrate tracking ---
const prevBytes = new Map();

function computeBitrate(name, bytesReceived) {
  const now  = Date.now();
  const prev = prevBytes.get(name);
  prevBytes.set(name, { bytes: bytesReceived, time: now });
  if (!prev || now === prev.time) return null;
  const kbps = Math.round(((bytesReceived - prev.bytes) * 8) / ((now - prev.time) / 1000) / 1000);
  return kbps > 0 ? kbps : null;
}

// --- Stream name validation ---
function validStreamName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_\-/]{1,200}$/.test(name);
}

// --- SSE client registry ---
const adminClients  = new Map();   // res → { session: Session|null, isSuperAdmin: boolean }
const viewerClients = new Map();   // streamName → Set<res>

// Cached all-streams list for immediate send on new connections
let sseCacheStreams = [];

// Build admin payload filtered for a specific client
function buildAdminPayload(allStreams, clientInfo) {
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
    status: 'ok',
    uptime: Math.floor(process.uptime()),
  };
}

// Server-side broadcast loop — runs every 3s and pushes to all connected SSE clients.
setInterval(async () => {
  const hasClients = adminClients.size > 0 || viewerClients.size > 0;
  if (!hasClients) return;

  try {
    const publishers = await getPublishers();

    // Build full stream list (computed once)
    const allStreams = await Promise.all(publishers.map(async conn => {
      const info   = await getPathInfo(conn.path);
      const uptime = info.readyTime
        ? Math.floor((Date.now() - new Date(info.readyTime).getTime()) / 1000)
        : 0;
      return {
        name:        conn.path,
        uptime,
        tracks:      info.tracks || [],
        bitrateKbps: computeBitrate(conn.path, conn.bytesReceived || 0),
      };
    }));

    sseCacheStreams = allStreams;

    // Per-client admin broadcasts
    if (adminClients.size > 0) {
      for (const [res, clientInfo] of adminClients) {
        const payload = buildAdminPayload(allStreams, clientInfo);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    }

    // Per-stream viewer broadcasts
    for (const [name, clients] of viewerClients) {
      if (!clients.size) continue;
      const conn = publishers.find(c => c.path === name);
      const ownerSession = findSessionByPath(name);
      const sessionCredits = ownerSession ? ownerSession.credits : 0;
      let payload;
      if (conn) {
        const info   = await getPathInfo(name);
        const uptime = info.readyTime
          ? Math.floor((Date.now() - new Date(info.readyTime).getTime()) / 1000)
          : 0;
        payload = {
          live: true, credits: sessionCredits,
          tracks: info.tracks || [],
          bitrateKbps: computeBitrate(name, conn.bytesReceived || 0),
          uptime,
        };
      } else {
        payload = { live: false, credits: sessionCredits };
      }
      const msg = `data: ${JSON.stringify(payload)}\n\n`;
      for (const res of clients) res.write(msg);
    }
  } catch {
    // MediaMTX unreachable — push error state to admin clients
    if (adminClients.size > 0) {
      for (const [res, clientInfo] of adminClients) {
        const payload = { ...buildAdminPayload([], clientInfo), status: 'error' };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    }
  }
}, 3000);

// --- Express ---
const app = express();
app.set('trust proxy', 1);

app.use((req, res, next) => {
  const isViewer = req.path === '/viewer.html';
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:    ["'self'"],
        scriptSrc:     ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc:      ["'self'", "'unsafe-inline'"],
        imgSrc:        ["'self'", "data:", "blob:"],
        mediaSrc:      ["*", "blob:"],
        connectSrc:    ["'self'", "*:8888"],
        scriptSrcAttr: ["'unsafe-inline'"],
        workerSrc:     ["'self'", "blob:"],
        objectSrc:     ["'none'"],
        baseUri:       ["'self'"],
        frameAncestors: isViewer ? ["*"] : ["'none'"],
      }
    },
    crossOriginEmbedderPolicy: false,
  })(req, res, next);
});

// Rate limit only on mutation endpoints — SSE eliminates the polling pressure
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

app.use(express.json());
app.use(express.text({ type: ['application/sdp', 'application/trickle-ice-sdpfrag'] }));
app.use(express.static(MEDIA_ROOT));

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const tok    = header.startsWith('Bearer ') ? header.slice(7) : null;
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

  // Send cached state immediately so the UI isn't blank on connect
  const payload = buildAdminPayload(sseCacheStreams, clientInfo);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);

  adminClients.set(res, clientInfo);
  req.on('close', () => adminClients.delete(res));
});

// Viewer SSE — public, scoped to a single stream path
app.get('/api/events/live/:name', async (req, res) => {
  const streamName = decodeURIComponent(req.params.name);
  if (!validStreamName(streamName)) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Fetch and send current state immediately
  try {
    const publishers = await getPublishers();
    const conn       = publishers.find(c => c.path === streamName);
    const ownerSession = findSessionByPath(streamName);
    const sessionCredits = ownerSession ? ownerSession.credits : 0;
    let payload;
    if (conn) {
      const info   = await getPathInfo(streamName);
      const uptime = info.readyTime
        ? Math.floor((Date.now() - new Date(info.readyTime).getTime()) / 1000)
        : 0;
      payload = {
        live: true, credits: sessionCredits,
        tracks: info.tracks || [],
        bitrateKbps: computeBitrate(streamName, conn.bytesReceived || 0),
        uptime,
      };
    } else {
      payload = { live: false, credits: sessionCredits };
    }
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    res.write(`data: ${JSON.stringify({ live: false, credits: 0 })}\n\n`);
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
    res.json({ status: r.ok ? 'ok' : 'error', uptime: Math.floor(process.uptime()) });
  } catch {
    res.status(503).json({ status: 'error', uptime: Math.floor(process.uptime()) });
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
    if (!validStreamName(streamName)) return res.status(400).json({ error: 'Invalid stream name' });
    const publishers = await getPublishers();
    const conn       = publishers.find(c => c.path === streamName);
    const ownerSession = findSessionByPath(streamName);
    const sessionCredits = ownerSession ? ownerSession.credits : 0;
    if (conn) {
      const info   = await getPathInfo(streamName);
      const uptime = info.readyTime
        ? Math.floor((Date.now() - new Date(info.readyTime).getTime()) / 1000)
        : 0;
      res.json({ live: true, credits: sessionCredits, tracks: info.tracks || [], bitrateKbps: computeBitrate(streamName, conn.bytesReceived || 0), uptime });
    } else {
      res.json({ live: false, credits: sessionCredits });
    }
  } catch {
    res.json({ live: false, credits: 0 });
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

  // Check if caller already has a valid session
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

app.get('/api/streams', auth, async (req, res) => {
  try {
    const publishers = await getPublishers();
    const filtered = req.isSuperAdmin
      ? publishers
      : publishers.filter(c => c.path.startsWith(req.userSession.prefix));
    const streams = await Promise.all(
      filtered.map(async conn => {
        const info   = await getPathInfo(conn.path);
        const uptime = info.readyTime
          ? Math.floor((Date.now() - new Date(info.readyTime).getTime()) / 1000)
          : 0;
        return { name: conn.path, uptime, tracks: info.tracks || [], bitrateKbps: computeBitrate(conn.path, conn.bytesReceived || 0) };
      })
    );
    res.json({ streams });
  } catch {
    res.status(503).json({ error: 'Cannot reach media server' });
  }
});

// WHIP proxy — browser authenticates with Bearer token, Express forwards to MediaMTX with RTMP credentials
app.post('/api/whip/:path(*)', auth, async (req, res) => {
  try {
    const whipPath = req.params.path;
    if (!req.isSuperAdmin && !whipPath.startsWith(req.userSession.prefix)) {
      return res.status(403).json({ error: 'Stream path does not match your session prefix' });
    }
    const whipUrl = `http://mediamtx:8889/${whipPath}/whip`;
    console.log(`[whip] POST ${whipUrl} (body: ${typeof req.body === 'string' ? req.body.length + ' chars' : typeof req.body})`);
    const headers = { 'Content-Type': 'application/sdp' };
    const pass = process.env.RTMP_PUBLISH_KEY;
    if (pass) headers['Authorization'] = 'Basic ' + Buffer.from(`stream:${pass}`).toString('base64');
    const r = await fetch(whipUrl, { method: 'POST', headers, body: req.body });
    const body = await r.text();
    console.log(`[whip] MediaMTX responded ${r.status} (${body.length} chars)`);
    if (r.headers.get('location')) res.set('Location', `/api/whip/${r.headers.get('location').replace(/^\//, '')}`);
    res.status(r.status).type('application/sdp').send(body);
  } catch (e) {
    console.error('[whip] Proxy error:', e.message);
    res.status(502).json({ error: 'WHIP proxy error: ' + e.message });
  }
});

app.patch('/api/whip/:path(*)', auth, async (req, res) => {
  try {
    const url = `http://mediamtx:8889/${req.params.path}`;
    const r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': req.get('Content-Type') || 'application/trickle-ice-sdpfrag' }, body: req.body });
    res.status(r.status).send(await r.text());
  } catch (e) {
    res.status(502).json({ error: 'WHIP proxy error: ' + e.message });
  }
});

app.delete('/api/whip/:path(*)', auth, async (req, res) => {
  try {
    const url = `http://mediamtx:8889/${req.params.path}`;
    const r = await fetch(url, { method: 'DELETE' });
    res.status(r.status).send(await r.text());
  } catch (e) {
    res.status(502).json({ error: 'WHIP proxy error: ' + e.message });
  }
});

app.delete('/api/streams/:name', auth, async (req, res) => {
  try {
    const streamName = decodeURIComponent(req.params.name);
    if (!validStreamName(streamName)) return res.status(400).json({ error: 'Invalid stream name' });

    // Ownership check
    if (!req.isSuperAdmin && !streamName.startsWith(req.userSession.prefix)) {
      return res.status(403).json({ error: 'Cannot disconnect streams you do not own' });
    }

    const publishers = await getPublishers();
    const conn       = publishers.find(c => c.path === streamName);
    if (!conn) return res.status(404).json({ error: 'Stream not found' });
    await mtxFetch(kickUrl(conn), { method: 'POST' });
    res.json({ success: true });
  } catch {
    res.status(503).json({ error: 'Cannot reach media server' });
  }
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

const PORT = parseInt(process.env.PORT || '80');
app.listen(PORT, () => {
  console.log(`[streamflow] dashboard and API listening on port ${PORT}`);
});
