const fs = require('fs/promises');
const path = require('path');
const { withTransaction, closePool } = require('./client');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedVersions(client) {
  const result = await client.query('SELECT version FROM schema_migrations');
  return new Set(result.rows.map((row) => row.version));
}

async function getMigrationFiles() {
  const entries = await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

async function applyMigration(version, sql) {
  await withTransaction(async (client) => {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
  });
}

async function migrate() {
  await withTransaction(async (client) => {
    await ensureMigrationsTable(client);
  });

  const files = await getMigrationFiles();
  if (!files.length) {
    console.log('[db:migrate] No migration files found');
    return;
  }

  const applied = await withTransaction(async (client) => getAppliedVersions(client));

  for (const version of files) {
    if (applied.has(version)) {
      console.log(`[db:migrate] Skipping ${version} (already applied)`);
      continue;
    }

    const filepath = path.join(MIGRATIONS_DIR, version);
    const sql = await fs.readFile(filepath, 'utf8');
    await applyMigration(version, sql);
    console.log(`[db:migrate] Applied ${version}`);
  }

  console.log('[db:migrate] Complete');
}

migrate()
  .catch((err) => {
    console.error('[db:migrate] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
