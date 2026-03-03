const express = require('express');
const { superToken } = require('../auth');
const { sessions } = require('../sessions');
const { getPublishers } = require('../mediamtx');
const { buildLivePayload } = require('../streams');
const {
  PUBLIC_SSE_MAX_PER_IP,
  PUBLIC_SSE_MAX_TOTAL,
  adminClients,
  buildAdminPayload,
  buildPublicPayload,
  publicClients,
  sseCache,
  viewerClients,
} = require('../sse');
const { validSessionStreamPath } = require('../config');

const router = express.Router();

router.get('/events', (req, res) => {
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

  const payload = buildAdminPayload(sseCache.streams, clientInfo, sseCache.status);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);

  adminClients.set(res, clientInfo);
  req.on('close', () => adminClients.delete(res));
});

router.get('/events/public', (req, res) => {
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

  const payload = buildPublicPayload(sseCache.streams, sseCache.status);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);

  publicClients.set(res, { ip });
  req.on('close', () => publicClients.delete(res));
});

router.get('/events/live/:name', async (req, res) => {
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

module.exports = router;
