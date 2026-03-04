const express = require('express');
const { MEDIAMTX_AUTH_SECRET, extractStreamKeyFromPath, normalizePath, validSessionStreamPath } = require('../config');
const {
  extractSessionStreamPathFromAuthPath,
  parseMediaMtxAuthPayload,
  safeEqualString,
  verifyPublishToken,
} = require('../auth');
const { findSessionById } = require('../sessions');

const router = express.Router();

router.post('/internal/mediamtx/auth', express.text({ type: '*/*' }), async (req, res) => {
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

  let ownerSession;
  try {
    ownerSession = await findSessionById(verified.payload.sid);
  } catch (err) {
    console.error('[mtx-auth] failed to resolve session:', err.message);
    return res.status(503).end();
  }

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

module.exports = router;
