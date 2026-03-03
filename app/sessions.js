const { randomBytes } = require('crypto');

const sessions = new Map();

function generateSessionToken() {
  return 'sf_' + randomBytes(21).toString('base64url');
}

function createSession(initialCredits) {
  const id = randomBytes(8).toString('hex');
  const sessionToken = generateSessionToken();
  const prefix = `s/${id}/`;
  const session = { id, token: sessionToken, credits: initialCredits, prefix, createdAt: Date.now() };
  sessions.set(sessionToken, session);
  console.log(`[session] Created ${id}, prefix=${prefix}, credits=${initialCredits}`);
  return session;
}

function findSessionByPath(streamPath) {
  for (const session of sessions.values()) {
    if (streamPath.startsWith(session.prefix)) return session;
  }
  return null;
}

function findSessionById(sessionId) {
  for (const session of sessions.values()) {
    if (session.id === sessionId) return session;
  }
  return null;
}

function regenerateSessionToken(session) {
  const oldToken = session.token;
  const newToken = generateSessionToken();
  session.token = newToken;
  sessions.delete(oldToken);
  sessions.set(newToken, session);
  return newToken;
}

function startSessionCleanup({ getPublishers, cleanupInactivePath }) {
  setInterval(async () => {
    const now = Date.now();
    const maxIdle = 24 * 60 * 60 * 1000;
    let publishers;
    try {
      publishers = await getPublishers();
    } catch {
      return;
    }

    const activePaths = new Set(publishers.map(c => c.path));
    for (const [tok, session] of sessions) {
      if (session.credits > 0) continue;
      const hasStreams = publishers.some(c => c.path.startsWith(session.prefix));
      if (hasStreams) continue;
      if (now - session.createdAt > maxIdle) {
        sessions.delete(tok);
        console.log(`[session] Cleaned up idle session ${session.id}`);
      }
    }

    if (typeof cleanupInactivePath === 'function') {
      cleanupInactivePath(activePaths);
    }
  }, 60 * 60 * 1000);
}

module.exports = {
  sessions,
  createSession,
  findSessionById,
  findSessionByPath,
  generateSessionToken,
  regenerateSessionToken,
  startSessionCleanup,
};
