const { validSessionStreamPath } = require('./config');
const { getPathInfo } = require('./mediamtx');
const { findSessionByPath } = require('./sessions');

const prevBytes = new Map();
const unlistedStreams = new Set();

function computeBitrate(name, bytesReceived) {
  const now = Date.now();
  const prev = prevBytes.get(name);
  prevBytes.set(name, { bytes: bytesReceived, time: now });
  if (!prev || now === prev.time) return null;
  const kbps = Math.round(((bytesReceived - prev.bytes) * 8) / ((now - prev.time) / 1000) / 1000);
  return kbps > 0 ? kbps : null;
}

function classifyQuality(bitrateKbps) {
  if (typeof bitrateKbps !== 'number' || bitrateKbps <= 0) return 'unknown';
  if (bitrateKbps >= 4500) return 'excellent';
  if (bitrateKbps >= 2500) return 'good';
  if (bitrateKbps >= 1000) return 'fair';
  return 'poor';
}

function isStreamListed(streamPath) {
  return !unlistedStreams.has(streamPath);
}

function setStreamVisibility(streamPath, listed) {
  if (!validSessionStreamPath(streamPath)) return false;
  if (listed) {
    unlistedStreams.delete(streamPath);
  } else {
    unlistedStreams.add(streamPath);
  }
  return true;
}

function cleanupUnlistedStreams(activePaths) {
  for (const streamPath of unlistedStreams) {
    if (!activePaths.has(streamPath)) unlistedStreams.delete(streamPath);
  }
}

async function buildStreamDescriptor(conn) {
  const info = await getPathInfo(conn.path);
  const uptime = info.readyTime
    ? Math.floor((Date.now() - new Date(info.readyTime).getTime()) / 1000)
    : 0;
  const bitrateKbps = computeBitrate(conn.path, conn.bytesReceived || 0);
  return {
    name: conn.path,
    uptime,
    tracks: info.tracks || [],
    bitrateKbps,
    quality: classifyQuality(bitrateKbps),
    listed: isStreamListed(conn.path),
  };
}

async function buildLivePayload(streamName, publishers, descriptorByName = null) {
  const conn = publishers.find(c => c.path === streamName);
  const ownerSession = findSessionByPath(streamName);
  const sessionCredits = ownerSession ? ownerSession.credits : 0;

  if (!conn) return { live: false, credits: sessionCredits, quality: 'unknown' };

  const stream = descriptorByName?.get(streamName) || await buildStreamDescriptor(conn);
  return {
    live: true,
    credits: sessionCredits,
    tracks: stream.tracks,
    bitrateKbps: stream.bitrateKbps,
    quality: stream.quality,
    uptime: stream.uptime,
  };
}

module.exports = {
  buildLivePayload,
  buildStreamDescriptor,
  classifyQuality,
  cleanupUnlistedStreams,
  computeBitrate,
  isStreamListed,
  setStreamVisibility,
  unlistedStreams,
};
