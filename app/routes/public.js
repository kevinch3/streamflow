const express = require('express');
const { APP_VERSION, PROMO_CODES, promoUsage, validSessionStreamPath } = require('../config');
const { sessions, createSession } = require('../sessions');
const { superToken } = require('../auth');
const { mtxFetch, getPublishers } = require('../mediamtx');
const { buildLivePayload } = require('../streams');

const router = express.Router();

router.get('/status', async (_req, res) => {
  try {
    const r = await mtxFetch('/v3/rtmpconns/list');
    res.json({ status: r.ok ? 'ok' : 'error', uptime: Math.floor(process.uptime()), version: APP_VERSION });
  } catch {
    res.status(503).json({ status: 'error', uptime: Math.floor(process.uptime()), version: APP_VERSION });
  }
});

router.get('/credits', (req, res) => {
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

router.get('/streams/:name/live', async (req, res) => {
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

router.post('/credits/redeem', (req, res) => {
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
    return res.json({ credits: existingSession.credits, added: promo.credits, token: existingSession.token, prefix: existingSession.prefix });
  }

  const session = createSession(promo.credits);
  console.log(`[credits] +${promo.credits} (${promo.label}), new session ${session.id}`);
  return res.json({ credits: session.credits, added: promo.credits, token: session.token, prefix: session.prefix });
});

module.exports = router;
