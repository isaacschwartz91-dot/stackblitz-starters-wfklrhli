import { randomBytes, randomInt } from 'node:crypto';

/**
 * Alphabet for human-readable label codes: digits and uppercase letters with
 * the pairs people misread off a smudged label removed (0/O, 1/I/L, U/V ->
 * keeping V, S/5 kept since Code 128 renders them distinctly). 30 symbols.
 */
export const BARCODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export const BARCODE_PREFIX = 'DTS';

// DTS-XXXX-XXXX — 8 random symbols, ~6.5e11 combinations. Collisions are
// handled by the unique index plus a retry, not by hoping.
const BARCODE_GROUPS = 2;
const BARCODE_GROUP_LENGTH = 4;

export const BARCODE_PATTERN = new RegExp(
  `^${BARCODE_PREFIX}(-[${BARCODE_ALPHABET}]{${BARCODE_GROUP_LENGTH}}){${BARCODE_GROUPS}}$`,
);

function randomSymbols(length) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += BARCODE_ALPHABET[randomInt(BARCODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Generates the value encoded on an order's label. Uppercase, hyphen-grouped,
 * and restricted to an unambiguous alphabet so it can be typed in by hand when
 * a label is too damaged to scan.
 */
export function generateBarcodeValue() {
  const groups = Array.from({ length: BARCODE_GROUPS }, () =>
    randomSymbols(BARCODE_GROUP_LENGTH),
  );
  return [BARCODE_PREFIX, ...groups].join('-');
}

/**
 * Normalises scanner input. Camera scans arrive with stray whitespace, and
 * hand-typed codes arrive lowercase and sometimes without the separators.
 */
export function normaliseBarcodeValue(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.trim().toUpperCase().replace(/[\s_]+/g, '');
  if (BARCODE_PATTERN.test(cleaned)) return cleaned;

  // Accept an unseparated code (DTSAB12CD34) by re-inserting the hyphens.
  const compact = cleaned.replace(/-/g, '');
  const expected = BARCODE_PREFIX.length + BARCODE_GROUPS * BARCODE_GROUP_LENGTH;
  if (compact.length === expected && compact.startsWith(BARCODE_PREFIX)) {
    const body = compact.slice(BARCODE_PREFIX.length);
    const groups = body.match(new RegExp(`.{${BARCODE_GROUP_LENGTH}}`, 'g')) ?? [];
    const candidate = [BARCODE_PREFIX, ...groups].join('-');
    if (BARCODE_PATTERN.test(candidate)) return candidate;
  }

  return cleaned;
}

/**
 * Public tracking token. The customer-facing page has no login, so this is the
 * only thing standing between a stranger and someone's delivery address —
 * 144 bits of entropy, never derived from the order reference.
 */
export function generateTrackingToken() {
  return randomBytes(18).toString('base64url');
}

export function trackingUrl(baseUrl, token) {
  return `${baseUrl.replace(/\/+$/, '')}/track/${token}`;
}
