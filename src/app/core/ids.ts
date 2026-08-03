/** Id helpers. */

/** Random id for rows the store creates (orders, customers, aliases). */
export function newId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${random}`;
}

/**
 * Stable id derived from a product's identifying text.
 *
 * Used when the uploaded sheet has no id column: the same product must land on
 * the same id every time the sheet is re-uploaded, otherwise every import
 * would duplicate the catalog.
 */
export function stableId(...parts: string[]): string {
  const source = parts
    .map((part) => String(part ?? '').trim().toLowerCase())
    .filter((part) => part !== '')
    .join('|');

  // FNV-1a, doubled with a second offset basis to keep collisions unlikely.
  let hashA = 0x811c9dc5;
  let hashB = 0x01000193;
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    hashA = Math.imul(hashA ^ code, 0x01000193) >>> 0;
    hashB = Math.imul(hashB ^ code, 0x811c9dc5) >>> 0;
  }
  return `g_${hashA.toString(36)}${hashB.toString(36)}`;
}
