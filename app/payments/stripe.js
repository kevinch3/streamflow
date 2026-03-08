const { STRIPE_SECRET_KEY, STRIPE_ENABLED } = require('../config');

const STRIPE_API_VERSION = '2025-02-24.acacia';

class StripeError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.name = 'StripeError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function assertStripeConfigured() {
  if (!STRIPE_ENABLED) throw new StripeError('Stripe is not configured on this server.', 503);
}

function getStripe() {
  assertStripeConfigured();
  // eslint-disable-next-line global-require
  const Stripe = require('stripe');
  return new Stripe(STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
}

async function createPaymentIntent({ packageName, pkg, sessionId }) {
  const stripe = getStripe();
  const pi = await stripe.paymentIntents.create({
    amount: Math.round(parseFloat(pkg.amount) * 100),
    currency: pkg.currency.toLowerCase(),
    metadata: { sid: sessionId, pkg: packageName },
    automatic_payment_methods: { enabled: true },
  });
  return { paymentIntentId: pi.id, clientSecret: pi.client_secret };
}

async function retrievePaymentIntent(paymentIntentId) {
  const stripe = getStripe();
  return stripe.paymentIntents.retrieve(paymentIntentId);
}

module.exports = { StripeError, createPaymentIntent, retrievePaymentIntent };
