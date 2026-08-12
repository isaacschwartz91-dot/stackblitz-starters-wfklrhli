import { createApp } from './app.js';
import { assertProductionReady, config } from './config.js';
import { closePool, pool } from './db/pool.js';

assertProductionReady();

const app = createApp();

// Fail fast on a bad DATABASE_URL rather than serving 500s on every request.
try {
  const { rows } = await pool.query('SELECT current_database() AS db');
  console.log(`[db] connected to ${rows[0].db}`);
} catch (err) {
  console.error(`[db] could not connect: ${err.message}`);
  console.error('     Check DATABASE_URL, then run: npm run migrate');
  process.exit(1);
}

const server = app.listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port} (${config.env})`);
});

async function shutdown(signal) {
  console.log(`\n[api] ${signal} received, shutting down`);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  // Don't let an in-flight request hold the process open forever.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
