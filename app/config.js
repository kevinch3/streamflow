const path = require('path');
const { version: APP_VERSION } = require('./package.json');

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback) {
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const PERSISTENCE_MODE = String(process.env.PERSISTENCE_MODE || 'postgres').trim().toLowerCase();
if (PERSISTENCE_MODE !== 'postgres') {
  throw new Error(`Unsupported PERSISTENCE_MODE "${PERSISTENCE_MODE}". StreamFlow currently supports only "postgres".`);
}

const DATABASE_URL = process.env.DATABASE_URL || '';
const DATABASE_SSL = parseBoolean(process.env.DATABASE_SSL, true);
const DATABASE_STATEMENT_TIMEOUT_MS = parseInteger(process.env.DATABASE_STATEMENT_TIMEOUT_MS || '10000', 10000);

const MEDIAMTX_API = process.env.MEDIAMTX_API || 'http://mediamtx:9997';
const MEDIA_ROOT = path.join(__dirname, '..', 'html');
const MEDIAMTX_TIMEOUT = 5000;
const PUBLISH_TOKEN_TTL_MS = 10 * 60 * 1000;

const DEV_PUBLISH_TOKEN_SECRET = 'streamflow-dev-publish-token-secret';
const DEV_MEDIAMTX_AUTH_SECRET = 'streamflow-dev-mediamtx-auth-secret';

const PUBLISH_TOKEN_SECRET = process.env.PUBLISH_TOKEN_SECRET || DEV_PUBLISH_TOKEN_SECRET;
if (!process.env.PUBLISH_TOKEN_SECRET) {
  console.warn('[security] PUBLISH_TOKEN_SECRET not set — using development fallback secret');
}

const MEDIAMTX_AUTH_SECRET = process.env.MEDIAMTX_AUTH_SECRET || DEV_MEDIAMTX_AUTH_SECRET;
if (!process.env.MEDIAMTX_AUTH_SECRET) {
  console.warn('[security] MEDIAMTX_AUTH_SECRET not set — using development fallback secret');
}

const PORT = parseInt(process.env.PORT || '80', 10);

const CREDIT_PACKAGES = {
  starter: { credits: 100, label: 'Starter', price: '$ 5.00' },
  standard: { credits: 500, label: 'Standard', price: '$ 20.00' },
  pro: { credits: 2000, label: 'Pro', price: '$ 50.00' },
};

function validStreamKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(key);
}

function validSessionStreamPath(name) {
  return typeof name === 'string' && /^s\/[a-f0-9]{16}\/[A-Za-z0-9_-]{3,64}$/.test(name);
}

function validBrowserId(browserId) {
  return browserId === '' || /^[A-Za-z0-9._:-]{1,128}$/.test(browserId);
}

function normalizePath(streamPath) {
  return String(streamPath || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function extractStreamKeyFromPath(streamPath) {
  const parts = String(streamPath || '').split('/');
  return parts[2] || '';
}

function getRequestHost(req) {
  const host = req.get('x-forwarded-host') || req.get('host') || req.hostname || 'localhost';
  const ipv6 = host.match(/^\[[^\]]+\]/);
  if (ipv6) return ipv6[0];
  const idx = host.indexOf(':');
  return idx === -1 ? host : host.slice(0, idx);
}

module.exports = {
  APP_VERSION,
  CREDIT_PACKAGES,
  DATABASE_SSL,
  DATABASE_STATEMENT_TIMEOUT_MS,
  DATABASE_URL,
  MEDIA_ROOT,
  MEDIAMTX_API,
  MEDIAMTX_AUTH_SECRET,
  MEDIAMTX_TIMEOUT,
  PERSISTENCE_MODE,
  PORT,
  PUBLISH_TOKEN_SECRET,
  PUBLISH_TOKEN_TTL_MS,
  extractStreamKeyFromPath,
  getRequestHost,
  normalizePath,
  validBrowserId,
  validSessionStreamPath,
  validStreamKey,
};
