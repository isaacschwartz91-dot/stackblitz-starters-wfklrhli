/**
 * Server entry point.
 *
 * Run with:  npm run serve:api
 * Env:  PORT, DB_PATH, STATIC_DIR, SECURE_COOKIES, ADMIN_EMAIL, ADMIN_PASSWORD
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { openDatabase } from './db';
import { bootstrap } from './bootstrap';
import { createApiServer } from './http';
import type { ApiContext } from './api';

const PORT = Number(process.env['PORT'] ?? 4000);
const DB_PATH = process.env['DB_PATH'] ?? resolve('data/scn.sqlite');
const STATIC_DIR = process.env['STATIC_DIR'] ?? resolve('dist/demo/browser');
const SECURE_COOKIES = process.env['SECURE_COOKIES'] === '1';

async function main(): Promise<void> {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = openDatabase(DB_PATH);

  const setup = await bootstrap(db, {
    adminEmail: process.env['ADMIN_EMAIL'] ?? null,
    adminPassword: process.env['ADMIN_PASSWORD'] ?? null,
  });

  if (setup.seededCatalog) {
    console.log('[setup] Seeded categories, one example program profile, and a starter catalog.');
    console.log('[setup] Replace the profile with the real SCN contract terms before live use.');
  }
  if (setup.adminCreated) {
    console.log(`[setup] Created the first admin account: ${setup.adminEmail}`);
    if (setup.generatedPassword) {
      console.log(`[setup] Temporary password: ${setup.generatedPassword}`);
      console.log('[setup] Sign in and change it now. It will not be shown again.');
    }
  }

  const ctx: ApiContext = {
    db,
    now: () => Date.now(),
    /**
     * FR-A3/FR-A4 (DECIDE): one-time codes for passwordless sign-in and
     * password reset. This transport prints the code to the server log so the
     * flow is complete and testable end to end. Wire a real email/SMS
     * provider before the tool handles live member data — until then, staff
     * hand the code over at the counter.
     */
    deliverCode: (to, code, purpose) => {
      const target = to.email ?? to.phone ?? 'unknown';
      console.log(`[code] ${purpose} code for ${target}: ${code} (expires in 10 minutes)`);
    },
  };

  const server = createApiServer({ ctx, staticDir: STATIC_DIR, secureCookies: SECURE_COOKIES });

  server.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    console.log(`[server] database: ${DB_PATH}`);
    console.log(`[server] serving client from: ${STATIC_DIR}`);
  });

  const shutdown = () => {
    console.log('\n[server] shutting down');
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error('[server] failed to start', error);
  process.exit(1);
});
