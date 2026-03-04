const { createHash, randomBytes } = require('crypto');
const { query, withTransaction } = require('../db/client');

function generateSessionToken() {
  return 'sf_' + randomBytes(21).toString('base64url');
}

function generateSessionId() {
  return randomBytes(8).toString('hex');
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function extractSessionIdFromPath(streamPath) {
  const match = String(streamPath || '').match(/^s\/([a-f0-9]{16})\/[A-Za-z0-9_-]{3,64}$/);
  return match ? match[1] : null;
}

function sessionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    prefix: row.prefix,
    credits: row.credits,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    lastActiveAt: new Date(row.last_active_at).getTime(),
  };
}

async function getSessionById(sessionId) {
  const result = await query(
    `SELECT id::text AS id, prefix, credits, created_at, updated_at, last_active_at
       FROM sessions
      WHERE id = $1`,
    [sessionId],
  );
  return sessionFromRow(result.rows[0]);
}

async function getSessionByToken(token) {
  const tokenHash = hashToken(token);
  const result = await query(
    `SELECT s.id::text AS id, s.prefix, s.credits, s.created_at, s.updated_at, s.last_active_at
       FROM session_tokens st
       JOIN sessions s ON s.id = st.session_id
      WHERE st.token_hash = $1`,
    [tokenHash],
  );
  return sessionFromRow(result.rows[0]);
}

async function getSessionByStreamPath(streamPath) {
  const sessionId = extractSessionIdFromPath(streamPath);
  if (!sessionId) return null;

  const session = await getSessionById(sessionId);
  if (!session) return null;
  if (!String(streamPath).startsWith(session.prefix)) return null;
  return session;
}

async function createSessionTx(client, initialCredits, {
  eventType = 'redeem',
  meta = {},
  skipInitialLedger = false,
} = {}) {
  const credits = Number.isFinite(initialCredits) ? Math.max(0, Math.floor(initialCredits)) : 0;

  for (let attempt = 0; attempt < 5; attempt++) {
    const id = generateSessionId();
    const token = generateSessionToken();
    const tokenHash = hashToken(token);
    const prefix = `s/${id}/`;

    try {
      await client.query(
        `INSERT INTO sessions (id, prefix, credits)
         VALUES ($1, $2, $3)`,
        [id, prefix, credits],
      );

      await client.query(
        `INSERT INTO session_tokens (session_id, token_hash)
         VALUES ($1, $2)`,
        [id, tokenHash],
      );

      if (!skipInitialLedger) {
        await client.query(
          `INSERT INTO credit_ledger (session_id, event_type, delta, balance_after, meta)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [id, eventType, credits, credits, JSON.stringify(meta || {})],
        );
      }

      const row = await client.query(
        `SELECT id::text AS id, prefix, credits, created_at, updated_at, last_active_at
           FROM sessions
          WHERE id = $1`,
        [id],
      );

      return { session: sessionFromRow(row.rows[0]), token };
    } catch (err) {
      if (err && err.code === '23505') continue;
      throw err;
    }
  }

  throw new Error('Failed to generate unique session identity');
}

async function createSession(initialCredits, options = {}) {
  const created = await withTransaction(async (client) => createSessionTx(client, initialCredits, options));
  console.log(`[session] Created ${created.session.id}, prefix=${created.session.prefix}, credits=${created.session.credits}`);
  return created;
}

async function regenerateSessionTokenForSession(sessionId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const newToken = generateSessionToken();
    const tokenHash = hashToken(newToken);

    try {
      const result = await query(
        `UPDATE session_tokens
            SET token_hash = $1,
                created_at = now()
          WHERE session_id = $2`,
        [tokenHash, sessionId],
      );

      if (!result.rowCount) {
        throw new Error(`Session token not found for session ${sessionId}`);
      }

      return newToken;
    } catch (err) {
      if (err && err.code === '23505') continue;
      throw err;
    }
  }

  throw new Error('Failed to rotate session token');
}

async function getTotalCredits() {
  const result = await query('SELECT COALESCE(SUM(credits), 0)::int AS total FROM sessions');
  return result.rows[0]?.total || 0;
}

async function getSessionsCount() {
  const result = await query('SELECT COUNT(*)::int AS count FROM sessions');
  return result.rows[0]?.count || 0;
}

async function getCreditsBySessionIds(sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return new Map();

  const uniqueIds = [...new Set(sessionIds.map((id) => String(id)))];
  const result = await query(
    `SELECT id::text AS id, credits
       FROM sessions
      WHERE id::text = ANY($1::text[])`,
    [uniqueIds],
  );

  const creditsBySessionId = new Map();
  for (const row of result.rows) {
    creditsBySessionId.set(row.id, row.credits);
  }
  return creditsBySessionId;
}

async function touchSession(sessionId) {
  await query(
    `UPDATE sessions
        SET last_active_at = now()
      WHERE id = $1`,
    [sessionId],
  );
}

async function cleanupExpiredZeroCreditSessions(maxIdleMs, activePrefixes = []) {
  const seconds = Math.max(0, Math.floor(maxIdleMs / 1000));
  const params = [seconds];
  let where = `
    credits = 0
    AND last_active_at < now() - ($1::text || ' seconds')::interval
  `;

  if (Array.isArray(activePrefixes) && activePrefixes.length > 0) {
    params.push(activePrefixes);
    where += ' AND NOT (prefix = ANY($2::text[]))';
  }

  const result = await query(`DELETE FROM sessions WHERE ${where}`.replace(/\s+/g, ' ').trim(), params);
  if (result.rowCount > 0) {
    console.log(`[session] Cleaned up ${result.rowCount} idle 0-credit session(s)`);
  }
  return result.rowCount;
}

module.exports = {
  cleanupExpiredZeroCreditSessions,
  createSession,
  createSessionTx,
  extractSessionIdFromPath,
  generateSessionToken,
  getCreditsBySessionIds,
  getSessionById,
  getSessionByStreamPath,
  getSessionByToken,
  getSessionsCount,
  getTotalCredits,
  hashToken,
  regenerateSessionTokenForSession,
  touchSession,
};
