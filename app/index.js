const express = require('express');
const path = require('path');

const TOKEN = process.env.STREAM_API_TOKEN || 'streamflow-dev-token';
const MEDIAMTX_API = process.env.MEDIAMTX_API || 'http://mediamtx:9997';
const MEDIA_ROOT = path.join(__dirname, '..', 'html');

// --- Credits state ---
let credits = 100; // starting balance

const CREDIT_PACKAGES = {
  starter:  { credits: 100,  label: 'Starter',  price: '$ 5.00'  },
  standard: { credits: 500,  label: 'Standard', price: '$ 20.00' },
  pro:      { credits: 2000, label: 'Pro',       price: '$ 50.00' }
};

async function kickAllStreams() {
  try {
    const r = await fetch(`${MEDIAMTX_API}/v3/rtmpconns/list`);
    const data = await r.json();
    await Promise.all(
      (data.items || [])
        .filter(c => c.state === 'publish')
        .map(c => fetch(`${MEDIAMTX_API}/v3/rtmpconns/kick/${c.id}`, { method: 'POST' }))
    );
    console.log('[credits] All streams disconnected (credits exhausted)');
  } catch (e) {
    console.error('[credits] Failed to kick streams:', e.message);
  }
}

// Deduct 1 credit per active stream per minute
setInterval(async () => {
  try {
    const r = await fetch(`${MEDIAMTX_API}/v3/paths/list`);
    const data = await r.json();
    const active = (data.items || []).filter(p => p.ready).length;
    if (active > 0 && credits > 0) {
      credits = Math.max(0, credits - active);
      console.log(`[credits] -${active} (${active} stream${active > 1 ? 's' : ''}), balance: ${credits}`);
      if (credits === 0) {
        await kickAllStreams();
      }
    }
  } catch {
    // MediaMTX not reachable yet — skip tick
  }
}, 60_000);

// --- Express ---
const app = express();
app.use(express.json());
app.use(express.static(MEDIA_ROOT));

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token !== TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Public: server health
app.get('/api/status', async (_req, res) => {
  try {
    const r = await fetch(`${MEDIAMTX_API}/v3/paths/list`);
    res.json({ status: r.ok ? 'ok' : 'error', uptime: Math.floor(process.uptime()) });
  } catch {
    res.status(503).json({ status: 'error', uptime: Math.floor(process.uptime()) });
  }
});

// Public: credit balance
app.get('/api/credits', (_req, res) => {
  res.json({ credits });
});

// Auth: top up credits (simulated purchase)
app.post('/api/credits/purchase', auth, (req, res) => {
  const pkg = CREDIT_PACKAGES[req.body?.package];
  if (!pkg) {
    return res.status(400).json({ error: 'Invalid package' });
  }
  credits += pkg.credits;
  console.log(`[credits] +${pkg.credits} (${pkg.label}), balance: ${credits}`);
  res.json({ credits, added: pkg.credits });
});

// Auth: list active streams
app.get('/api/streams', auth, async (_req, res) => {
  try {
    const r = await fetch(`${MEDIAMTX_API}/v3/paths/list`);
    const data = await r.json();
    const streams = (data.items || [])
      .filter(p => p.ready)
      .map(p => ({
        name: p.name,
        uptime: p.readyTime
          ? Math.floor((Date.now() - new Date(p.readyTime).getTime()) / 1000)
          : 0
      }));
    res.json({ streams });
  } catch {
    res.status(503).json({ error: 'Cannot reach media server' });
  }
});

// Auth: disconnect a stream by path (e.g. "live/test" → encoded as "live%2Ftest")
app.delete('/api/streams/:name', auth, async (req, res) => {
  try {
    const streamName = decodeURIComponent(req.params.name);
    const r = await fetch(`${MEDIAMTX_API}/v3/rtmpconns/list`);
    const data = await r.json();
    const conn = (data.items || []).find(
      c => c.path === streamName && c.state === 'publish'
    );
    if (!conn) {
      return res.status(404).json({ error: 'Stream not found' });
    }
    await fetch(`${MEDIAMTX_API}/v3/rtmpconns/kick/${conn.id}`, { method: 'POST' });
    res.json({ success: true });
  } catch {
    res.status(503).json({ error: 'Cannot reach media server' });
  }
});

app.listen(80, () => {
  console.log('[streamflow] dashboard and API listening on port 80');
});
