/**
 * First-run setup.
 *
 * Seeds the categories, one example program profile, and a starter catalog,
 * then creates the initial admin account. FR-A1 forbids open self-
 * registration, so every other account is created by an authenticated
 * staff member — which means exactly one account has to be bootstrapped here.
 */

import { randomBytes } from 'node:crypto';

import { SEED_CATEGORIES, seedItems, seedProfile } from '../src/shared/seed';
import { newId } from '../src/shared/ids';
import type { Db } from './db';
import { transact } from './db';
import * as repo from './repo';
import { hashPassword } from './security';

export interface BootstrapResult {
  seededCatalog: boolean;
  adminCreated: boolean;
  adminEmail: string | null;
  /** Only returned when this run generated it, so it can be shown once. */
  generatedPassword: string | null;
}

export interface BootstrapOptions {
  adminEmail?: string | null;
  adminPassword?: string | null;
  /** Skip the example catalog, for a store loading its own CSV first. */
  skipCatalog?: boolean;
}

export async function bootstrap(db: Db, options: BootstrapOptions = {}): Promise<BootstrapResult> {
  const result: BootstrapResult = {
    seededCatalog: false,
    adminCreated: false,
    adminEmail: null,
    generatedPassword: null,
  };

  const categoryCount = (
    db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }
  ).n;

  if (categoryCount === 0 && !options.skipCatalog) {
    const profile = seedProfile();
    const items = seedItems();
    transact(db, () => {
      for (const category of SEED_CATEGORIES) repo.upsertCategory(db, category);
      repo.upsertProfile(db, profile);
      for (const item of items) repo.upsertItem(db, item);
    });
    result.seededCatalog = true;
  }

  const adminCount = (
    db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin'").get() as { n: number }
  ).n;

  if (adminCount === 0) {
    const email = options.adminEmail?.trim() || 'admin@store.local';
    // A generated password beats a shipped default nobody ever changes.
    const password = options.adminPassword?.trim() || randomBytes(12).toString('base64url');

    db.prepare(
      `INSERT INTO accounts (id, role, email, phone, display_name, password_hash, status,
        last_login_at, created_by, created_at, failed_attempts, locked_until)
       VALUES (?, 'admin', ?, NULL, 'Store administrator', ?, 'active', NULL, 'bootstrap', ?, 0, NULL)`,
    ).run(newId('acct'), email, await hashPassword(password), new Date().toISOString());

    result.adminCreated = true;
    result.adminEmail = email;
    result.generatedPassword = options.adminPassword ? null : password;
  }

  return result;
}
