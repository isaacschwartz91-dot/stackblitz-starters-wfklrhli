/**
 * Text normalisation shared by the matcher, the alias table and search.
 *
 * The whole matching engine rests on one rule: both sides of every comparison
 * are pushed through `normalize()` first, so "2% Milk, Half-Gallon" and
 * "2 percent milk half gallon" collapse to the same key.
 */

/** Shorthand the store staff actually type, expanded before matching. */
const ABBREVIATIONS: Record<string, string> = {
  pnut: 'peanut',
  pb: 'peanut butter',
  choc: 'chocolate',
  chocolat: 'chocolate',
  veg: 'vegetable',
  vegies: 'vegetable',
  veggies: 'vegetable',
  chkn: 'chicken',
  chix: 'chicken',
  bfast: 'breakfast',
  sndwch: 'sandwich',
  swt: 'sweet',
  org: 'organic',
  orgnc: 'organic',
  wht: 'white',
  whl: 'whole',
  lg: 'large',
  sm: 'small',
  med: 'medium',
  xl: 'extra large',
  jce: 'juice',
  cheeze: 'cheese',
  chz: 'cheese',
  ygrt: 'yogurt',
  yoghurt: 'yogurt',
  tp: 'toilet paper',
  pt: 'paper towel',
  mayo: 'mayonnaise',
  ketsup: 'ketchup',
  catsup: 'ketchup',
  soda: 'soda',
  pop: 'soda',
};

/** Words that carry no product meaning and only dilute similarity scores. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'some',
  'please',
  'pls',
  'plz',
  'and',
  'or',
  'with',
  'for',
  'get',
  'need',
  'want',
  'wants',
  'needs',
  'also',
  'item',
  'items',
]);

/** Irregular plurals that the generic de-pluraliser would mangle. */
const IRREGULAR_SINGULARS: Record<string, string> = {
  loaves: 'loaf',
  leaves: 'leaf',
  knives: 'knife',
  halves: 'half',
  shelves: 'shelf',
  potatoes: 'potato',
  tomatoes: 'tomato',
  children: 'child',
  geese: 'goose',
  feet: 'foot',
  teeth: 'tooth',
  mice: 'mouse',
};

/** Words that end in "s" but are already singular. */
const NEVER_DEPLURALISE = new Set([
  'hummus',
  'couscous',
  'molasses',
  'swiss',
  'grass',
  'glass',
  'cross',
  'gas',
  'bass',
  'less',
  'plus',
  'citrus',
  'asparagus',
  'chips',
  'oats',
  'greens',
  'grits',
  'beans',
  'jeans',
  'news',
  'series',
  'species',
]);

export function stripAccents(input: string): string {
  return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Turn a plural token into its singular form; conservative on purpose. */
export function singularize(token: string): string {
  const irregular = IRREGULAR_SINGULARS[token];
  if (irregular !== undefined) return irregular;
  if (token.length <= 3) return token;
  if (NEVER_DEPLURALISE.has(token)) return token;
  if (token.endsWith('ies') && token.length > 4) return token.slice(0, -3) + 'y';
  if (/(ch|sh|ss|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('ses') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Split text into comparable tokens: accent-free, punctuation-free, singular,
 * with store shorthand expanded and filler words dropped.
 */
export function tokenize(input: string): string[] {
  const cleaned = stripAccents(String(input ?? ''))
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/%/g, ' percent ')
    .replace(/\+/g, ' plus ')
    // "1/2" and "3.5" stay whole; every other punctuation mark becomes a gap.
    .replace(/[^a-z0-9./]+/g, ' ')
    .replace(/(^|\s)[./]+|[./]+(\s|$)/g, ' ');

  const out: string[] = [];
  for (const rawToken of cleaned.split(/\s+/)) {
    if (rawToken === '') continue;
    const expanded = ABBREVIATIONS[rawToken];
    const parts = expanded !== undefined ? expanded.split(' ') : [rawToken];
    for (const part of parts) {
      if (STOP_WORDS.has(part)) continue;
      const singular = singularize(part);
      if (singular !== '') out.push(singular);
    }
  }
  return out;
}

/** Canonical comparison key: the tokens, in order, space separated. */
export function normalize(input: string): string {
  return tokenize(input).join(' ');
}

/**
 * Order-insensitive key, so "milk 2% half gallon" and "half gallon 2% milk"
 * resolve to the same catalog entry.
 */
export function normalizeSorted(input: string): string {
  return [...new Set(tokenize(input))].sort().join(' ');
}
