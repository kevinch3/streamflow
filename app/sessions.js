const {
  cleanupExpiredZeroCreditSessions,
  createSession: createSessionInRepo,
  extractSessionIdFromPath,
  getCreditsBySessionIds,
  getSessionById,
  getSessionByStreamPath,
  getSessionByToken,
  getSessionsCount,
  getTotalCredits,
  regenerateSessionTokenForSession,
  touchSession,
} = require('./repo/sessionsRepo');

async function createSession(initialCredits, options = {}) {
  const { session, token } = await createSessionInRepo(initialCredits, options);
  return { ...session, token };
}

async function findSessionById(sessionId) {
  return getSessionById(sessionId);
}

async function findSessionByPath(streamPath) {
  return getSessionByStreamPath(streamPath);
}

async function findSessionByToken(token) {
  return getSessionByToken(token);
}

async function regenerateSessionToken(sessionOrSessionId) {
  const sessionId = typeof sessionOrSessionId === 'string'
    ? sessionOrSessionId
    : sessionOrSessionId?.id;

  if (!sessionId) {
    throw new Error('Session ID is required to rotate token');
  }

  return regenerateSessionTokenForSession(sessionId);
}

function extractPrefix(streamPath) {
  const sessionId = extractSessionIdFromPath(streamPath);
  return sessionId ? `s/${sessionId}/` : null;
}

function startSessionCleanup({ getPublishers, cleanupInactivePath }) {
  setInterval(async () => {
    const maxIdle = 24 * 60 * 60 * 1000;
    let publishers;
    try {
      publishers = await getPublishers();
    } catch {
      return;
    }

    const activePaths = new Set(publishers.map((conn) => conn.path));
    const activePrefixes = [...new Set(publishers.map((conn) => extractPrefix(conn.path)).filter(Boolean))];

    try {
      await cleanupExpiredZeroCreditSessions(maxIdle, activePrefixes);
    } catch (err) {
      console.error('[session] Cleanup query failed:', err.message);
    }

    if (typeof cleanupInactivePath === 'function') {
      cleanupInactivePath(activePaths);
    }
  }, 60 * 60 * 1000);
}

module.exports = {
  createSession,
  extractSessionIdFromPath,
  findSessionById,
  findSessionByPath,
  findSessionByToken,
  getCreditsBySessionIds,
  getSessionsCount,
  getTotalCredits,
  regenerateSessionToken,
  startSessionCleanup,
  touchSession,
};
