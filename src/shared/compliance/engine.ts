/**
 * Compliance engine (spec section 3.5).
 *
 * Pure functions, no Angular, no I/O — so the whole pass/fail decision is unit
 * testable against fixed fixtures.
 *
 * FR-20: every comparison that decides pass/fail is integer-on-integer.
 * Servings are quarter-serving units; money is cents.
 */

import type {
  CategoryRequirement,
  DietaryTag,
  Item,
  OrderLine,
  RulesSnapshot,
} from '../types';
import { ceilDiv } from '../units';

// --- requirements ---------------------------------------------------------

/**
 * FR-11: required quarter-servings for the whole order, per category.
 *   per member per day x members x days
 */
export function requiredUnitsByCategory(
  requirements: readonly CategoryRequirement[],
  memberCount: number,
  daysCovered: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const req of requirements) {
    out[req.categoryKey] = req.servingsPerMemberPerDayUnits * memberCount * daysCovered;
  }
  return out;
}

/** FR-22: per-category ceiling for the whole order, or null when unset. */
export function maxUnitsByCategory(
  requirements: readonly CategoryRequirement[],
  memberCount: number,
  daysCovered: number,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const req of requirements) {
    out[req.categoryKey] =
      req.maxServingsPerMemberPerDayUnits === null
        ? null
        : req.maxServingsPerMemberPerDayUnits * memberCount * daysCovered;
  }
  return out;
}

/** FR-1: the cap in cents for this order. */
export function capTotalCents(
  capAmountCents: number,
  capBasis: 'per_member' | 'per_order',
  memberCount: number,
): number {
  return capBasis === 'per_member' ? capAmountCents * memberCount : capAmountCents;
}

// --- cart totals ----------------------------------------------------------

/** Quarter-servings a line contributes: package servings x quantity. */
export function lineUnits(line: OrderLine): number {
  return line.servingsUnitsSnapshot * line.qty;
}

/** Cents a line contributes: captured unit price x quantity (FR-6). */
export function lineCents(line: OrderLine): number {
  return line.unitPriceCentsSnapshot * line.qty;
}

export function orderTotalCents(lines: readonly OrderLine[]): number {
  return lines.reduce((sum, line) => sum + lineCents(line), 0);
}

export function cartUnitsByCategory(lines: readonly OrderLine[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of lines) {
    out[line.categorySnapshot] = (out[line.categorySnapshot] ?? 0) + lineUnits(line);
  }
  return out;
}

/** FR-23: which items contributed how many servings to a category. */
export interface CategoryContribution {
  lineId: string;
  itemName: string;
  qty: number;
  unitsPerPackage: number;
  units: number;
  cents: number;
}

export interface CategoryStatus {
  categoryKey: string;
  label: string;
  unitLabel: string;
  sortOrder: number;
  requiredUnits: number;
  inCartUnits: number;
  /** Positive when short. Zero when met or exceeded (FR-21). */
  shortfallUnits: number;
  /** Positive when over the requirement. Never an error on its own (FR-21). */
  surplusUnits: number;
  satisfied: boolean;
  /** FR-22: set when a per-category ceiling exists and is breached. */
  maxUnits: number | null;
  overMax: boolean;
  /** FR-22: distinct-item variety rule. */
  minDistinctItems: number | null;
  distinctItems: number;
  varietyShortfall: number;
  contributions: CategoryContribution[];
}

export interface ComplianceViolation {
  kind: 'shortfall' | 'over_cap' | 'over_max' | 'variety';
  categoryKey: string | null;
  /** Machine-readable detail for the override record and the audit log. */
  detail: Record<string, number | string>;
}

export interface ComplianceResult {
  categories: CategoryStatus[];
  totalCents: number;
  capTotalCents: number;
  /** Negative when over the cap. */
  remainingCents: number;
  overCap: boolean;
  overCapByCents: number;
  violations: ComplianceViolation[];
  /** FR-18: true only when nothing is short and the cap is respected. */
  canFinalize: boolean;
}

/** FR-14, FR-15, FR-21, FR-22, FR-23: the whole live compliance picture. */
export function evaluateOrder(
  lines: readonly OrderLine[],
  snapshot: RulesSnapshot,
): ComplianceResult {
  const inCart = cartUnitsByCategory(lines);
  const maxima = maxUnitsByCategory(
    snapshot.requirements,
    snapshot.memberCount,
    snapshot.daysCovered,
  );
  const violations: ComplianceViolation[] = [];

  const categories: CategoryStatus[] = snapshot.categories
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((cat) => {
      const requirement = snapshot.requirements.find((r) => r.categoryKey === cat.key);
      const requiredUnits = snapshot.requiredUnitsByCategory[cat.key] ?? 0;
      const inCartUnits = inCart[cat.key] ?? 0;
      const shortfallUnits = Math.max(0, requiredUnits - inCartUnits);
      const surplusUnits = Math.max(0, inCartUnits - requiredUnits);
      const maxUnits = maxima[cat.key] ?? null;
      const overMax = maxUnits !== null && inCartUnits > maxUnits;

      const contributions: CategoryContribution[] = lines
        .filter((line) => line.categorySnapshot === cat.key)
        .map((line) => ({
          lineId: line.id,
          itemName: line.itemNameSnapshot,
          qty: line.qty,
          unitsPerPackage: line.servingsUnitsSnapshot,
          units: lineUnits(line),
          cents: lineCents(line),
        }));

      // Variety counts only items that actually credit servings.
      const distinctItems = new Set(
        lines
          .filter((line) => line.categorySnapshot === cat.key && line.servingsUnitsSnapshot > 0 && line.qty > 0)
          .map((line) => line.itemId),
      ).size;
      const minDistinctItems = requirement?.minDistinctItems ?? null;
      const varietyShortfall =
        minDistinctItems === null ? 0 : Math.max(0, minDistinctItems - distinctItems);

      if (shortfallUnits > 0) {
        violations.push({
          kind: 'shortfall',
          categoryKey: cat.key,
          detail: { requiredUnits, inCartUnits, shortfallUnits },
        });
      }
      if (overMax && maxUnits !== null) {
        violations.push({
          kind: 'over_max',
          categoryKey: cat.key,
          detail: { maxUnits, inCartUnits, overByUnits: inCartUnits - maxUnits },
        });
      }
      if (varietyShortfall > 0 && minDistinctItems !== null) {
        violations.push({
          kind: 'variety',
          categoryKey: cat.key,
          detail: { minDistinctItems, distinctItems },
        });
      }

      return {
        categoryKey: cat.key,
        label: cat.label,
        unitLabel: cat.unitLabel,
        sortOrder: cat.sortOrder,
        requiredUnits,
        inCartUnits,
        shortfallUnits,
        surplusUnits,
        satisfied: shortfallUnits === 0,
        maxUnits,
        overMax,
        minDistinctItems,
        distinctItems,
        varietyShortfall,
        contributions,
      };
    });

  const totalCents = orderTotalCents(lines);
  const cap = snapshot.capTotalCents;
  const overCap = totalCents > cap;
  if (overCap) {
    violations.push({
      kind: 'over_cap',
      categoryKey: null,
      detail: { capTotalCents: cap, totalCents, overByCents: totalCents - cap },
    });
  }

  return {
    categories,
    totalCents,
    capTotalCents: cap,
    remainingCents: cap - totalCents,
    overCap,
    overCapByCents: Math.max(0, totalCents - cap),
    violations,
    canFinalize: violations.length === 0,
  };
}

// --- dietary restrictions (FR-10) ----------------------------------------

/** An item is allowed when it carries every restriction tag the household set. */
export function itemAllowed(
  item: Pick<Item, 'tags'>,
  restrictions: readonly DietaryTag[],
): boolean {
  return restrictions.every((tag) => item.tags.includes(tag));
}

/** Which restrictions an item fails, for the flag-mode explanation. */
export function itemConflicts(
  item: Pick<Item, 'tags'>,
  restrictions: readonly DietaryTag[],
): DietaryTag[] {
  return restrictions.filter((tag) => !item.tags.includes(tag));
}

// --- suggestions (FR-16) --------------------------------------------------

export interface Suggestion {
  item: Item;
  /** Packages to add to close the gap without breaching the cap. */
  qty: number;
  unitsAdded: number;
  centsAdded: number;
  /** Ranking key: quarter-servings per dollar. Integer-safe comparison. */
  unitsPerDollarNumerator: number;
  unitsPerDollarDenominator: number;
  /** True when this quantity fully closes the category's shortfall. */
  closesGap: boolean;
}

/**
 * FR-16: items that close a category's gap, ranked by servings per dollar,
 * excluding anything that would breach the cap or a dietary restriction.
 *
 * Ranking compares a/b vs c/d as a*d vs c*b — no float division, so two items
 * with the same value never reorder unpredictably.
 */
export function suggestForCategory(
  categoryKey: string,
  shortfallUnits: number,
  remainingCents: number,
  catalog: readonly Item[],
  restrictions: readonly DietaryTag[],
  limit = 5,
): Suggestion[] {
  if (shortfallUnits <= 0) return [];

  const candidates: Suggestion[] = [];
  for (const item of catalog) {
    if (!item.active) continue;
    if (item.categoryKey !== categoryKey) continue;
    if (item.servingsPerPackageUnits <= 0) continue;
    if (!itemAllowed(item, restrictions)) continue;

    // Quantity that closes the gap...
    const qtyToClose = ceilDiv(shortfallUnits, item.servingsPerPackageUnits);
    // ...capped by what the remaining budget can actually buy.
    const affordableQty =
      item.priceCents <= 0 ? qtyToClose : Math.floor(remainingCents / item.priceCents);
    const qty = Math.min(qtyToClose, Math.max(0, affordableQty));
    if (qty <= 0) continue; // cannot add even one without breaching the cap

    candidates.push({
      item,
      qty,
      unitsAdded: qty * item.servingsPerPackageUnits,
      centsAdded: qty * item.priceCents,
      unitsPerDollarNumerator: item.servingsPerPackageUnits,
      unitsPerDollarDenominator: Math.max(1, item.priceCents),
      closesGap: qty * item.servingsPerPackageUnits >= shortfallUnits,
    });
  }

  candidates.sort((a, b) => {
    // Prefer suggestions that actually close the gap.
    if (a.closesGap !== b.closesGap) return a.closesGap ? -1 : 1;
    // Then best servings per dollar (cross-multiplied, integer only).
    const left = a.unitsPerDollarNumerator * b.unitsPerDollarDenominator;
    const right = b.unitsPerDollarNumerator * a.unitsPerDollarDenominator;
    if (left !== right) return right - left;
    // Then cheaper, then stable by name.
    if (a.centsAdded !== b.centsAdded) return a.centsAdded - b.centsAdded;
    return a.item.name.localeCompare(b.item.name);
  });

  return candidates.slice(0, limit);
}

/** FR-16 across every short category at once. */
export function suggestAll(
  result: ComplianceResult,
  catalog: readonly Item[],
  restrictions: readonly DietaryTag[],
  limitPerCategory = 3,
): Record<string, Suggestion[]> {
  const out: Record<string, Suggestion[]> = {};
  for (const cat of result.categories) {
    if (cat.shortfallUnits <= 0) continue;
    out[cat.categoryKey] = suggestForCategory(
      cat.categoryKey,
      cat.shortfallUnits,
      result.remainingCents,
      catalog,
      restrictions,
      limitPerCategory,
    );
  }
  return out;
}

// --- getting back under the cap (FR-17) -----------------------------------

export interface ReductionOption {
  lineId: string;
  itemName: string;
  /** Packages that can come off without making any category short. */
  reducibleQty: number;
  centsSaved: number;
  categoryKey: string;
}

export interface SwapOption {
  fromLineId: string;
  fromItemName: string;
  toItem: Item;
  /** Packages of the replacement needed to hold the category's servings. */
  toQty: number;
  fromQty: number;
  centsSaved: number;
  categoryKey: string;
}

export interface CapRecoveryPlan {
  overByCents: number;
  reductions: ReductionOption[];
  swaps: SwapOption[];
  /** True when the listed moves fully get the order back under the cap. */
  sufficient: boolean;
  /** Best case still over the cap by this much. */
  residualCents: number;
}

/**
 * FR-17: what to reduce or swap to get back under the cap while keeping every
 * category satisfied.
 *
 * Reductions only ever touch surplus servings, so a category that is exactly
 * met is never cut into.
 */
export function planCapRecovery(
  lines: readonly OrderLine[],
  snapshot: RulesSnapshot,
  catalog: readonly Item[],
  restrictions: readonly DietaryTag[],
): CapRecoveryPlan {
  const result = evaluateOrder(lines, snapshot);
  if (!result.overCap) {
    return { overByCents: 0, reductions: [], swaps: [], sufficient: true, residualCents: 0 };
  }

  const surplusByCategory: Record<string, number> = {};
  for (const cat of result.categories) {
    surplusByCategory[cat.categoryKey] = cat.surplusUnits;
  }

  // --- reductions: trim packages that only ever fed a surplus.
  const reductions: ReductionOption[] = [];
  const sortedLines = lines
    .slice()
    .sort((a, b) => b.unitPriceCentsSnapshot - a.unitPriceCentsSnapshot);

  for (const line of sortedLines) {
    const perPackage = line.servingsUnitsSnapshot;
    let reducibleQty: number;
    if (perPackage <= 0) {
      // Non-creditable item: removing it costs no servings at all.
      reducibleQty = line.qty;
    } else {
      const surplus = surplusByCategory[line.categorySnapshot] ?? 0;
      reducibleQty = Math.min(line.qty, Math.floor(surplus / perPackage));
      if (reducibleQty > 0) {
        surplusByCategory[line.categorySnapshot] = surplus - reducibleQty * perPackage;
      }
    }
    if (reducibleQty > 0) {
      reductions.push({
        lineId: line.id,
        itemName: line.itemNameSnapshot,
        reducibleQty,
        centsSaved: reducibleQty * line.unitPriceCentsSnapshot,
        categoryKey: line.categorySnapshot,
      });
    }
  }

  // --- swaps: same servings from a cheaper item in the same category.
  const swaps: SwapOption[] = [];
  for (const line of lines) {
    if (line.servingsUnitsSnapshot <= 0) continue;
    const neededUnits = lineUnits(line);
    const lineCost = lineCents(line);

    let best: SwapOption | null = null;
    for (const item of catalog) {
      if (!item.active) continue;
      if (item.id === line.itemId) continue;
      if (item.categoryKey !== line.categorySnapshot) continue;
      if (item.servingsPerPackageUnits <= 0) continue;
      if (!itemAllowed(item, restrictions)) continue;

      const toQty = ceilDiv(neededUnits, item.servingsPerPackageUnits);
      const newCost = toQty * item.priceCents;
      const saved = lineCost - newCost;
      if (saved <= 0) continue;
      if (best === null || saved > best.centsSaved) {
        best = {
          fromLineId: line.id,
          fromItemName: line.itemNameSnapshot,
          toItem: item,
          toQty,
          fromQty: line.qty,
          centsSaved: saved,
          categoryKey: line.categorySnapshot,
        };
      }
    }
    if (best) swaps.push(best);
  }
  swaps.sort((a, b) => b.centsSaved - a.centsSaved);

  // Best case = every reduction plus the single best swap per line, without
  // double-counting a line that appears in both lists.
  const reducedLineIds = new Set(reductions.map((r) => r.lineId));
  const reductionSavings = reductions.reduce((sum, r) => sum + r.centsSaved, 0);
  const swapSavings = swaps
    .filter((s) => !reducedLineIds.has(s.fromLineId))
    .reduce((sum, s) => sum + s.centsSaved, 0);
  const bestSavings = reductionSavings + swapSavings;

  return {
    overByCents: result.overCapByCents,
    reductions,
    swaps: swaps.slice(0, 5),
    sufficient: bestSavings >= result.overCapByCents,
    residualCents: Math.max(0, result.overCapByCents - bestSavings),
  };
}

// --- cheapest compliant basket (section 5) -------------------------------

export interface CheapestBasketLine {
  item: Item;
  qty: number;
  unitsAdded: number;
  centsAdded: number;
}

export interface CheapestBasketResult {
  /** Null when some category cannot be satisfied from the catalog at all. */
  totalCents: number | null;
  lines: CheapestBasketLine[];
  /** Categories with no usable item, so no basket exists. */
  impossibleCategories: string[];
  exceedsCap: boolean;
  gapCents: number;
}

/**
 * Section 5: "If the cheapest possible compliant basket already exceeds the
 * cap, say that plainly and show the gap."
 *
 * Every item belongs to exactly one category, so the cheapest whole-package
 * basket is the sum of an independent unbounded-knapsack minimum per category.
 * That makes this an exact answer, not an estimate — which matters, because it
 * is the difference between "the customer picked badly" and "this contract
 * cannot be satisfied", and staff need to be able to tell those apart.
 */
export function cheapestCompliantBasket(
  snapshot: RulesSnapshot,
  catalog: readonly Item[],
  restrictions: readonly DietaryTag[],
): CheapestBasketResult {
  const lines: CheapestBasketLine[] = [];
  const impossible: string[] = [];
  let total = 0;

  for (const cat of snapshot.categories) {
    const required = snapshot.requiredUnitsByCategory[cat.key] ?? 0;
    if (required <= 0) continue;

    const options = catalog.filter(
      (i) =>
        i.active &&
        i.categoryKey === cat.key &&
        i.servingsPerPackageUnits > 0 &&
        itemAllowed(i, restrictions),
    );
    if (options.length === 0) {
      impossible.push(cat.key);
      continue;
    }

    // dp[u] = min cents to reach at least u units. Overshoot is fine (FR-21).
    const INF = Number.MAX_SAFE_INTEGER;
    const dp = new Array<number>(required + 1).fill(INF);
    const choice = new Array<number>(required + 1).fill(-1);
    dp[0] = 0;
    for (let u = 1; u <= required; u++) {
      for (let k = 0; k < options.length; k++) {
        const opt = options[k]!;
        const prev = Math.max(0, u - opt.servingsPerPackageUnits);
        const prevCost = dp[prev];
        if (prevCost === undefined || prevCost === INF) continue;
        const cost = prevCost + opt.priceCents;
        if (cost < dp[u]!) {
          dp[u] = cost;
          choice[u] = k;
        }
      }
    }

    if (dp[required] === INF) {
      impossible.push(cat.key);
      continue;
    }

    // Walk the choices back into whole packages.
    const counts = new Map<number, number>();
    let u = required;
    while (u > 0) {
      const k = choice[u]!;
      if (k < 0) break;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      u = Math.max(0, u - options[k]!.servingsPerPackageUnits);
    }
    for (const [k, qty] of counts) {
      const item = options[k]!;
      lines.push({
        item,
        qty,
        unitsAdded: qty * item.servingsPerPackageUnits,
        centsAdded: qty * item.priceCents,
      });
    }
    total += dp[required]!;
  }

  if (impossible.length > 0) {
    return {
      totalCents: null,
      lines,
      impossibleCategories: impossible,
      exceedsCap: false,
      gapCents: 0,
    };
  }

  return {
    totalCents: total,
    lines,
    impossibleCategories: [],
    exceedsCap: total > snapshot.capTotalCents,
    gapCents: Math.max(0, total - snapshot.capTotalCents),
  };
}
