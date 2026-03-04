const { query, withTransaction } = require('../db/client');

function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  return meta;
}

function normalizeInt(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

function computeNextBalance(current, requestedDelta) {
  const next = Math.max(0, current + requestedDelta);
  return {
    next,
    appliedDelta: next - current,
  };
}

async function applyCreditDeltaTx(client, {
  sessionId,
  delta,
  eventType,
  meta = {},
  allowZeroDeltaLedger = false,
}) {
  const requestedDelta = normalizeInt(delta);
  if (!sessionId) throw new Error('sessionId is required');
  if (!eventType) throw new Error('eventType is required');

  const sessionResult = await client.query(
    `SELECT id::text AS id, prefix, credits
       FROM sessions
      WHERE id = $1
      FOR UPDATE`,
    [sessionId],
  );

  if (!sessionResult.rowCount) {
    return null;
  }

  const current = sessionResult.rows[0].credits;
  const { next, appliedDelta } = computeNextBalance(current, requestedDelta);

  await client.query(
    `UPDATE sessions
        SET credits = $1,
            last_active_at = now()
      WHERE id = $2`,
    [next, sessionId],
  );

  if (appliedDelta !== 0 || allowZeroDeltaLedger) {
    await client.query(
      `INSERT INTO credit_ledger (session_id, event_type, delta, balance_after, meta)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [sessionId, eventType, appliedDelta, next, JSON.stringify(normalizeMeta(meta))],
    );
  }

  return {
    sessionId,
    prefix: sessionResult.rows[0].prefix,
    previousCredits: current,
    credits: next,
    requestedDelta,
    delta: appliedDelta,
  };
}

async function applyCreditDelta({
  sessionId,
  delta,
  eventType,
  meta = {},
  allowZeroDeltaLedger = false,
}) {
  return withTransaction(async (client) => applyCreditDeltaTx(client, {
    sessionId,
    delta,
    eventType,
    meta,
    allowZeroDeltaLedger,
  }));
}

async function addCredits(sessionId, amount, { eventType = 'purchase', meta = {} } = {}) {
  const normalizedAmount = Math.abs(normalizeInt(amount));
  return applyCreditDelta({
    sessionId,
    delta: normalizedAmount,
    eventType,
    meta,
    allowZeroDeltaLedger: true,
  });
}

async function deductCredits(sessionId, amount, { eventType = 'burn', meta = {} } = {}) {
  const normalizedAmount = Math.abs(normalizeInt(amount));
  return applyCreditDelta({
    sessionId,
    delta: -normalizedAmount,
    eventType,
    meta,
    allowZeroDeltaLedger: false,
  });
}

async function getCreditsBySessionId(sessionId) {
  const result = await query('SELECT credits FROM sessions WHERE id = $1', [sessionId]);
  if (!result.rowCount) return null;
  return result.rows[0].credits;
}

module.exports = {
  addCredits,
  applyCreditDelta,
  applyCreditDeltaTx,
  computeNextBalance,
  deductCredits,
  getCreditsBySessionId,
};
