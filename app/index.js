const express = require('express');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { PORT, MEDIA_ROOT } = require('./config');
const { checkDatabaseConnection, closePool } = require('./db/client');
const { startCreditDeductionInterval } = require('./credits');
const { getPublishers } = require('./mediamtx');
const { startSseBroadcastInterval } = require('./sse');
const { cleanupUnlistedStreams } = require('./streams');
const { startSessionCleanup } = require('./sessions');

const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const eventsRoutes = require('./routes/events');
const internalRoutes = require('./routes/internal');

const app = express();
app.set('trust proxy', 1);

const CSP_NONCE_COOKIE = 'sf_csp_nonce';
const CSP_NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

function parseCookieHeader(cookieHeader) {
  const source = String(cookieHeader || '');
  if (!source) return {};

  const pairs = source.split(';');
  const parsed = {};
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = decodeURIComponent(pair.slice(idx + 1).trim());
    parsed[key] = value;
  }
  return parsed;
}

function getOrCreateCspNonce(req, res) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const existing = String(cookies[CSP_NONCE_COOKIE] || '').trim();
  if (CSP_NONCE_RE.test(existing)) return existing;

  const nonce = crypto.randomBytes(18).toString('base64url');
  res.cookie(CSP_NONCE_COOKIE, nonce, {
    path: '/',
    sameSite: 'lax',
    secure: req.secure,
    httpOnly: false,
  });
  return nonce;
}

app.use((req, res, next) => {
  const isPublicPage = req.path === '/viewer.html' || req.path === '/live.html';
  const cspNonce = getOrCreateCspNonce(req, res);
  const nonceDirective = `'nonce-${cspNonce}'`;

  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          nonceDirective,
          'https://cdn.jsdelivr.net',
          'https://*.paypal.com',
          'https://*.paypalobjects.com',
          'https://js.stripe.com',
        ],
        styleSrc: ["'self'", nonceDirective],
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: [
          "'self'",
          'data:',
          'blob:',
          'https://*.paypal.com',
          'https://*.paypalobjects.com',
        ],
        mediaSrc: ['*', 'blob:'],
        connectSrc: [
          "'self'",
          '*:8888',
          'https://cdn.jsdelivr.net',
          'https://*.paypal.com',
          'https://*.paypalobjects.com',
          'https://api.stripe.com',
        ],
        scriptSrcAttr: ["'unsafe-inline'"],
        workerSrc: ["'self'", 'blob:'],
        frameSrc: ["'self'", 'https://*.paypal.com', 'https://js.stripe.com'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: isPublicPage ? ['*'] : ["'none'"],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginEmbedderPolicy: false,
  })(req, res, next);
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

app.use('/api/token', strictLimiter);
app.use('/api/credits/purchase', strictLimiter);
app.use('/api/credits/redeem', strictLimiter);
app.use('/api/publish/prepare', strictLimiter);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(MEDIA_ROOT));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use('/api', publicRoutes);
app.use('/api', adminRoutes);
app.use('/api', eventsRoutes);
app.use('/api', internalRoutes);

let server;

async function shutdown(signal) {
  console.log(`[streamflow] Received ${signal}, shutting down`);

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  await closePool();
  process.exit(0);
}

async function bootstrap() {
  await checkDatabaseConnection();
  console.log('[db] Postgres connection established');

  startCreditDeductionInterval();
  startSseBroadcastInterval();
  startSessionCleanup({
    getPublishers,
    cleanupInactivePath: cleanupUnlistedStreams,
  });

  server = app.listen(PORT, () => {
    console.log(`[streamflow] dashboard and API listening on port ${PORT}`);
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[streamflow] Startup failed:', err.message);
  process.exit(1);
});
