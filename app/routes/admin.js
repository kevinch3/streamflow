const express = require('express');
const { auth, createPublishToken } = require('../auth');
const {
  CREDIT_PACKAGES,
  getRequestHost,
  PAYPAL_ENABLED,
  PAYPAL_POPUP_FIRST,
  STRIPE_ENABLED,
  validBrowserId,
  validSessionStreamPath,
  validStreamKey,
  extractStreamKeyFromPath,
} = require('../config');
const { regenerateSessionToken } = require('../sessions');
const { getPublishers, kickUrl, mtxFetch } = require('../mediamtx');
const { buildStreamDescriptor, setStreamVisibility } = require('../streams');
const { addCreditsOnce, addCreditsOnceForPaypalOrder } = require('../repo/creditsRepo');
const { clampLimit, listCreditHistory } = require('../repo/ledgerRepo');
const {
  PayPalError,
  capturePaypalOrder,
  createPaypalOrder,
} = require('../payments/paypal');
const {
  StripeError,
  createPaymentIntent,
  retrievePaymentIntent,
} = require('../payments/stripe');

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

function getRequestOrigin(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host') || req.hostname || 'localhost';
  return `${proto}://${host}`;
}

function parsePayPalCustomId(customIdRaw) {
  try {
    const parsed = JSON.parse(String(customIdRaw || ''));
    const sid = String(parsed?.sid || '').trim();
    const pkg = String(parsed?.pkg || '').trim();
    if (!sid || !pkg) return null;
    return { sid, pkg };
  } catch {
    return null;
  }
}

router.post('/credits/purchase', auth, async (req, res) => {
  if (req.isSuperAdmin) {
    return res.status(400).json({ error: 'Super admin cannot purchase credits. Use a session token.' });
  }

  const method = String(req.body?.method || '').trim().toLowerCase();
  if (method !== 'paypal' && method !== 'stripe') {
    return res.status(400).json({ error: 'Unsupported payment method.' });
  }

  const action = String(req.body?.action || 'create').trim().toLowerCase();

  try {
    // ── Stripe branch ──────────────────────────────────────────────
    if (method === 'stripe') {
      if (!STRIPE_ENABLED) return res.status(503).json({ error: 'Stripe is not configured on this server.' });

      if (action === 'create') {
        const packageName = String(req.body?.package || '').trim();
        const pkg = CREDIT_PACKAGES[packageName];
        if (!pkg) return res.status(400).json({ error: 'Invalid package' });

        const { paymentIntentId, clientSecret } = await createPaymentIntent({
          packageName,
          pkg,
          sessionId: req.userSession.id,
        });
        return res.json({ paymentIntentId, clientSecret });
      }

      if (action === 'confirm') {
        const paymentIntentId = String(req.body?.paymentIntentId || '').trim();
        if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId is required' });

        const pi = await retrievePaymentIntent(paymentIntentId);
        if (pi.status !== 'succeeded') {
          return res.status(400).json({ error: `Payment not completed (status: ${pi.status})` });
        }
        if (pi.metadata?.sid !== req.userSession.id) {
          return res.status(403).json({ error: 'Payment does not belong to this session.' });
        }

        const packageName = String(pi.metadata?.pkg || '').trim();
        const pkg = CREDIT_PACKAGES[packageName];
        if (!pkg) return res.status(400).json({ error: 'Payment package is invalid.' });

        const expectedAmount = Math.round(parseFloat(pkg.amount) * 100);
        if (pi.amount !== expectedAmount || pi.currency !== pkg.currency.toLowerCase()) {
          return res.status(400).json({ error: 'Payment amount does not match package price.' });
        }

        const mutation = await addCreditsOnce(req.userSession.id, pkg.credits, {
          paymentMethod: 'stripe',
          orderId: pi.id,
          meta: {
            package: packageName,
            label: pkg.label,
            price: pkg.price,
            amount: pkg.amount,
            currency: pkg.currency,
            stripePaymentIntentId: pi.id,
          },
        });
        if (!mutation) return res.status(404).json({ error: 'Session not found' });

        req.userSession.credits = mutation.credits;
        if (mutation.alreadyApplied) {
          return res.json({ credits: mutation.credits, added: 0, token: req.authToken, alreadyApplied: true });
        }

        console.log(`[credits] Session ${req.userSession.id}: +${pkg.credits} (${pkg.label}) via Stripe, balance: ${mutation.credits}`);
        return res.json({ credits: mutation.credits, added: mutation.delta, token: req.authToken });
      }

      return res.status(400).json({ error: 'Invalid purchase action' });
    }

    // ── PayPal branch ──────────────────────────────────────────────
    if (!PAYPAL_ENABLED) {
      return res.status(503).json({ error: 'PayPal is not configured on this server.' });
    }

    if (action === 'create') {
      const packageName = String(req.body?.package || '').trim();
      const pkg = CREDIT_PACKAGES[packageName];
      if (!pkg) return res.status(400).json({ error: 'Invalid package' });

      const origin = getRequestOrigin(req);
      const { approvalUrl, orderId } = await createPaypalOrder({
        packageName,
        pkg,
        sessionId: req.userSession.id,
        returnUrl: `${origin}/?paypal=success`,
        cancelUrl: `${origin}/?paypal=cancelled`,
      });

      return res.json({
        next: PAYPAL_POPUP_FIRST ? 'popup' : 'redirect',
        approvalUrl,
        orderId,
      });
    }

    if (action === 'capture') {
      const orderId = String(req.body?.orderId || '').trim();
      if (!orderId) return res.status(400).json({ error: 'orderId is required' });

      const capture = await capturePaypalOrder(orderId);
      const custom = parsePayPalCustomId(capture.customId);
      if (!custom) return res.status(400).json({ error: 'PayPal order context is invalid.' });
      if (custom.sid !== req.userSession.id) {
        return res.status(403).json({ error: 'PayPal order does not belong to this session.' });
      }

      const pkg = CREDIT_PACKAGES[custom.pkg];
      if (!pkg) return res.status(400).json({ error: 'PayPal order package is invalid.' });
      if (capture.amountCurrency !== pkg.currency || capture.amountValue !== pkg.amount) {
        return res.status(400).json({ error: 'Captured PayPal amount does not match package price.' });
      }

      const mutation = await addCreditsOnceForPaypalOrder(req.userSession.id, pkg.credits, {
        orderId: capture.orderId,
        meta: {
          package: custom.pkg,
          label: pkg.label,
          price: pkg.price,
          amount: pkg.amount,
          currency: pkg.currency,
          paypalCaptureId: capture.captureId,
          paypalPayerId: capture.payerId,
        },
      });
      if (!mutation) return res.status(404).json({ error: 'Session not found' });

      req.userSession.credits = mutation.credits;
      if (mutation.alreadyApplied) {
        return res.json({
          credits: mutation.credits,
          added: 0,
          token: req.authToken,
          alreadyApplied: true,
        });
      }

      console.log(`[credits] Session ${req.userSession.id}: +${pkg.credits} (${pkg.label}) via PayPal, balance: ${mutation.credits}`);
      return res.json({ credits: mutation.credits, added: mutation.delta, token: req.authToken });
    }

    return res.status(400).json({ error: 'Invalid purchase action' });
  } catch (err) {
    if (err instanceof StripeError) {
      console.error('[stripe] Purchase flow failed:', { message: err.message, statusCode: err.statusCode, action });
      return res.status(err.statusCode || 500).json({ error: err.message });
    }
    if (err instanceof PayPalError) {
      console.error('[paypal] Purchase flow failed:', {
        message: err.message,
        statusCode: err.statusCode,
        action,
        orderId: String(req.body?.orderId || '').trim() || null,
        details: err.details || null,
      });
      return res.status(err.statusCode || 502).json({ error: err.message });
    }
    console.error('[credits] Purchase failed:', err.message);
    return res.status(503).json({ error: 'Purchase processing failed' });
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
