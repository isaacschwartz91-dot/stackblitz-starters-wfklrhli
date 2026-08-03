/**
 * Resolves an order line to a catalog item.
 *
 * Priority, exactly as specified:
 *   1. customer-specific alias   (what this customer means by "milk")
 *   2. global alias              (store-wide shorthand)
 *   3. exact / normalized match  (case, spacing, plurals and punctuation blind)
 *   4. fuzzy match               (best guess + runners-up for staff to pick)
 *
 * `buildMatchIndex()` is called once per catalog change; `matchPhrase()` then
 * runs per line and only ever scores a small candidate set, so a 40-line order
 * against a 20,000-item catalog resolves in a few milliseconds.
 */

import type { Alias, Item, MatchSource } from '../core/models';
import { itemLabel } from '../core/models';
import { similarity } from './fuzzy';
import { normalize, normalizeSorted, tokenize } from './normalize';

export interface Candidate {
  item: Item;
  score: number;
}

export interface MatchResult {
  itemId: string | null;
  source: MatchSource;
  score: number;
  /** Best alternatives, highest score first — powers the "did you mean" list. */
  candidates: Candidate[];
  needsReview: boolean;
}

export interface MatchIndex {
  items: Item[];
  byId: Map<string, Item>;
  /** normalize(name) and normalize(name + brand + size) -> items */
  byNormalized: Map<string, Item[]>;
  /** order-insensitive token key -> items */
  bySorted: Map<string, Item[]>;
  byBarcode: Map<string, Item>;
  /** token -> positions in `items`, used to shortlist candidates */
  byToken: Map<string, number[]>;
  globalAliases: Map<string, Alias>;
  /** customerId -> normalized phrase -> alias */
  customerAliases: Map<string, Map<string, Alias>>;
}

export interface MatchOptions {
  customerId?: string | null;
  /** Score at or above which a fuzzy hit is accepted without review. */
  autoAcceptScore?: number;
  /** Score below which nothing is proposed as the match. */
  reviewFloorScore?: number;
  maxCandidates?: number;
}

const DEFAULT_AUTO_ACCEPT = 0.86;
const DEFAULT_REVIEW_FLOOR = 0.42;
const MAX_SCORED_CANDIDATES = 400;

function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
}

export function buildMatchIndex(items: Item[], aliases: Alias[]): MatchIndex {
  const active = items.filter((item) => item.active !== false);
  const index: MatchIndex = {
    items: active,
    byId: new Map(),
    byNormalized: new Map(),
    bySorted: new Map(),
    byBarcode: new Map(),
    byToken: new Map(),
    globalAliases: new Map(),
    customerAliases: new Map(),
  };

  active.forEach((item, position) => {
    index.byId.set(item.id, item);
    if (item.barcode.trim() !== '') index.byBarcode.set(item.barcode.trim(), item);

    const keys = new Set([normalize(item.name), normalize(itemLabel(item))]);
    for (const key of keys) {
      if (key === '') continue;
      pushInto(index.byNormalized, key, item);
      pushInto(index.bySorted, normalizeSorted(key), item);
    }

    for (const token of new Set(tokenize(itemLabel(item)))) {
      pushInto(index.byToken, token, position);
    }
  });

  for (const alias of aliases) {
    const key = alias.normalizedPhrase !== '' ? alias.normalizedPhrase : normalize(alias.phrase);
    if (key === '') continue;
    if (alias.customerId === null) {
      index.globalAliases.set(key, alias);
    } else {
      let perCustomer = index.customerAliases.get(alias.customerId);
      if (perCustomer === undefined) {
        perCustomer = new Map();
        index.customerAliases.set(alias.customerId, perCustomer);
      }
      perCustomer.set(key, alias);
    }
  }

  // Items also index themselves by id so "1042" in an order resolves.
  return index;
}

/** Shortlist items that share at least one token with the query. */
function shortlist(index: MatchIndex, queryTokens: string[]): Item[] {
  if (queryTokens.length === 0) return [];
  const hits = new Map<number, number>();

  for (const token of queryTokens) {
    const exact = index.byToken.get(token);
    if (exact !== undefined) {
      for (const position of exact) hits.set(position, (hits.get(position) ?? 0) + 2);
    }
    // Prefix hits catch "ched" -> "cheddar"; skipped for very short tokens.
    if (token.length >= 3) {
      for (const [indexedToken, positions] of index.byToken) {
        if (indexedToken !== token && indexedToken.startsWith(token)) {
          for (const position of positions) hits.set(position, (hits.get(position) ?? 0) + 1);
        }
      }
    }
  }

  if (hits.size === 0) return index.items.slice(0, MAX_SCORED_CANDIDATES);

  return [...hits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SCORED_CANDIDATES)
    .map(([position]) => index.items[position]);
}

/**
 * Pick the single best item for a normalized key when several share it —
 * prefer the one whose full label matches, then the shortest name.
 */
function preferred(items: Item[]): Item {
  return [...items].sort((a, b) => a.name.length - b.name.length)[0];
}

/**
 * Score a query against an item.
 *
 * Both the bare product name and the full "name · brand · size" label are
 * tried. The label lets a brand or size in the order line ("Farmland milk")
 * find its product; the bare name keeps that same brand and size from diluting
 * a query that never mentioned them ("rye bread" -> "Rye Bread Sliced").
 */
function scoreItem(query: string, item: Item): number {
  const label = itemLabel(item);
  const nameScore = similarity(query, item.name);
  if (label === item.name) return nameScore;
  return Math.max(nameScore, similarity(query, label));
}

/**
 * Match one phrase against the catalog.
 *
 * `alternates` are extra spellings worth trying — in practice the untouched
 * order line, so that size words the quantity parser stripped ("half gallon
 * milk" -> "milk") can still earn their match.
 */
export function matchPhrase(
  index: MatchIndex,
  phrase: string,
  options: MatchOptions = {},
  alternates: string[] = [],
): MatchResult {
  const autoAccept = options.autoAcceptScore ?? DEFAULT_AUTO_ACCEPT;
  const reviewFloor = options.reviewFloorScore ?? DEFAULT_REVIEW_FLOOR;
  const maxCandidates = options.maxCandidates ?? 5;

  const queries = [phrase, ...alternates]
    .map((text) => String(text ?? '').trim())
    .filter((text) => text !== '');
  if (queries.length === 0) {
    return { itemId: null, source: 'none', score: 0, candidates: [], needsReview: true };
  }

  const normalizedQueries = [...new Set(queries.map(normalize))].filter((key) => key !== '');

  // 1 + 2. Aliases. Customer first, always.
  const customerMap =
    options.customerId != null ? index.customerAliases.get(options.customerId) : undefined;
  for (const key of normalizedQueries) {
    const alias = customerMap?.get(key);
    if (alias !== undefined && index.byId.has(alias.itemId)) {
      return {
        itemId: alias.itemId,
        source: 'customer-alias',
        score: 1,
        candidates: [],
        needsReview: false,
      };
    }
  }
  for (const key of normalizedQueries) {
    const alias = index.globalAliases.get(key);
    if (alias !== undefined && index.byId.has(alias.itemId)) {
      return {
        itemId: alias.itemId,
        source: 'global-alias',
        score: 1,
        candidates: [],
        needsReview: false,
      };
    }
  }

  // A bare product code or barcode typed straight into the order.
  for (const query of queries) {
    const trimmed = query.trim();
    const byId = index.byId.get(trimmed);
    if (byId !== undefined) {
      return { itemId: byId.id, source: 'exact', score: 1, candidates: [], needsReview: false };
    }
    const byBarcode = index.byBarcode.get(trimmed);
    if (byBarcode !== undefined) {
      return {
        itemId: byBarcode.id,
        source: 'exact',
        score: 1,
        candidates: [],
        needsReview: false,
      };
    }
  }

  // 3. Exact normalized, then order-insensitive.
  for (const key of normalizedQueries) {
    const exact = index.byNormalized.get(key);
    if (exact !== undefined && exact.length > 0) {
      return {
        itemId: preferred(exact).id,
        source: 'exact',
        score: 1,
        candidates: [],
        needsReview: false,
      };
    }
  }
  for (const query of queries) {
    const sorted = index.bySorted.get(normalizeSorted(query));
    if (sorted !== undefined && sorted.length > 0) {
      return {
        itemId: preferred(sorted).id,
        source: 'normalized',
        score: 0.98,
        candidates: [],
        needsReview: false,
      };
    }
  }

  // 4. Fuzzy. Score every shortlisted item against every spelling we have.
  const scores = new Map<string, Candidate>();
  for (const query of queries) {
    const candidates = shortlist(index, tokenize(query));
    for (const item of candidates) {
      const score = scoreItem(query, item);
      const previous = scores.get(item.id);
      if (previous === undefined || score > previous.score) scores.set(item.id, { item, score });
    }
  }

  const ranked = [...scores.values()]
    .sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length)
    .slice(0, maxCandidates);

  const best = ranked[0];
  if (best === undefined || best.score < reviewFloor) {
    return { itemId: null, source: 'none', score: best?.score ?? 0, candidates: ranked, needsReview: true };
  }

  // Two candidates within a whisker of each other is a coin flip — ask a human.
  const runnerUp = ranked[1];
  const tooClose = runnerUp !== undefined && best.score - runnerUp.score < 0.04;
  const confident = best.score >= autoAccept && !tooClose;

  return {
    itemId: best.item.id,
    source: confident ? 'normalized' : 'fuzzy',
    score: best.score,
    candidates: ranked,
    needsReview: !confident,
  };
}

/** Free-text search over the catalog, used by the type-ahead add box. */
export function searchItems(index: MatchIndex, query: string, limit = 12): Candidate[] {
  const trimmed = query.trim();
  if (trimmed === '') return [];
  const tokens = tokenize(trimmed);
  const pool = shortlist(index, tokens);
  return pool
    .map((item) => ({ item, score: scoreItem(trimmed, item) }))
    .filter((candidate) => candidate.score > 0.12)
    .sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length)
    .slice(0, limit);
}
