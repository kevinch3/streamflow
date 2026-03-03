const { APP_VERSION } = require('./config');
const { sessions } = require('./sessions');
const { getPublishers } = require('./mediamtx');
const { buildLivePayload, buildStreamDescriptor, isStreamListed } = require('./streams');

const adminClients = new Map();
const viewerClients = new Map();
const publicClients = new Map();
const PUBLIC_SSE_MAX_TOTAL = 200;
const PUBLIC_SSE_MAX_PER_IP = 5;

let prevCpuUsage = process.cpuUsage();
let prevCpuTime = Date.now();
let cpuPercent = 0;

const sseCache = {
  streams: [],
  status: 'ok',
};

function sampleCpu() {
  const now = Date.now();
  const elapsedMs = now - prevCpuTime;
  if (elapsedMs <= 0) return;
  const cur = process.cpuUsage();
  const totalUs = (cur.user - prevCpuUsage.user) + (cur.system - prevCpuUsage.system);
  cpuPercent = Math.min(100, Math.round((totalUs / (elapsedMs * 1000)) * 100));
  prevCpuUsage = cur;
  prevCpuTime = now;
}

function buildResourcesPayload(streamCount) {
  const mem = process.memoryUsage();
  return {
    cpuPercent,
    memRssMb: Math.round(mem.rss / 1048576),
    memHeapMb: Math.round(mem.heapUsed / 1048576),
    memHeapTotalMb: Math.round(mem.heapTotal / 1048576),
    connections: {
      admin: adminClients.size,
      viewer: [...viewerClients.values()].reduce((n, s) => n + s.size, 0),
      public: publicClients.size,
    },
    sessions: sessions.size,
    streams: streamCount,
  };
}

function buildAdminPayload(allStreams, clientInfo, status = 'ok', resources = null) {
  const streams = clientInfo.isSuperAdmin
    ? allStreams
    : allStreams.filter(s => s.name.startsWith(clientInfo.session.prefix));

  let sessionCredits;
  if (clientInfo.isSuperAdmin) {
    sessionCredits = 0;
    for (const s of sessions.values()) sessionCredits += s.credits;
  } else {
    sessionCredits = clientInfo.session.credits;
  }

  return {
    streams,
    credits: sessionCredits,
    prefix: clientInfo.isSuperAdmin ? null : clientInfo.session.prefix,
    status,
    uptime: Math.floor(process.uptime()),
    version: APP_VERSION,
    resources,
  };
}

function buildPublicPayload(allStreams, status = 'ok') {
  return {
    streams: allStreams.filter(s => isStreamListed(s.name)),
    status,
    uptime: Math.floor(process.uptime()),
  };
}

function startSseBroadcastInterval() {
  setInterval(async () => {
    const hasClients = adminClients.size > 0 || viewerClients.size > 0 || publicClients.size > 0;
    if (!hasClients) return;

    try {
      sampleCpu();
      const publishers = await getPublishers();
      const resources = buildResourcesPayload(publishers.length);
      const allStreams = await Promise.all(publishers.map(conn => buildStreamDescriptor(conn)));

      sseCache.streams = allStreams;
      sseCache.status = 'ok';

      const descriptorByName = new Map(allStreams.map(s => [s.name, s]));

      if (adminClients.size > 0) {
        for (const [res, clientInfo] of adminClients) {
          const payload = buildAdminPayload(allStreams, clientInfo, 'ok', resources);
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      }

      if (publicClients.size > 0) {
        const payload = `data: ${JSON.stringify(buildPublicPayload(allStreams, 'ok'))}\n\n`;
        for (const res of publicClients.keys()) res.write(payload);
      }

      for (const [name, clients] of viewerClients) {
        if (!clients.size) continue;
        const payload = await buildLivePayload(name, publishers, descriptorByName);
        const msg = `data: ${JSON.stringify(payload)}\n\n`;
        for (const res of clients) res.write(msg);
      }
    } catch {
      sseCache.streams = [];
      sseCache.status = 'error';

      if (adminClients.size > 0) {
        for (const [res, clientInfo] of adminClients) {
          const payload = buildAdminPayload([], clientInfo, 'error');
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      }

      if (publicClients.size > 0) {
        const payload = `data: ${JSON.stringify(buildPublicPayload([], 'error'))}\n\n`;
        for (const res of publicClients.keys()) res.write(payload);
      }
    }
  }, 3000);
}

module.exports = {
  PUBLIC_SSE_MAX_PER_IP,
  PUBLIC_SSE_MAX_TOTAL,
  adminClients,
  buildAdminPayload,
  buildPublicPayload,
  buildResourcesPayload,
  publicClients,
  sseCache,
  startSseBroadcastInterval,
  viewerClients,
};
