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

/**
 * Node 22.6+ is required: the server uses node:sqlite and relies on Node
 * stripping TypeScript types itself. On an older runtime the failure is a
 * cryptic "Cannot find module 'node:sqlite'", so say it plainly instead.
 */
const [major, minor] = process.versions.node.split('.').map(Number);
if ((major ?? 0) < 22 || ((major ?? 0) === 22 && (minor ?? 0) < 6)) {
  console.error(
    `\nThis app needs Node 22.6 or newer. You are running ${process.versions.node}.\n\n` +
      'Install a newer Node (https://nodejs.org) and try again.\n' +
      'If you use nvm:  nvm install 22 && nvm use 22\n',
  );
  process.exit(1);
}

const PORT = Number(process.env['PORT'] ?? 4000);
const DB_PATH = process.env['DB_PATH'] ?? resolve('data/scn.sqlite');
const STATIC_DIR = process.env['STATIC_DIR'] ?? resolve('dist/demo/browser');
const SECURE_COOKIES = process.env['SECURE_COOKIES'] === '1';
const OTP_DELIVERY_WEBHOOK_URL = process.env['OTP_DELIVERY_WEBHOOK_URL'];
const IS_PRODUCTION = process.env['NODE_ENV'] === 'production';

function requiredProductionSecret(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 32) {
    throw new Error(`${name} must be set to a random 32+ character secret in production.`);
  }
  return value;
}

async function main(): Promise<void> {
  const auditKey = IS_PRODUCTION
    ? requiredProductionSecret('AUDIT_SIGNING_KEY')
    : process.env['AUDIT_SIGNING_KEY'];
  if (IS_PRODUCTION && (!process.env['OTP_PEPPER'] || process.env['OTP_PEPPER']!.length < 32)) {
    throw new Error('OTP_PEPPER must be set to a random 32+ character secret in production.');
  }
  if (IS_PRODUCTION && !OTP_DELIVERY_WEBHOOK_URL) {
    throw new Error('OTP_DELIVERY_WEBHOOK_URL is required in production.');
  }
  if (IS_PRODUCTION && (!process.env['ADMIN_EMAIL'] || !process.env['ADMIN_PASSWORD'])) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required in production.');
  }

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
    auditKey,
    /** A vetted mail/SMS service receives codes through a server-side webhook. */
    deliverCode: async (to, code, purpose) => {
      if (OTP_DELIVERY_WEBHOOK_URL) {
        const response = await fetch(OTP_DELIVERY_WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(process.env['OTP_DELIVERY_WEBHOOK_TOKEN']
              ? { authorization: `Bearer ${process.env['OTP_DELIVERY_WEBHOOK_TOKEN']}` }
              : {}),
          },
          body: JSON.stringify({ to, code, purpose, expiresInSeconds: 600 }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`OTP delivery webhook returned ${response.status}.`);
        return;
      }
      if (process.env['DEV_OTP_LOGGING'] === '1' && !IS_PRODUCTION) {
        const target = to.email ?? to.phone ?? 'unknown';
        console.log(`[development-only] ${purpose} code for ${target}: ${code}`);
        return;
      }
      throw new Error('OTP delivery is not configured.');
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
