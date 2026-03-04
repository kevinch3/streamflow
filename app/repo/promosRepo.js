const { withTransaction } = require('../db/client');
const { applyCreditDeltaTx } = require('./creditsRepo');
const { createSessionTx } = require('./sessionsRepo');

class PromoRedeemError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PromoRedeemError';
    this.code = code;
  }
}

function normalizePromoCode(code) {
  return String(code || '').trim().toUpperCase();
}

function isPromoRedeemError(err, code = null) {
  if (!err || err.name !== 'PromoRedeemError') return false;
  return code ? err.code === code : true;
}

function toPromoDto(row) {
  if (!row) return null;
  return {
    code: row.code,
    label: row.label,
    credits: row.credits,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    active: row.active,
  };
}

async function getPromoByCodeTx(client, code) {
  const normalizedCode = normalizePromoCode(code);
  const result = await client.query(
    `SELECT code, label, credits, max_uses, used_count, active
       FROM promo_codes
      WHERE code = $1
      FOR UPDATE`,
    [normalizedCode],
  );
  return toPromoDto(result.rows[0]);
}

async function redeemPromoForSessionTx(client, { sessionId, code }) {
  const normalizedCode = normalizePromoCode(code);
  if (!normalizedCode) {
    throw new PromoRedeemError('invalid_promo_code', 'Invalid promo code');
  }

  const promo = await getPromoByCodeTx(client, normalizedCode);
  if (!promo || !promo.active) {
    throw new PromoRedeemError('invalid_promo_code', 'Invalid promo code');
  }

  try {
    await client.query(
      `INSERT INTO promo_redemptions (code, session_id, credits_applied)
       VALUES ($1, $2, $3)`,
      [promo.code, sessionId, promo.credits],
    );
  } catch (err) {
    if (err && err.code === '23505') {
      throw new PromoRedeemError('promo_already_used', 'Promo code already used');
    }
    if (err && err.code === '23503') {
      throw new PromoRedeemError('session_not_found', 'Session not found');
    }
    throw err;
  }

  if (promo.usedCount >= promo.maxUses) {
    throw new PromoRedeemError('promo_exhausted', 'Promo code already used');
  }

  await client.query(
    `UPDATE promo_codes
        SET used_count = used_count + 1
      WHERE code = $1`,
    [promo.code],
  );

  const mutation = await applyCreditDeltaTx(client, {
    sessionId,
    delta: promo.credits,
    eventType: 'redeem',
    meta: { code: promo.code, label: promo.label },
    allowZeroDeltaLedger: true,
  });

  if (!mutation) {
    throw new PromoRedeemError('session_not_found', 'Session not found');
  }

  return {
    promo,
    mutation,
  };
}

async function redeemPromoForSession(sessionId, code) {
  return withTransaction(async (client) => redeemPromoForSessionTx(client, { sessionId, code }));
}

async function createSessionWithPromo(code) {
  return withTransaction(async (client) => {
    const created = await createSessionTx(client, 0, {
      eventType: 'admin_adjust',
      skipInitialLedger: true,
    });

    const redemption = await redeemPromoForSessionTx(client, {
      sessionId: created.session.id,
      code,
    });

    const session = {
      ...created.session,
      credits: redemption.mutation.credits,
    };

    return {
      session,
      token: created.token,
      promo: redemption.promo,
      mutation: redemption.mutation,
    };
  });
}

module.exports = {
  PromoRedeemError,
  createSessionWithPromo,
  isPromoRedeemError,
  normalizePromoCode,
  redeemPromoForSession,
};
