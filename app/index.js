const express = require('express');
const path = require('path');

const MEDIAMTX_API = process.env.MEDIAMTX_API || 'http://mediamtx:9997';
const MEDIA_ROOT   = path.join(__dirname, '..', 'html');

// --- Mutable token (can be regenerated at runtime) ---
let token = process.env.STREAM_API_TOKEN || 'streamflow-dev-token';

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return 'sf_' + Array.from({ length: 28 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// --- Credits state ---
let credits = 100;

const CREDIT_PACKAGES = {
  starter:  { credits: 100,  label: 'Starter',  price: '$ 5.00'  },
  standard: { credits: 500,  label: 'Standard', price: '$ 20.00' },
  pro:      { credits: 2000, label: 'Pro',       price: '$ 50.00' }
};

// --- MediaMTX helpers ---

// Returns active publishers: [{ id, path, bytesReceived }]
async function getPublishers() {
  const r = await fetch(`${MEDIAMTX_API}/v3/rtmpconns/list`);
  const data = await r.json();
  const seen = new Set();
  return (data.items || []).filter(c => {
    if (c.state !== 'publish' || seen.has(c.path)) return false;
    seen.add(c.path);
    return true;
  });
}

// Returns path details for a given name (tracks, readyTime, etc.)
// Falls back to {} if the path isn't in the configured-paths list.
async function getPathInfo(name) {
  try {
    const r = await fetch(`${MEDIAMTX_API}/v3/paths/get/${encodeURIComponent(name)}`);
    if (r.ok) return await r.json();
  } catch { /* ignore */ }
  return {};
}

async function kickAllStreams() {
  try {
    const publishers = await getPublishers();
    await Promise.all(
      publishers.map(c => fetch(`${MEDIAMTX_API}/v3/rtmpconns/kick/${c.id}`, { method: 'POST' }))
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

// --- Bitrate tracking: compute from bytesReceived delta ---
const prevBytes = new Map(); // streamName -> { bytes, time }

function computeBitrate(name, bytesReceived) {
  const now = Date.now();
  const prev = prevBytes.get(name);
  prevBytes.set(name, { bytes: bytesReceived, time: now });
  if (!prev || now === prev.time) return null;
  const kbps = Math.round(((bytesReceived - prev.bytes) * 8) / ((now - prev.time) / 1000) / 1000);
  return kbps > 0 ? kbps : null;
}

// --- Express ---
const app = express();
app.use(express.json());
app.use(express.static(MEDIA_ROOT));

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const tok = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (tok !== token) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Public: server health
app.get('/api/status', async (_req, res) => {
  try {
    const r = await fetch(`${MEDIAMTX_API}/v3/rtmpconns/list`);
    res.json({ status: r.ok ? 'ok' : 'error', uptime: Math.floor(process.uptime()) });
  } catch {
    res.status(503).json({ status: 'error', uptime: Math.floor(process.uptime()) });
  }
});

// Public: credit balance
app.get('/api/credits', (_req, res) => {
  res.json({ credits });
});

// Public: check if a specific stream is live (used by viewer page)
app.get('/api/streams/:name/live', async (req, res) => {
  try {
    const streamName = decodeURIComponent(req.params.name);
    const publishers = await getPublishers();
    const conn = publishers.find(c => c.path === streamName);
    if (conn) {
      const info = await getPathInfo(streamName);
      const uptime = info.readyTime
        ? Math.floor((Date.now() - new Date(info.readyTime).getTime()) / 1000)
        : 0;
      res.json({
        live: true,
        credits,
        tracks: info.tracks || [],
        bitrateKbps: computeBitrate(streamName, conn.bytesReceived || 0),
        uptime
      });
    } else {
      res.json({ live: false, credits });
    }
  } catch {
    res.json({ live: false, credits });
  }
});

// Auth: list active streams with codec + bitrate info
app.get('/api/streams', auth, async (_req, res) => {
  try {
    const publishers = await getPublishers();
    const streams = await Promise.all(
      publishers.map(async conn => {
        const info = await getPathInfo(conn.path);
        const uptime = info.readyTime
          ? Math.floor((Date.now() - new Date(info.readyTime).getTime()) / 1000)
          : 0;
        return {
          name:        conn.path,
          uptime,
          tracks:      info.tracks || [],
          bitrateKbps: computeBitrate(conn.path, conn.bytesReceived || 0)
        };
      })
    );
    res.json({ streams });
  } catch {
    res.status(503).json({ error: 'Cannot reach media server' });
  }
});

// Auth: disconnect a stream
app.delete('/api/streams/:name', auth, async (req, res) => {
  try {
    const streamName = decodeURIComponent(req.params.name);
    const publishers = await getPublishers();
    const conn = publishers.find(c => c.path === streamName);
    if (!conn) return res.status(404).json({ error: 'Stream not found' });
    await fetch(`${MEDIAMTX_API}/v3/rtmpconns/kick/${conn.id}`, { method: 'POST' });
    res.json({ success: true });
  } catch {
    res.status(503).json({ error: 'Cannot reach media server' });
  }
});

// Auth: top up credits (simulated purchase)
app.post('/api/credits/purchase', auth, (req, res) => {
  const pkg = CREDIT_PACKAGES[req.body?.package];
  if (!pkg) return res.status(400).json({ error: 'Invalid package' });
  credits += pkg.credits;
  console.log(`[credits] +${pkg.credits} (${pkg.label}), balance: ${credits}`);
  res.json({ credits, added: pkg.credits });
});

// Auth: regenerate API token at runtime
app.post('/api/token/regenerate', auth, (_req, res) => {
  token = generateToken();
  console.log('[token] Regenerated');
  res.json({ token });
});

app.listen(80, () => {
  console.log('[streamflow] dashboard and API listening on port 80');
});
