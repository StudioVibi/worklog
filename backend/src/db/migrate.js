const fs = require('fs/promises');
const path = require('path');
const { pool } = require('./pool');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getMigrationFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.sql'))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function alreadyApplied(client, name) {
  const result = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [name]);
  return result.rowCount > 0;
}

async function applyMigration(client, migrationsDir, name) {
  const fullPath = path.join(migrationsDir, name);
  const sql = await fs.readFile(fullPath, 'utf8');

  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [name]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const files = await getMigrationFiles(migrationsDir);

    for (const file of files) {
      const isDone = await alreadyApplied(client, file);
      if (isDone) {
        console.log(`[migrate] skipping ${file}`);
        continue;
      }

      console.log(`[migrate] applying ${file}`);
      await applyMigration(client, migrationsDir, file);
      console.log(`[migrate] applied ${file}`);
    }

    console.log('[migrate] complete');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] failed', err);
  process.exitCode = 1;
});
