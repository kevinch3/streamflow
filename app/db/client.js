const { Pool } = require('pg');
const { DATABASE_URL, DATABASE_SSL, DATABASE_STATEMENT_TIMEOUT_MS } = require('../config');

let pool = null;

function parseSslConfig() {
  if (!DATABASE_SSL) return false;
  return { rejectUnauthorized: false };
}

function getPool() {
  if (pool) return pool;

  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is required when PERSISTENCE_MODE=postgres');
  }

  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: parseSslConfig(),
    statement_timeout: DATABASE_STATEMENT_TIMEOUT_MS,
  });

  pool.on('error', (err) => {
    console.error('[db] Pool error:', err.message);
  });

  return pool;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

async function withClient(fn) {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function withTransaction(fn) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[db] Rollback failed:', rollbackErr.message);
      }
      throw err;
    }
  });
}

async function checkDatabaseConnection() {
  const result = await query('SELECT 1 AS ok');
  return result.rows[0]?.ok === 1;
}

async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

module.exports = {
  checkDatabaseConnection,
  closePool,
  getPool,
  query,
  withClient,
  withTransaction,
};
