/**
 * Minimal forward-only SQL migration runner.
 *
 *   node src/db/migrate.js up      apply pending migrations
 *   node src/db/migrate.js status  list applied / pending
 *
 * Each file in migrations/ is applied once, inside a transaction, and recorded
 * with a checksum. Editing an already-applied file is treated as an error:
 * databases that ran the old text would silently diverge from the repo.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool, closePool } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    name       text        NOT NULL,
    checksum   text        NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

function checksum(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

async function loadMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((name) => name.endsWith('.sql')).sort();

  return Promise.all(
    files.map(async (filename) => {
      const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
      const version = filename.split('_')[0];
      return { version, name: filename, sql, checksum: checksum(sql) };
    }),
  );
}

async function loadAppliedMigrations(client) {
  await client.query(CREATE_MIGRATIONS_TABLE);
  const { rows } = await client.query(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.map((row) => [row.version, row]));
}

function assertNoDrift(migrations, applied) {
  for (const migration of migrations) {
    const record = applied.get(migration.version);
    if (record && record.checksum !== migration.checksum) {
      throw new Error(
        `Migration ${migration.name} changed after it was applied. ` +
          'Add a new migration instead of editing an applied one.',
      );
    }
  }
}

export async function up() {
  const migrations = await loadMigrationFiles();
  const client = await pool.connect();

  try {
    const applied = await loadAppliedMigrations(client);
    assertNoDrift(migrations, applied);

    const pending = migrations.filter((m) => !applied.has(m.version));
    if (pending.length === 0) {
      console.log('No pending migrations.');
      return [];
    }

    for (const migration of pending) {
      process.stdout.write(`Applying ${migration.name} ... `);
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        console.log('ok');
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('failed');
        throw err;
      }
    }

    return pending.map((m) => m.name);
  } finally {
    client.release();
  }
}

export async function status() {
  const migrations = await loadMigrationFiles();
  const client = await pool.connect();
  try {
    const applied = await loadAppliedMigrations(client);
    assertNoDrift(migrations, applied);
    for (const migration of migrations) {
      const record = applied.get(migration.version);
      const state = record
        ? `applied ${new Date(record.applied_at).toISOString()}`
        : 'pending';
      console.log(`${migration.name.padEnd(32)} ${state}`);
    }
  } finally {
    client.release();
  }
}

// Only run as a CLI when invoked directly, so tests can import `up()`.
const invokedDirectly = process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const command = process.argv[2] ?? 'up';
  const commands = { up, status };

  if (!commands[command]) {
    console.error(`Unknown command "${command}". Expected one of: ${Object.keys(commands).join(', ')}`);
    process.exit(1);
  }

  try {
    await commands[command]();
  } catch (err) {
    console.error(`\nMigration ${command} failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
