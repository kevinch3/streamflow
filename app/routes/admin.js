const express = require('express');
const { auth, createPublishToken } = require('../auth');
const {
  CREDIT_PACKAGES,
  getRequestHost,
  validBrowserId,
  validSessionStreamPath,
  validStreamKey,
  extractStreamKeyFromPath,
} = require('../config');
const { regenerateSessionToken } = require('../sessions');
const { getPublishers, kickUrl, mtxFetch } = require('../mediamtx');
const { buildStreamDescriptor, setStreamVisibility } = require('../streams');
const { addCredits } = require('../repo/creditsRepo');
const { clampLimit, listCreditHistory } = require('../repo/ledgerRepo');

const router = express.Router();

router.post('/publish/prepare', auth, (req, res) => {
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

  if (extractStreamKeyFromPath(streamPath) !== streamKey) {
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

router.get('/streams', auth, async (req, res) => {
  try {
    const publishers = await getPublishers();
    const filtered = req.isSuperAdmin
      ? publishers
      : publishers.filter((conn) => conn.path.startsWith(req.userSession.prefix));

    const streams = await Promise.all(filtered.map((conn) => buildStreamDescriptor(conn)));
    return res.json({ streams });
  } catch {
    return res.status(503).json({ error: 'Cannot reach media server' });
  }
});

router.delete('/streams/:name', auth, async (req, res) => {
  try {
    const streamName = decodeURIComponent(req.params.name);
    if (!validSessionStreamPath(streamName)) return res.status(400).json({ error: 'Invalid stream path' });

    if (!req.isSuperAdmin && !streamName.startsWith(req.userSession.prefix)) {
      return res.status(403).json({ error: 'Cannot disconnect streams you do not own' });
    }

    const publishers = await getPublishers();
    const conn = publishers.find((c) => c.path === streamName);
    if (!conn) return res.status(404).json({ error: 'Stream not found' });
    await mtxFetch(kickUrl(conn), { method: 'POST' });
    return res.json({ success: true });
  } catch {
    return res.status(503).json({ error: 'Cannot reach media server' });
  }
});

router.patch('/streams/:name/visibility', auth, (req, res) => {
  const streamName = decodeURIComponent(req.params.name);
  if (!validSessionStreamPath(streamName)) return res.status(400).json({ error: 'Invalid stream path' });

  if (!req.isSuperAdmin && !streamName.startsWith(req.userSession.prefix)) {
    return res.status(403).json({ error: 'Cannot change visibility for streams you do not own' });
  }

  const listed = req.body?.listed;
  if (typeof listed !== 'boolean') {
    return res.status(400).json({ error: 'Body must include { listed: true|false }' });
  }

  setStreamVisibility(streamName, listed);
  console.log(`[visibility] ${streamName}: ${listed ? 'listed' : 'unlisted'}`);
  return res.json({ name: streamName, listed });
});

router.post('/credits/purchase', auth, async (req, res) => {
  const packageName = req.body?.package;
  const pkg = CREDIT_PACKAGES[packageName];
  if (!pkg) return res.status(400).json({ error: 'Invalid package' });

  if (req.isSuperAdmin) {
    return res.status(400).json({ error: 'Super admin cannot purchase credits. Use a session token.' });
  }

  try {
    const mutation = await addCredits(req.userSession.id, pkg.credits, {
      eventType: 'purchase',
      meta: { package: packageName, label: pkg.label, price: pkg.price },
    });
    if (!mutation) return res.status(404).json({ error: 'Session not found' });

    req.userSession.credits = mutation.credits;
    console.log(`[credits] Session ${req.userSession.id}: +${pkg.credits} (${pkg.label}), balance: ${mutation.credits}`);

    return res.json({ credits: mutation.credits, added: mutation.delta, token: req.authToken });
  } catch (err) {
    console.error('[credits] Purchase failed:', err.message);
    return res.status(503).json({ error: 'Database unavailable' });
  }
});

router.get('/credits/history', auth, async (req, res) => {
  const limit = clampLimit(req.query.limit, 50);

  try {
    const entries = req.isSuperAdmin
      ? await listCreditHistory({ limit })
      : await listCreditHistory({ sessionId: req.userSession.id, limit });

    return res.json({ entries });
  } catch (err) {
    console.error('[credits] History lookup failed:', err.message);
    return res.status(503).json({ error: 'Database unavailable' });
  }
});

router.post('/token/regenerate', auth, async (req, res) => {
  if (req.isSuperAdmin) {
    return res.status(400).json({ error: 'Super admin token is managed via STREAM_API_TOKEN env var' });
  }

  try {
    const newToken = await regenerateSessionToken(req.userSession.id);
    console.log(`[token] Session ${req.userSession.id}: token regenerated`);
    return res.json({ token: newToken });
  } catch (err) {
    console.error('[token] Failed to regenerate token:', err.message);
    return res.status(503).json({ error: 'Database unavailable' });
  }
});

module.exports = router;
