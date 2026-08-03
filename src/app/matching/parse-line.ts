/**
 * Turns one raw line of a phoned-in or emailed order into
 * `{ qty, unit, phrase, note }`.
 *
 * Real orders look like: "2 milk", "milk x3", "3 lb apples", "dozen eggs",
 * "- 2 loaves rye bread", "1. apples (ripe, not green)", "eggs - large brown".
 * Everything the parser strips off is still available in `raw`, so nothing the
 * customer said is ever lost.
 */

export interface ParsedLine {
  raw: string;
  qty: number;
  unit: string;
  /** What is left once quantity, unit and notes are removed — the product. */
  phrase: string;
  note: string;
}

/** Units we recognise, mapped to a canonical short form. */
const UNITS: Record<string, string> = {
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  '#': 'lb',
  oz: 'oz',
  ozs: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  kg: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  g: 'g',
  gram: 'g',
  grams: 'g',
  gal: 'gal',
  gallon: 'gal',
  gallons: 'gal',
  qt: 'qt',
  quart: 'qt',
  quarts: 'qt',
  pt: 'pt',
  pint: 'pt',
  pints: 'pt',
  l: 'l',
  liter: 'l',
  liters: 'l',
  litre: 'l',
  litres: 'l',
  ml: 'ml',
  dozen: 'dozen',
  dozens: 'dozen',
  doz: 'dozen',
  dz: 'dozen',
  ct: 'ct',
  count: 'ct',
  pk: 'pack',
  pack: 'pack',
  packs: 'pack',
  package: 'pack',
  packages: 'pack',
  pkg: 'pack',
  case: 'case',
  cases: 'case',
  box: 'box',
  boxes: 'box',
  bag: 'bag',
  bags: 'bag',
  bunch: 'bunch',
  bunches: 'bunch',
  head: 'head',
  heads: 'head',
  jar: 'jar',
  jars: 'jar',
  can: 'can',
  cans: 'can',
  bottle: 'bottle',
  bottles: 'bottle',
  loaf: 'loaf',
  loaves: 'loaf',
  stick: 'stick',
  sticks: 'stick',
  roll: 'roll',
  rolls: 'roll',
  tub: 'tub',
  tubs: 'tub',
  each: 'each',
  ea: 'each',
  pc: 'each',
  pcs: 'each',
  piece: 'each',
  pieces: 'each',
};

/** Spelled-out numbers people say on the phone. */
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
};

/**
 * Units that describe a package size rather than how many to pick. "12 oz sour
 * cream" is one tub, not twelve — so these stay in the product phrase where
 * they help matching against catalog names like "Sour Cream 12 oz".
 */
const SIZE_ONLY_UNITS = new Set(['oz', 'g', 'ml']);

/**
 * Units that count whole packages. Only these (or a bare number) are read as a
 * quantity when they trail the product: "eggs 2 dozen" is two dozen, while
 * "bread 12 oz" is a size.
 */
const COUNT_UNITS = new Set([
  'dozen',
  'ct',
  'pack',
  'case',
  'box',
  'bag',
  'bunch',
  'head',
  'loaf',
  'jar',
  'can',
  'bottle',
  'stick',
  'roll',
  'tub',
  'each',
  'lb',
]);

/** Numeric forms: 3, 3.5, 1/2, 2 1/2. */
const NUM = String.raw`\d+(?:\s+\d+\/\d+|\.\d+|\/\d+)?`;

function toNumber(text: string): number {
  const trimmed = text.trim();
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(trimmed);
  if (mixed !== null) {
    return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  }
  const fraction = /^(\d+)\/(\d+)$/.exec(trimmed);
  if (fraction !== null) {
    return Number(fraction[1]) / Number(fraction[2]);
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : 1;
}

function roundQty(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Strip "-", "*", "•", "1.", "2)", "#3" from the front of a pasted line. */
function stripBullet(line: string): string {
  return line
    .replace(/^\s*[-*•·–—>•]+\s*/, '')
    .replace(/^\s*\(?\d{1,3}[.)]\s+/, '')
    .replace(/^\s*#\s*\d{1,3}\s+/, '')
    .trim();
}

/** Pull a trailing "(...)" or ", note" off the end and keep it as a note. */
function splitNote(text: string): { body: string; note: string } {
  const notes: string[] = [];
  let body = text;

  // Parenthesised asides, unless the whole thing is just a quantity: "(2)".
  body = body
    .replace(/\(([^)]*)\)/g, (_full, inner: string) => {
      const trimmed = inner.trim();
      if (/^(?:x\s*)?\d+(?:\.\d+)?$/i.test(trimmed)) return ` ${trimmed} `;
      notes.push(trimmed);
      return ' ';
    })
    .trim();

  // A trailing " - no pulp" / " — organic please" style aside.
  const dash = /\s+[-–—]\s+(.{2,})$/.exec(body);
  if (dash !== null) {
    notes.push(dash[1].trim());
    body = body.slice(0, dash.index).trim();
  }

  return { body: body.replace(/\s{2,}/g, ' ').trim(), note: notes.join('; ') };
}

/**
 * Extract quantity and unit from a single order line.
 *
 * Precedence, highest first:
 *   1. trailing quantity markers — "milk x3", "milk qty 2", "milk - 3"
 *   2. leading quantity + optional unit — "3 lb apples", "2 milk", "dozen eggs"
 *   3. nothing found — qty 1
 */
export function parseLine(rawInput: string): ParsedLine {
  const raw = String(rawInput ?? '').trim();
  const { body, note } = splitNote(stripBullet(raw));

  let qty: number | null = null;
  let unit = '';
  let rest = body;

  // 1. Trailing markers.
  const trailingX = new RegExp(String.raw`[\s,]*(?:x|\*)\s*(${NUM})\s*$`, 'i').exec(rest);
  const trailingQty = new RegExp(String.raw`[\s,]*(?:qty|quantity)[\s:.]*(${NUM})\s*$`, 'i').exec(
    rest,
  );
  const trailingUnitQty = new RegExp(
    String.raw`[\s,]+(${NUM})\s*(${Object.keys(UNITS).filter((u) => /^[a-z]+$/.test(u)).join('|')})?\s*$`,
    'i',
  ).exec(rest);

  if (trailingQty !== null) {
    qty = toNumber(trailingQty[1]);
    rest = rest.slice(0, trailingQty.index).trim();
  } else if (trailingX !== null) {
    qty = toNumber(trailingX[1]);
    rest = rest.slice(0, trailingX.index).trim();
  } else if (trailingUnitQty !== null && rest.slice(0, trailingUnitQty.index).trim() !== '') {
    // "eggs 2 dozen" / "milk 2" — a trailing size ("bread 12 oz") is left alone.
    const rawTrailingUnit = trailingUnitQty[2];
    const trailingUnit =
      rawTrailingUnit === undefined ? '' : (UNITS[rawTrailingUnit.toLowerCase()] ?? '');
    if (trailingUnit === '' || COUNT_UNITS.has(trailingUnit)) {
      qty = toNumber(trailingUnitQty[1]);
      unit = trailingUnit;
      rest = rest.slice(0, trailingUnitQty.index).trim();
    }
  }

  // 2. Leading quantity (and possibly a unit) — runs even if a trailing marker
  //    matched, because "2 lb apples x3" should keep the unit from the front.
  const unitPattern = Object.keys(UNITS)
    .filter((u) => /^[a-z]+$/.test(u))
    .sort((a, b) => b.length - a.length)
    .join('|');
  // `(?!\s*%)` keeps "2% milk" intact — that 2 is a fat content, not a count.
  const leading = new RegExp(
    String.raw`^(${NUM})(?!\s*%)\s*(?:(${unitPattern})\b|(#))?\s*(?:of\s+)?(.*)$`,
    'i',
  ).exec(rest);
  const leadingUnitName = leading?.[2];
  const leadingUnit =
    leadingUnitName === undefined ? '' : (UNITS[leadingUnitName.toLowerCase()] ?? '');

  if (
    leading !== null &&
    leading[4] !== undefined &&
    leading[4].trim() !== '' &&
    !SIZE_ONLY_UNITS.has(leadingUnit)
  ) {
    const leadingQty = toNumber(leading[1]);
    if (qty === null) qty = leadingQty;
    if (unit === '' && leadingUnit !== '') unit = leadingUnit;
    if (unit === '' && leading[3] !== undefined) unit = 'lb';
    rest = leading[4].trim();
  } else if (leading === null) {
    // "dozen eggs", "two milk", "half lb turkey", "a dozen eggs"
    const words = rest.split(/\s+/);
    let index = 0;
    let wordQty: number | null = null;
    while (index < words.length) {
      const word = words[index].toLowerCase().replace(/[^a-z]/g, '');
      const asNumber = NUMBER_WORDS[word];
      if (asNumber !== undefined && index === 0) {
        wordQty = asNumber;
        index += 1;
        continue;
      }
      const asUnit = UNITS[word];
      if (
        asUnit !== undefined &&
        !SIZE_ONLY_UNITS.has(asUnit) &&
        index < 2 &&
        words.length > index + 1
      ) {
        if (unit === '') unit = asUnit;
        if (wordQty === null) wordQty = 1;
        index += 1;
        continue;
      }
      break;
    }
    if (index > 0 && words.slice(index).join(' ').trim() !== '') {
      if (qty === null && wordQty !== null) qty = wordQty;
      rest = words.slice(index).join(' ').trim();
    }
  }

  // 3. "of" left over from "2 of milk", and stray leading unit words.
  rest = rest.replace(/^of\s+/i, '').trim();

  const finalQty = qty === null || qty <= 0 ? 1 : roundQty(qty);
  return {
    raw,
    qty: finalQty,
    unit,
    phrase: rest === '' ? stripBullet(raw) : rest,
    note,
  };
}

/**
 * Break a pasted block into individual order lines.
 *
 * Splits on newlines and semicolons always; on commas only when the store has
 * turned that on, because plenty of product names contain a comma.
 */
export function splitOrderText(text: string, splitOnCommas = false): string[] {
  const separators = splitOnCommas ? /[\n\r;,]+/ : /[\n\r;]+/;
  return String(text ?? '')
    .split(separators)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^[-*=_•·–—\s]+$/.test(line))
    .filter((line) => !isHeaderNoise(line));
}

/** Email boilerplate that shows up when staff paste a forwarded order. */
function isHeaderNoise(line: string): boolean {
  return /^(from|to|cc|bcc|sent|date|subject|reply-to)\s*:/i.test(line.trim());
}
