import pg from 'pg';
import { config } from '../config.js';

const { Pool, types } = pg;

// node-postgres returns numeric/int8 as strings to avoid precision loss. Counts
// and money-free integers in this schema are well inside Number.MAX_SAFE_INTEGER,
// so parse int8 (OID 20) back to a number for clean JSON output.
types.setTypeParser(20, (value) => Number.parseInt(value, 10));

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
  application_name: 'delivery-tracking-api',
});

// An idle client dying (DB restart, network blip) emits on the pool. Without a
// listener this is an unhandled 'error' event and takes the process down.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Runs `fn` inside a transaction, passing it a dedicated client.
 * Commits on resolve, rolls back on throw, and always releases the client.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  let released = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // A failed ROLLBACK leaves the connection in an aborted transaction.
      // Release it with the error so the pool discards it instead of handing a
      // poisoned client to the next caller.
      released = true;
      client.release(rollbackErr);
    }
    throw err;
  } finally {
    if (!released) client.release();
  }
}

export async function closePool() {
  await pool.end();
}
