const { MEDIAMTX_API, MEDIAMTX_TIMEOUT } = require('./config');

async function mtxFetch(urlPath, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MEDIAMTX_TIMEOUT);
  try {
    return await fetch(`${MEDIAMTX_API}${urlPath}`, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getPublishers() {
  const publishers = [];
  const rtmp = await mtxFetch('/v3/rtmpconns/list');
  const seen = new Set();
  for (const c of (await rtmp.json()).items || []) {
    if (c.state === 'publish' && !seen.has(c.path)) {
      seen.add(c.path);
      publishers.push(c);
    }
  }
  return publishers;
}

async function getPathInfo(name) {
  try {
    const r = await mtxFetch(`/v3/paths/get/${encodeURIComponent(name)}`);
    if (r.ok) return await r.json();
  } catch {
    // ignore
  }
  return {};
}

function kickUrl(conn) {
  return `/v3/rtmpconns/kick/${conn.id}`;
}

module.exports = {
  getPathInfo,
  getPublishers,
  kickUrl,
  mtxFetch,
};
