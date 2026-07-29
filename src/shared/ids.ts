/** Identifier and hashing helpers. */

/** Prefixed, sortable-ish unique id. Uses crypto when available. */
export function newId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

/**
 * SHA-256 hex digest, used for the admin passcode (NFR-2/NFR-3).
 *
 * A passcode is a shared secret for role separation, not an account
 * credential. It is hashed so a copy of the local database does not hand
 * over the store's passcode in plain text. If real per-user credentials are
 * required — which NFR-2 calls for the moment any identifying member data is
 * stored — that belongs on a server, not here.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stable per-device id for the concurrent-edit warning (section 5). */
export function deviceId(): string {
  const KEY = 'scn.deviceId';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const created = newId('device');
    localStorage.setItem(KEY, created);
    return created;
  } catch {
    return newId('device');
  }
}
