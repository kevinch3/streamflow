const {
  PAYPAL_API_BASE,
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV,
  PAYPAL_ENABLED,
} = require('../config');

class PayPalError extends Error {
  constructor(message, statusCode = 502, details = null) {
    super(message);
    this.name = 'PayPalError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function assertPaypalConfigured() {
  if (!PAYPAL_ENABLED) {
    throw new PayPalError('PayPal is not configured on this server.', 503);
  }
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new PayPalError('PayPal API request timed out.', 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken() {
  assertPaypalConfigured();

  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetchWithTimeout(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  }, 12000);

  const payload = await parseJsonSafe(response);
  if (!response.ok || !payload?.access_token) {
    const reason = payload?.error_description || payload?.error || 'Could not obtain PayPal access token';
    throw new PayPalError(reason, 502, payload);
  }

  return payload.access_token;
}

async function paypalApiFetch(path, {
  method = 'GET',
  body = null,
  accessToken,
  headers = {},
}) {
  const response = await fetchWithTimeout(`${PAYPAL_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await parseJsonSafe(response);
  if (!response.ok) {
    const detail = payload?.details?.[0]?.description || payload?.message || payload?.name || 'PayPal API request failed';
    throw new PayPalError(detail, 502, payload);
  }

  return payload;
}

function buildCheckoutNowFallbackUrl(orderId) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) return '';
  const host = PAYPAL_ENV === 'live'
    ? 'https://www.paypal.com'
    : 'https://www.sandbox.paypal.com';
  return `${host}/checkoutnow?token=${encodeURIComponent(normalizedOrderId)}`;
}

function extractPayPalApprovalUrl(orderPayload) {
  const links = Array.isArray(orderPayload?.links) ? orderPayload.links : [];
  const paypalSourceLinks = Array.isArray(orderPayload?.payment_source?.paypal?.links)
    ? orderPayload.payment_source.paypal.links
    : [];
  const allLinks = [...links, ...paypalSourceLinks];

  for (const link of allLinks) {
    const rel = String(link?.rel || '').toLowerCase();
    const href = String(link?.href || '').trim();
    if (!href) continue;
    if (rel === 'approve' || rel === 'payer-action' || rel === 'payer_action') {
      return href;
    }
  }

  return buildCheckoutNowFallbackUrl(orderPayload?.id);
}

function summarizeOrderPayload(orderPayload) {
  const topLinks = (Array.isArray(orderPayload?.links) ? orderPayload.links : [])
    .map((l) => l?.rel)
    .filter(Boolean);
  const sourceLinks = (Array.isArray(orderPayload?.payment_source?.paypal?.links)
    ? orderPayload.payment_source.paypal.links
    : [])
    .map((l) => l?.rel)
    .filter(Boolean);
  return {
    id: orderPayload?.id || null,
    status: orderPayload?.status || null,
    intent: orderPayload?.intent || null,
    links: topLinks,
    paymentSourceLinks: sourceLinks,
  };
}

function parseCaptureSummary(capturePayload) {
  const unit = capturePayload?.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  return {
    status: String(capturePayload?.status || ''),
    orderId: String(capturePayload?.id || ''),
    payerId: String(capturePayload?.payer?.payer_id || ''),
    customId: String(unit?.custom_id || ''),
    amountValue: String(capture?.amount?.value || ''),
    amountCurrency: String(capture?.amount?.currency_code || ''),
    captureId: String(capture?.id || ''),
    captureStatus: String(capture?.status || ''),
  };
}

async function createPaypalOrder({
  packageName,
  pkg,
  sessionId,
  returnUrl,
  cancelUrl,
}) {
  assertPaypalConfigured();
  const accessToken = await getAccessToken();

  const orderPayload = await paypalApiFetch('/v2/checkout/orders', {
    method: 'POST',
    accessToken,
    headers: {
      Prefer: 'return=representation',
    },
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: packageName,
          custom_id: JSON.stringify({ sid: sessionId, pkg: packageName }),
          description: `${pkg.label} credit package (${pkg.credits} credits)`,
          amount: {
            currency_code: pkg.currency,
            value: pkg.amount,
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: returnUrl,
            cancel_url: cancelUrl,
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
          },
        },
      },
    },
  });

  const approvalUrl = extractPayPalApprovalUrl(orderPayload);
  if (!approvalUrl || !orderPayload?.id) {
    console.error('[paypal] Missing approval URL in order payload', summarizeOrderPayload(orderPayload));
    throw new PayPalError(
      'PayPal did not return an approval URL. Verify PAYPAL_ENV matches your credential type (sandbox/live).',
      502,
      orderPayload,
    );
  }

  return {
    orderId: String(orderPayload.id),
    approvalUrl,
  };
}

async function capturePaypalOrder(orderId) {
  assertPaypalConfigured();
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) {
    throw new PayPalError('Missing PayPal order ID.', 400);
  }

  const accessToken = await getAccessToken();
  const payload = await paypalApiFetch(`/v2/checkout/orders/${encodeURIComponent(normalizedOrderId)}/capture`, {
    method: 'POST',
    accessToken,
    body: {},
  });

  const summary = parseCaptureSummary(payload);
  if (summary.status !== 'COMPLETED' || summary.captureStatus !== 'COMPLETED') {
    throw new PayPalError('PayPal capture was not completed.', 400, payload);
  }

  return summary;
}

module.exports = {
  PayPalError,
  assertPaypalConfigured,
  buildCheckoutNowFallbackUrl,
  capturePaypalOrder,
  createPaypalOrder,
  extractPayPalApprovalUrl,
};
