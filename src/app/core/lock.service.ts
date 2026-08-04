/**
 * A passcode lock for this device.
 *
 * What it does: stops someone who picks up the shop's tablet or phone from
 * reading the catalog, the customer list and the order history stored on it.
 *
 * What it does not do: it cannot keep strangers off a public web address.
 * There is no server in browser-storage mode, so a visitor who has never been
 * here has nothing to be checked against — they simply get an empty copy of
 * the app with none of the store's data in it. Keeping people out of the
 * address itself needs real accounts, which is what the Supabase option in
 * Settings provides.
 *
 * The passcode itself is never stored. Only a PBKDF2 hash and its salt are
 * kept, and only on this device.
 */

import { Injectable, computed, signal } from '@angular/core';

const LOCK_KEY = 'grocery-picker.lock';
const SESSION_KEY = 'grocery-picker.unlocked';
const ITERATIONS = 210_000;

interface StoredLock {
  salt: string;
  hash: string;
  iterations: number;
}

@Injectable({ providedIn: 'root' })
export class LockService {
  /** WebCrypto needs a secure context: https, or localhost. */
  readonly available =
    typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';

  readonly enabled = signal(readLock() !== null);
  readonly unlocked = signal(sessionStorage.getItem(SESSION_KEY) === 'yes');

  /** True when the app should show nothing but the passcode prompt. */
  readonly locked = computed(() => this.enabled() && !this.unlocked());

  async setPasscode(next: string): Promise<void> {
    if (!this.available) throw new Error('This browser cannot store a passcode securely.');
    if (next.trim().length < 4) throw new Error('Use at least 4 characters.');

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derive(next, salt, ITERATIONS);
    const stored: StoredLock = {
      salt: toBase64(salt),
      hash: toBase64(hash),
      iterations: ITERATIONS,
    };
    localStorage.setItem(LOCK_KEY, JSON.stringify(stored));
    this.enabled.set(true);
    this.markUnlocked();
  }

  async verify(passcode: string): Promise<boolean> {
    const stored = readLock();
    if (stored === null || !this.available) return false;
    const salt = fromBase64(stored.salt);
    const hash = await derive(passcode, salt, stored.iterations);
    return sameBytes(hash, fromBase64(stored.hash));
  }

  async unlock(passcode: string): Promise<boolean> {
    if (!(await this.verify(passcode))) return false;
    this.markUnlocked();
    return true;
  }

  async remove(currentPasscode: string): Promise<boolean> {
    if (!(await this.verify(currentPasscode))) return false;
    localStorage.removeItem(LOCK_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    this.enabled.set(false);
    this.unlocked.set(false);
    return true;
  }

  /** Put the lock back on without clearing the passcode. */
  lockNow(): void {
    sessionStorage.removeItem(SESSION_KEY);
    this.unlocked.set(false);
  }

  private markUnlocked(): void {
    sessionStorage.setItem(SESSION_KEY, 'yes');
    this.unlocked.set(true);
  }
}

function readLock(): StoredLock | null {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredLock>;
    if (typeof parsed.salt !== 'string' || typeof parsed.hash !== 'string') return null;
    return {
      salt: parsed.salt,
      hash: parsed.hash,
      iterations: Number(parsed.iterations) || ITERATIONS,
    };
  } catch {
    return null;
  }
}

async function derive(passcode: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passcode),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Compare without leaking how much of the hash matched. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}
