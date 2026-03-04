const express = require('express');
const {
  APP_VERSION,
  PAYPAL_CLIENT_ID,
  PAYPAL_CURRENCY,
  PAYPAL_ENABLED,
  PAYPAL_ENV,
  PAYPAL_POPUP_FIRST,
  validSessionStreamPath,
} = require('../config');
const { findSessionByToken, getTotalCredits } = require('../sessions');
const { superToken } = require('../auth');
const { mtxFetch, getPublishers } = require('../mediamtx');
const { buildLivePayload } = require('../streams');
const {
  createSessionWithPromo,
  isPromoRedeemError,
  redeemPromoForSession,
} = require('../repo/promosRepo');

const router = express.Router();

router.get('/status', async (_req, res) => {
  try {
    const r = await mtxFetch('/v3/rtmpconns/list');
    res.json({
      status: r.ok ? 'ok' : 'error',
      uptime: Math.floor(process.uptime()),
      version: APP_VERSION,
      payments: {
        paypalEnabled: PAYPAL_ENABLED,
        paypalEnv: PAYPAL_ENV,
        paypalPopupFirst: PAYPAL_POPUP_FIRST,
      },
    });
  } catch {
    res.status(503).json({
      status: 'error',
      uptime: Math.floor(process.uptime()),
      version: APP_VERSION,
      payments: {
        paypalEnabled: PAYPAL_ENABLED,
        paypalEnv: PAYPAL_ENV,
        paypalPopupFirst: PAYPAL_POPUP_FIRST,
      },
    });
  }
});

router.get('/payments/paypal/config', (_req, res) => {
  if (!PAYPAL_ENABLED) {
    return res.json({ enabled: false, env: PAYPAL_ENV });
  }

  return res.json({
    enabled: true,
    env: PAYPAL_ENV,
    clientId: PAYPAL_CLIENT_ID,
    currency: PAYPAL_CURRENCY,
    flow: PAYPAL_POPUP_FIRST ? 'popup-first' : 'redirect-first',
  });
});

router.get('/credits', async (req, res) => {
  const header = req.headers.authorization || '';
  const tok = header.startsWith('Bearer ') ? header.slice(7) : null;

  try {
    if (tok && tok !== superToken) {
      const session = await findSessionByToken(tok);
      if (session) return res.json({ credits: session.credits });
    }

    if (tok === superToken) {
      const total = await getTotalCredits();
      return res.json({ credits: total });
    }

    return res.json({ credits: 0 });
  } catch (err) {
    console.error('[credits] Failed to fetch balance:', err.message);
    return res.status(503).json({ error: 'Database unavailable' });
  }
});

router.get('/streams/:name/live', async (req, res) => {
  try {
    const streamName = decodeURIComponent(req.params.name);
    if (!validSessionStreamPath(streamName)) return res.status(400).json({ error: 'Invalid stream path' });
    const publishers = await getPublishers();
    const payload = await buildLivePayload(streamName, publishers);
    return res.json(payload);
  } catch {
    return res.json({ live: false, credits: 0, quality: 'unknown' });
  }
});

function mapPromoRedeemErrorToHttp(err) {
  if (isPromoRedeemError(err, 'invalid_promo_code')) {
    return { status: 400, body: { error: 'Invalid promo code' } };
  }

  if (isPromoRedeemError(err, 'promo_already_used')) {
    return { status: 410, body: { error: 'Promo code already used' } };
  }

  if (isPromoRedeemError(err, 'promo_exhausted')) {
    return { status: 410, body: { error: 'Promo code already used' } };
  }

  if (isPromoRedeemError(err, 'session_not_found')) {
    return { status: 404, body: { error: 'Session not found' } };
  }

  return null;
}

router.post('/credits/redeem', async (req, res) => {
  const code = String(req.body?.code || '').trim();
  const header = req.headers.authorization || '';
  const existingTok = header.startsWith('Bearer ') ? header.slice(7) : null;

  try {
    const existingSession = existingTok ? await findSessionByToken(existingTok) : null;

    if (existingSession) {
      const redemption = await redeemPromoForSession(existingSession.id, code);
      console.log(
        `[credits] +${redemption.promo.credits} (${redemption.promo.label}) to session ${existingSession.id}, balance: ${redemption.mutation.credits}`,
      );

      return res.json({
        credits: redemption.mutation.credits,
        added: redemption.mutation.delta,
        token: existingTok,
        prefix: existingSession.prefix,
      });
    }

    const created = await createSessionWithPromo(code);
    console.log(`[credits] +${created.promo.credits} (${created.promo.label}), new session ${created.session.id}`);

    return res.json({
      credits: created.session.credits,
      added: created.mutation.delta,
      token: created.token,
      prefix: created.session.prefix,
    });
  } catch (err) {
    const promoFailure = mapPromoRedeemErrorToHttp(err);
    if (promoFailure) {
      return res.status(promoFailure.status).json(promoFailure.body);
    }

    console.error('[credits] Redeem failed:', err.message);
    return res.status(503).json({ error: 'Database unavailable' });
  }
});

module.exports = router;
