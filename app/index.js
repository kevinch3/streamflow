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

let token = process.env.STREAM_API_TOKEN;
if (!token) {
  token = generateToken();
  console.warn('[token] STREAM_API_TOKEN not set — generated ephemeral token:', token);
}

// --- Credits ---
let credits = 100;

const CREDIT_PACKAGES = {
  starter:  { credits: 100,  label: 'Starter',  price: '$ 5.00'  },
  standard: { credits: 500,  label: 'Standard', price: '$ 20.00' },
  pro:      { credits: 2000, label: 'Pro',       price: '$ 50.00' }
};

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
  const r    = await mtxFetch('/v3/rtmpconns/list');
  const data = await r.json();
  const seen = new Set();
  return (data.items || []).filter(c => {
    if (c.state !== 'publish' || seen.has(c.path)) return false;
    seen.add(c.path);
    return true;
  });
}

async function getPathInfo(name) {
  try {
    const r = await mtxFetch(`/v3/paths/get/${encodeURIComponent(name)}`);
    if (r.ok) return await r.json();
  } catch { /* ignore */ }
  return {};
}

async function kickAllStreams() {
  try {
    const publishers = await getPublishers();
    await Promise.all(
      publishers.map(c => mtxFetch(`/v3/rtmpconns/kick/${c.id}`, { method: 'POST' }))
    );
    console.log('[credits] All streams disconnected (credits exhausted)');
  } catch (e) {
    console.error('[credits] Failed to kick streams:', e.message);
  }
}

// Deduct 1 credit/min per active stream
setInterval(async () => {
  try {
    const publishers = await getPublishers();
    const active = publishers.length;
    if (active > 0 && credits > 0) {
      credits = Math.max(0, credits - active);
      console.log(`[credits] -${active} (${active} stream${active > 1 ? 's' : ''}), balance: ${credits}`);
      if (credits === 0) await kickAllStreams();
    }
  } catch { /* MediaMTX not reachable yet */ }
}, 60_000);

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
const adminClients  = new Set();   // admin dashboard connections
const viewerClients = new Map();   // streamName → Set<res>

// Cached state sent immediately to new admin connections
let sseCache = { streams: [], credits: 100, status: 'ok', uptime: 0 };

// Server-side broadcast loop — runs every 3s and pushes to all connected SSE clients.
// This replaces browser-side polling: N open tabs each cost just 1 persistent connection
// instead of N×(requests/min) poll requests.
setInterval(async () => {
  const hasClients = adminClients.size > 0 || viewerClients.size > 0;
  if (!hasClients) return;

  try {
    const publishers = await getPublishers();

    // Build admin payload and update cache
    const streams = await Promise.all(publishers.map(async conn => {
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

    sseCache = { streams, credits, status: 'ok', uptime: Math.floor(process.uptime()) };

    if (adminClients.size > 0) {
      const msg = `data: ${JSON.stringify(sseCache)}\n\n`;
      for (const res of adminClients) res.write(msg);
    }

    // Per-stream viewer broadcasts
    for (const [name, clients] of viewerClients) {
      if (!clients.size) continue;
      const conn = publishers.find(c => c.path === name);
      let payload;
      if (conn) {
        const info   = await getPathInfo(name);
        const uptime = info.readyTime
          ? Math.floor((Date.now() - new Date(info.readyTime).getTime()) / 1000)
          : 0;
        payload = {
          live: true, credits,
          tracks: info.tracks || [],
          bitrateKbps: computeBitrate(name, conn.bytesReceived || 0),
          uptime,
        };
      } else {
        payload = { live: false, credits };
      }
      const msg = `data: ${JSON.stringify(payload)}\n\n`;
      for (const res of clients) res.write(msg);
    }
  } catch {
    // MediaMTX unreachable — push error state to admin clients
    sseCache = { ...sseCache, status: 'error', uptime: Math.floor(process.uptime()) };
    if (adminClients.size > 0) {
      const msg = `data: ${JSON.stringify(sseCache)}\n\n`;
      for (const res of adminClients) res.write(msg);
    }
  }
}, 3000);

// --- Express ---
const app = express();

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

app.use(express.json());
app.use(express.static(MEDIA_ROOT));

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const tok    = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (tok !== token) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// --- SSE endpoints ---

// Admin SSE — EventSource doesn't support custom headers so auth via ?token= query param
app.get('/api/events', (req, res) => {
  if (req.query.token !== token) return res.status(401).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send cached state immediately so the UI isn't blank on connect
  res.write(`data: ${JSON.stringify(sseCache)}\n\n`);

  adminClients.add(res);
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
    let payload;
    if (conn) {
      const info   = await getPathInfo(streamName);
      const uptime = info.readyTime
        ? Math.floor((Date.now() - new Date(info.readyTime).getTime()) / 1000)
        : 0;
      payload = {
        live: true, credits,
        tracks: info.tracks || [],
        bitrateKbps: computeBitrate(streamName, conn.bytesReceived || 0),
        uptime,
      };
    } else {
      payload = { live: false, credits };
    }
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    res.write(`data: ${JSON.stringify({ live: false, credits })}\n\n`);
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

app.get('/api/credits', (_req, res) => {
  res.json({ credits });
});

app.get('/api/streams/:name/live', async (req, res) => {
  try {
    const streamName = decodeURIComponent(req.params.name);
    if (!validStreamName(streamName)) return res.status(400).json({ error: 'Invalid stream name' });
    const publishers = await getPublishers();
    const conn       = publishers.find(c => c.path === streamName);
    if (conn) {
      const info   = await getPathInfo(streamName);
      const uptime = info.readyTime
        ? Math.floor((Date.now() - new Date(info.readyTime).getTime()) / 1000)
        : 0;
      res.json({ live: true, credits, tracks: info.tracks || [], bitrateKbps: computeBitrate(streamName, conn.bytesReceived || 0), uptime });
    } else {
      res.json({ live: false, credits });
    }
  } catch {
    res.json({ live: false, credits });
  }
});

// --- Authenticated REST endpoints ---

app.get('/api/streams', auth, async (_req, res) => {
  try {
    const publishers = await getPublishers();
    const streams    = await Promise.all(
      publishers.map(async conn => {
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

app.delete('/api/streams/:name', auth, async (req, res) => {
  try {
    const streamName = decodeURIComponent(req.params.name);
    if (!validStreamName(streamName)) return res.status(400).json({ error: 'Invalid stream name' });
    const publishers = await getPublishers();
    const conn       = publishers.find(c => c.path === streamName);
    if (!conn) return res.status(404).json({ error: 'Stream not found' });
    await mtxFetch(`/v3/rtmpconns/kick/${conn.id}`, { method: 'POST' });
    res.json({ success: true });
  } catch {
    res.status(503).json({ error: 'Cannot reach media server' });
  }
});

app.post('/api/credits/purchase', auth, (req, res) => {
  const pkg = CREDIT_PACKAGES[req.body?.package];
  if (!pkg) return res.status(400).json({ error: 'Invalid package' });
  credits += pkg.credits;
  console.log(`[credits] +${pkg.credits} (${pkg.label}), balance: ${credits}`);
  res.json({ credits, added: pkg.credits });
});

app.post('/api/token/regenerate', auth, (_req, res) => {
  token = generateToken();
  console.log('[token] Regenerated');
  res.json({ token });
});

app.listen(80, () => {
  console.log('[streamflow] dashboard and API listening on port 80');
});
