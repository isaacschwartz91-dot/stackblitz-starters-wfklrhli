/**
 * Similarity scoring for the "did you mean…" suggestions.
 *
 * No single metric works on grocery text: token overlap handles word order and
 * missing words ("milk" vs "Milk 2% Half Gallon"), character bigrams handle
 * typos ("banannas"), and a prefix bonus rewards the way people actually
 * abbreviate ("ched" for cheddar). The final score blends all three.
 */

import { tokenize } from './normalize';

/** Character bigrams of a string, e.g. "milk" -> ["mi","il","lk"]. */
function bigrams(text: string): string[] {
  const padded = text.replace(/\s+/g, ' ');
  const out: string[] = [];
  for (let i = 0; i < padded.length - 1; i += 1) out.push(padded.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice coefficient over character bigrams. Typo tolerant. */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const aGrams = bigrams(a);
  const counts = new Map<string, number>();
  for (const gram of aGrams) counts.set(gram, (counts.get(gram) ?? 0) + 1);

  let hits = 0;
  const bGrams = bigrams(b);
  for (const gram of bGrams) {
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      counts.set(gram, remaining - 1);
      hits += 1;
    }
  }
  return (2 * hits) / (aGrams.length + bGrams.length);
}

/** Levenshtein distance with a single rolling row. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length];
}

function levenshteinRatio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/**
 * How well every query token is covered by the candidate's tokens.
 *
 * A query token counts as covered when it equals a candidate token, is a
 * prefix of one ("ched" -> "cheddar"), or is a near-miss by edit distance
 * ("banannas" -> "banana"). Coverage is what matters, not symmetry: a short
 * query fully contained in a long product name is a strong signal.
 */
export function tokenCoverage(queryTokens: string[], candidateTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  let total = 0;
  for (const queryToken of queryTokens) {
    let best = 0;
    for (const candidateToken of candidateTokens) {
      if (queryToken === candidateToken) {
        best = 1;
        break;
      }
      // A prefix hit is worth more the more of the word it covers, so "banan"
      // beats "egg" (as in eggplant) at standing in for the whole token.
      if (queryToken.length >= 3 && candidateToken.startsWith(queryToken)) {
        best = Math.max(best, 0.72 + 0.28 * (queryToken.length / candidateToken.length));
        continue;
      }
      if (candidateToken.length >= 3 && queryToken.startsWith(candidateToken)) {
        best = Math.max(best, 0.66 + 0.28 * (candidateToken.length / queryToken.length));
        continue;
      }
      if (queryToken.length >= 4 && candidateToken.length >= 4) {
        const ratio = levenshteinRatio(queryToken, candidateToken);
        if (ratio >= 0.75) best = Math.max(best, ratio * 0.9);
      }
    }
    total += best;
  }
  return total / queryTokens.length;
}

/**
 * Overall 0–1 similarity between an order phrase and a catalog entry.
 *
 * Extra words in the candidate are only lightly penalised — "milk" *should*
 * find "Milk 2% Half Gallon" — but enough that the shorter, more specific
 * product wins when two candidates both contain every query token.
 */
export function similarity(query: string, candidate: string): number {
  const queryTokens = tokenize(query);
  const candidateTokens = tokenize(candidate);
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;

  const queryText = queryTokens.join(' ');
  const candidateText = candidateTokens.join(' ');
  if (queryText === candidateText) return 1;

  const coverage = tokenCoverage(queryTokens, candidateTokens);
  const dice = diceCoefficient(queryText, candidateText);

  // Shorter candidates that still cover the query are the better answer.
  const extraTokens = Math.max(0, candidateTokens.length - queryTokens.length);
  const brevity = 1 - Math.min(0.25, extraTokens * 0.035);

  // Covering every query token exactly is the strongest signal there is;
  // character overlap only breaks ties and rescues typos.
  const blended = (coverage * 0.8 + dice * 0.2) * brevity;

  // A whole-phrase hit ("rye bread" inside "Rye Bread Sliced") is stronger
  // evidence than the blend alone suggests. Word boundaries are required so
  // "eggs" does not claim to be inside "eggplant".
  const substringBonus = ` ${candidateText} `.includes(` ${queryText} `) ? 0.08 : 0;

  return Math.min(1, blended + substringBonus);
}
