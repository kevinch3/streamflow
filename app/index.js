const express = require('express');
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

app.use((req, res, next) => {
  const isPublicPage = req.path === '/viewer.html' || req.path === '/live.html';
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          'https://cdn.jsdelivr.net',
          'https://*.paypal.com',
          'https://*.paypalobjects.com',
        ],
        styleSrc: ["'self'"],
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
          'https://*.paypal.com',
          'https://*.paypalobjects.com',
        ],
        scriptSrcAttr: ["'unsafe-inline'"],
        workerSrc: ["'self'", 'blob:'],
        frameSrc: ["'self'", 'https://*.paypal.com'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: isPublicPage ? ['*'] : ["'none'"],
      },
    },
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
