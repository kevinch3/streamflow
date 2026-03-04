const { query } = require('../db/client');

function clampLimit(limit, fallback = 50) {
  const parsed = parseInt(String(limit), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(200, Math.max(1, parsed));
}

function mapLedgerRow(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    eventType: row.event_type,
    delta: row.delta,
    balanceAfter: row.balance_after,
    meta: row.meta || {},
    createdAt: row.created_at,
  };
}

async function listCreditHistory({ sessionId = null, limit = 50 } = {}) {
  const cappedLimit = clampLimit(limit);

  if (sessionId) {
    const result = await query(
      `SELECT id, session_id::text AS session_id, event_type, delta, balance_after, meta, created_at
         FROM credit_ledger
        WHERE session_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [sessionId, cappedLimit],
    );
    return result.rows.map(mapLedgerRow);
  }

  const result = await query(
    `SELECT id, session_id::text AS session_id, event_type, delta, balance_after, meta, created_at
       FROM credit_ledger
      ORDER BY created_at DESC
      LIMIT $1`,
    [cappedLimit],
  );

  return result.rows.map(mapLedgerRow);
}

module.exports = {
  clampLimit,
  listCreditHistory,
};
