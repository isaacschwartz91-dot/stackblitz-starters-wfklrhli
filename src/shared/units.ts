/**
 * Money and serving arithmetic.
 *
 * FR-20: every value that feeds a pass/fail decision is an integer.
 *  - Money is integer cents.
 *  - Servings are integer QUARTER-servings ("units"). 1 serving = 4 units.
 *  - Meal-split fractions are integer basis points (10000 = 100%).
 *
 * No float ever reaches a comparison that decides whether an order qualifies.
 */

/** Quarter-serving units in one whole serving. */
export const UNITS_PER_SERVING = 4;

/** Basis points in a whole. */
export const BP_SCALE = 10_000;

// --- servings -------------------------------------------------------------

/** Whole/fractional servings (as typed by an admin) -> integer quarter units. */
export function servingsToUnits(servings: number): number {
  if (!Number.isFinite(servings)) return 0;
  return Math.round(servings * UNITS_PER_SERVING);
}

/** Integer quarter units -> servings as a number, for display only. */
export function unitsToServings(units: number): number {
  return units / UNITS_PER_SERVING;
}

/** Render quarter units as "3", "3¼", "3½", "3¾". */
export function formatUnits(units: number): string {
  const negative = units < 0;
  const abs = Math.abs(units);
  const whole = Math.floor(abs / UNITS_PER_SERVING);
  const rem = abs % UNITS_PER_SERVING;
  const frac = rem === 1 ? '¼' : rem === 2 ? '½' : rem === 3 ? '¾' : '';
  const body = whole === 0 && frac ? frac : `${whole}${frac}`;
  return negative ? `-${body}` : body;
}

/** Parse admin input like "2", "2.5", "2 1/2", "2¾" into quarter units. */
export function parseServingsToUnits(raw: string): number | null {
  const text = raw.trim().replace(/¼/g, ' 1/4').replace(/½/g, ' 1/2').replace(/¾/g, ' 3/4');
  if (!text) return null;
  const mixed = text.match(/^(\d+)?\s*(?:(\d+)\s*\/\s*(\d+))?$/);
  if (mixed && (mixed[1] !== undefined || mixed[2] !== undefined)) {
    const whole = mixed[1] ? parseInt(mixed[1], 10) : 0;
    const num = mixed[2] ? parseInt(mixed[2], 10) : 0;
    const den = mixed[3] ? parseInt(mixed[3], 10) : 1;
    if (den === 0) return null;
    return Math.round(whole * UNITS_PER_SERVING + (num * UNITS_PER_SERVING) / den);
  }
  const dec = Number(text);
  if (!Number.isFinite(dec) || dec < 0) return null;
  return servingsToUnits(dec);
}

// --- money ----------------------------------------------------------------

/** Parse "12.34", "$12.34", "12" into integer cents. Null when unparseable. */
export function parseMoneyToCents(raw: string): number | null {
  const text = raw.trim().replace(/[$,\s]/g, '');
  if (!text) return null;
  if (!/^-?\d*(\.\d{0,2})?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole, frac = ''] = text.replace('-', '').split('.');
  const cents = (whole === '' ? 0 : parseInt(whole, 10)) * 100 + parseInt(frac.padEnd(2, '0') || '0', 10);
  if (!Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}

/** Integer cents -> "$12.34". */
export function formatCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const body = `$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return negative ? `-${body}` : body;
}

/** Integer cents -> "12.34", for CSV export and number inputs. */
export function centsToPlain(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// --- allocation -----------------------------------------------------------

/**
 * Split an integer total across weights given in basis points, exactly.
 *
 * Section 5 rounding rule: round each share to the nearest unit (quarter
 * serving) and carry the remainder into the next share, so the shares always
 * sum back to `total` with nothing created or lost.
 *
 * Pure integer math: no float rounding can drift here.
 */
export function splitByBasisPoints(total: number, weightsBp: readonly number[]): number[] {
  const out: number[] = [];
  const totalBp = weightsBp.reduce((a, b) => a + b, 0);
  if (totalBp <= 0 || weightsBp.length === 0) return weightsBp.map(() => 0);

  let carryNumerator = 0; // remainder kept in units*totalBp scale
  let assigned = 0;
  for (let i = 0; i < weightsBp.length; i++) {
    if (i === weightsBp.length - 1) {
      // Last share absorbs everything left so the day total stays exact.
      out.push(total - assigned);
      break;
    }
    const numerator = total * (weightsBp[i] ?? 0) + carryNumerator;
    // Round to nearest unit, ties away from zero.
    const share = Math.floor(numerator / totalBp + 0.5);
    carryNumerator = numerator - share * totalBp;
    out.push(share);
    assigned += share;
  }
  return out;
}

/** Ceiling division for non-negative integers. */
export function ceilDiv(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.ceil(numerator / denominator);
}
