/**
 * Database (spec section 4, section 8).
 *
 * SQLite via Node's built-in `node:sqlite`, so the API has zero npm
 * dependencies — nothing in the supply chain sits between this store's
 * Medicaid data and the runtime.
 *
 * Money is INTEGER cents. Servings are INTEGER quarter-servings. Nothing
 * numeric that feeds a compliance decision is stored as REAL.
 */

import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id                TEXT PRIMARY KEY,
  role              TEXT NOT NULL CHECK (role IN ('customer','staff','admin')),
  email             TEXT UNIQUE,
  phone             TEXT UNIQUE,
  display_name      TEXT NOT NULL DEFAULT '',
  password_hash     TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  last_login_at     TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL,
  -- NFR-4: lockout after repeated failures, clearable by staff.
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,   -- SHA-256 of the bearer token
  account_id           TEXT NOT NULL REFERENCES accounts(id),
  issued_at            TEXT NOT NULL,
  expires_at           TEXT NOT NULL,
  revoked_at           TEXT,
  acting_as_account_id TEXT REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

-- FR-A3/FR-A4: one-time codes for passwordless sign-in and password reset.
CREATE TABLE IF NOT EXISTS otp_codes (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  code_hash    TEXT NOT NULL,
  purpose      TEXT NOT NULL CHECK (purpose IN ('sign_in','password_reset')),
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_account ON otp_codes(account_id, purpose);

-- NFR-4: rate limiting for sign-in and reset, durable across restarts.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  unit_label  TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS profiles (
  id                        TEXT PRIMARY KEY,
  family_id                 TEXT NOT NULL,
  version                   INTEGER NOT NULL,
  name                      TEXT NOT NULL,
  scn_name                  TEXT NOT NULL DEFAULT '',
  effective_from            TEXT NOT NULL,
  effective_to              TEXT,
  days_covered              INTEGER NOT NULL,
  cap_amount_cents          INTEGER NOT NULL,
  cap_basis                 TEXT NOT NULL CHECK (cap_basis IN ('per_member','per_order')),
  requirements_json         TEXT NOT NULL,
  meal_splits_json          TEXT NOT NULL,
  allow_non_creditable      INTEGER NOT NULL DEFAULT 1,
  shelf_life_horizons_json  TEXT NOT NULL,
  archived                  INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL,
  UNIQUE (family_id, version)
);

CREATE TABLE IF NOT EXISTS items (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  name_es                  TEXT NOT NULL DEFAULT '',
  package_size             TEXT NOT NULL DEFAULT '',
  category_key             TEXT NOT NULL,
  price_cents              INTEGER NOT NULL,
  servings_per_package_units INTEGER NOT NULL,
  sku                      TEXT NOT NULL DEFAULT '',
  upc                      TEXT NOT NULL DEFAULT '',
  tags_json                TEXT NOT NULL DEFAULT '[]',
  shelf_life_class         TEXT NOT NULL DEFAULT 'shelf_stable',
  active                   INTEGER NOT NULL DEFAULT 1,
  updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category_key);
CREATE INDEX IF NOT EXISTS idx_items_upc ON items(upc);

CREATE TABLE IF NOT EXISTS households (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  referral_id      TEXT NOT NULL,
  member_count     INTEGER NOT NULL,
  profile_id       TEXT NOT NULL,
  profile_version  INTEGER NOT NULL,
  period_start     TEXT NOT NULL,
  restrictions_json TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_households_account ON households(account_id);

CREATE TABLE IF NOT EXISTS orders (
  id                   TEXT PRIMARY KEY,
  household_id         TEXT NOT NULL REFERENCES households(id),
  status               TEXT NOT NULL CHECK (status IN ('draft','final','void')),
  rules_snapshot_json  TEXT NOT NULL,
  lines_json           TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  finalized_at         TEXT,
  staff_initials       TEXT NOT NULL DEFAULT '',
  override_json        TEXT,
  total_cents          INTEGER NOT NULL DEFAULT 0,
  category_totals_json TEXT NOT NULL DEFAULT '{}',
  revision             INTEGER NOT NULL DEFAULT 1,
  last_writer_id       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_orders_household ON orders(household_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS meal_plans (
  id                 TEXT PRIMARY KEY,
  order_id           TEXT NOT NULL REFERENCES orders(id),
  generated_at       TEXT NOT NULL,
  seed               INTEGER NOT NULL,
  days_json          TEXT NOT NULL,
  unused_json        TEXT NOT NULL DEFAULT '[]',
  stale              INTEGER NOT NULL DEFAULT 0,
  source_lines_hash  TEXT NOT NULL,
  complete           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_plans_order ON meal_plans(order_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id                      TEXT PRIMARY KEY,
  order_id                TEXT,
  actor                   TEXT NOT NULL,
  actor_account_id        TEXT,
  on_behalf_of_account_id TEXT,
  action                  TEXT NOT NULL,
  detail_json             TEXT NOT NULL DEFAULT '{}',
  at                      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at);
CREATE INDEX IF NOT EXISTS idx_audit_order ON audit_events(order_id);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
`;

export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/** Run a function inside a transaction, rolling back on any throw. */
export function transact<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
