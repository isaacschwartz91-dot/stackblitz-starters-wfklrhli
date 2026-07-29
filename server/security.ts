/**
 * Passwords, sessions, one-time codes, and rate limiting.
 *
 * NFR-2: passwords are hashed with scrypt — a deliberately slow, memory-hard
 * KDF — never reversible encryption and never a bare digest.
 * NFR-4: sign-in and reset are rate limited, with a lockout staff can clear.
 */

import {
  createHash,
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

import type { Db } from './db';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// Cost parameters. N=2^15 keeps a single verification around 100ms on
// server hardware, which is the point: it makes offline cracking expensive.
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

// --- passwords ------------------------------------------------------------

/** Encodes as `scrypt$N$r$p$salt$hash` so parameters can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Constant-time verification. Returns false for any malformed record. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  const derived = await scrypt(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: SCRYPT_PARAMS.maxmem,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Burn roughly the same time as a real verification when the account does not
 * exist, so response timing does not reveal which identifiers are registered.
 */
export async function dummyVerify(): Promise<void> {
  await scrypt('no-such-account', randomBytes(16), KEY_LENGTH, SCRYPT_PARAMS);
}

// --- session tokens -------------------------------------------------------

export interface IssuedToken {
  /** Given to the client once. Never stored. */
  token: string;
  /** Stored in the sessions table. */
  tokenHash: string;
}

/**
 * A session token is 32 random bytes. Only its SHA-256 is stored, so a
 * database copy cannot be replayed as a live session.
 *
 * SHA-256 without a work factor is correct here — unlike a password, a
 * 256-bit random token has no guessable structure to attack.
 */
export function issueToken(): IssuedToken {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// --- one-time codes (FR-A3, FR-A4) ---------------------------------------

/** Six digits, uniformly random. Padded so "000123" stays six characters. */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function otpMatches(code: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashOtp(code));
  const expected = Buffer.from(storedHash);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// --- rate limiting (NFR-4) ------------------------------------------------

export interface RateLimitRule {
  /** Attempts permitted inside the window. */
  limit: number;
  windowMs: number;
}

export const SIGN_IN_RATE_LIMIT: RateLimitRule = { limit: 10, windowMs: 15 * 60 * 1000 };
export const RESET_RATE_LIMIT: RateLimitRule = { limit: 5, windowMs: 60 * 60 * 1000 };

/** Failed sign-ins before the account itself locks (NFR-4). */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

/**
 * Fixed-window counter keyed by bucket (e.g. `signin:ip:1.2.3.4`).
 * Stored in SQLite so a restart cannot be used to reset the counter.
 */
export function checkRateLimit(
  db: Db,
  bucket: string,
  rule: RateLimitRule,
  now = Date.now(),
): RateLimitResult {
  const row = db
    .prepare('SELECT count, window_start FROM rate_limits WHERE bucket = ?')
    .get(bucket) as { count: number; window_start: string } | undefined;

  const windowStart = row ? Date.parse(row.window_start) : 0;
  const expired = !row || now - windowStart >= rule.windowMs;

  if (expired) {
    db.prepare(
      `INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET count = 1, window_start = excluded.window_start`,
    ).run(bucket, new Date(now).toISOString());
    return { allowed: true, remaining: rule.limit - 1, retryAfterMs: 0 };
  }

  const count = row!.count;
  if (count >= rule.limit) {
    return { allowed: false, remaining: 0, retryAfterMs: windowStart + rule.windowMs - now };
  }

  db.prepare('UPDATE rate_limits SET count = count + 1 WHERE bucket = ?').run(bucket);
  return { allowed: true, remaining: rule.limit - count - 1, retryAfterMs: 0 };
}

/** Clears a bucket after a successful sign-in. */
export function clearRateLimit(db: Db, bucket: string): void {
  db.prepare('DELETE FROM rate_limits WHERE bucket = ?').run(bucket);
}
