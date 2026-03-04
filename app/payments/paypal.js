const {
  PAYPAL_API_BASE,
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
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

async function getAccessToken() {
  assertPaypalConfigured();

  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const payload = await parseJsonSafe(response);
  if (!response.ok || !payload?.access_token) {
    const reason = payload?.error_description || payload?.error || 'Could not obtain PayPal access token';
    throw new PayPalError(reason, 502, payload);
  }

  return payload.access_token;
}

async function paypalApiFetch(path, { method = 'GET', body = null, accessToken }) {
  const response = await fetch(`${PAYPAL_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
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

function getApprovalUrl(orderPayload) {
  const links = Array.isArray(orderPayload?.links) ? orderPayload.links : [];
  return links.find((link) => link?.rel === 'approve')?.href || '';
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

  const approvalUrl = getApprovalUrl(orderPayload);
  if (!approvalUrl || !orderPayload?.id) {
    throw new PayPalError('PayPal did not return an approval URL.', 502, orderPayload);
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
  capturePaypalOrder,
  createPaypalOrder,
};
