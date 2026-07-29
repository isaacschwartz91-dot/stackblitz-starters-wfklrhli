/**
 * Meal-plan allocator (spec section 3.6).
 *
 * Pure functions, deterministic for a given seed, so a plan can be reproduced
 * exactly in a test and re-rolled on demand (FR-30).
 *
 * Hard guarantees, enforced by construction:
 *  - Servings scheduled never exceed servings purchased (AC-4). Every
 *    allocation decrements a pool that started at exactly what was bought.
 *  - A meal that cannot be filled says so, with the exact shortfall (FR-28).
 *    The allocator never quietly emits a thin meal.
 *  - Daily allocations sum to the daily requirement exactly (section 5
 *    rounding rule), because the split carries its remainder forward.
 */

import type {
  DietaryTag,
  MealKey,
  MealSlot,
  MealSlotItem,
  MealSlotShortfall,
  OrderLine,
  PlanDay,
  RulesSnapshot,
  ShelfLifeClass,
  UnusedItem,
} from '../types';
import { MEAL_KEYS, SHELF_LIFE_RANK } from '../types';
import { splitByBasisPoints } from '../units';

// --- scoring weights ------------------------------------------------------
// Ordered so that a higher-priority rule can never be outvoted by a
// lower-priority one: horizon > variety > shelf-life rank > jitter.

/** FR-27: scheduling a perishable after its horizon is a last resort. */
const PAST_HORIZON_PENALTY = 100_000;
/** FR-26: reusing an item in the same meal slot within the window. */
const VARIETY_PENALTY_PER_DAY = 1_000;
const VARIETY_WINDOW_DAYS = 3;
/** FR-27: within the allowed window, spend the most perishable first. */
const SHELF_RANK_WEIGHT = 100;
/** FR-30: breaks ties between otherwise-equal items so a reroll differs. */
const JITTER_RANGE = 90;

/** Deterministic PRNG (mulberry32) so a seed always reproduces a plan. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Pool {
  lineId: string;
  itemId: string;
  itemName: string;
  itemNameEs: string;
  categoryKey: string;
  shelfLifeClass: ShelfLifeClass;
  tags: DietaryTag[];
  totalUnits: number;
  remainingUnits: number;
  /** Last day index this item appeared in a given meal, for variety. */
  lastDayByMeal: Partial<Record<MealKey, number>>;
}

export interface GeneratedPlan {
  days: PlanDay[];
  unused: UnusedItem[];
  complete: boolean;
  seed: number;
}

export interface PlanInput {
  lines: readonly OrderLine[];
  snapshot: RulesSnapshot;
  /** ISO date of the first day of the benefit period. */
  periodStart: string;
  restrictions: readonly DietaryTag[];
  seed: number;
}

/** Add whole days to an ISO date without tripping over local timezones. */
export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((part) => parseInt(part, 10));
  const base = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * FR-25: per-meal allocation for one category on one day.
 * Returns quarter-servings per meal, summing exactly to `dailyUnits`.
 */
export function mealAllocationForCategory(
  snapshot: RulesSnapshot,
  categoryKey: string,
  dailyUnits: number,
): Record<MealKey, number> {
  const weights = MEAL_KEYS.map((meal) => {
    const split = snapshot.mealSplits.find(
      (s) => s.meal === meal && s.categoryKey === categoryKey,
    );
    return split?.fractionBp ?? 0;
  });
  const totalBp = weights.reduce((a, b) => a + b, 0);
  // An unconfigured category falls back to an even split rather than
  // silently dropping the category out of the plan entirely.
  const effective = totalBp === 0 ? MEAL_KEYS.map(() => 1) : weights;
  const shares = splitByBasisPoints(dailyUnits, effective);
  return {
    breakfast: shares[0] ?? 0,
    lunch: shares[1] ?? 0,
    supper: shares[2] ?? 0,
  };
}

/** FR-27: last day index a shelf-life class should be scheduled into. */
function horizonFor(snapshot: RulesSnapshot, cls: ShelfLifeClass): number | null {
  return snapshot.shelfLifeHorizonDays?.[cls] ?? null;
}

/**
 * FR-24 .. FR-30. Builds the plan day by day, meal by meal, category by
 * category, drawing only from what was actually purchased.
 */
export function generateMealPlan(input: PlanInput): GeneratedPlan {
  const { lines, snapshot, periodStart, restrictions, seed } = input;
  const rng = makeRng(seed);

  const pools: Pool[] = lines
    .filter((line) => line.servingsUnitsSnapshot > 0 && line.qty > 0)
    .map((line) => ({
      lineId: line.id,
      itemId: line.itemId,
      itemName: line.itemNameSnapshot,
      itemNameEs: line.itemNameEsSnapshot || line.itemNameSnapshot,
      categoryKey: line.categorySnapshot,
      shelfLifeClass: line.shelfLifeClassSnapshot,
      tags: line.tagsSnapshot,
      totalUnits: line.servingsUnitsSnapshot * line.qty,
      remainingUnits: line.servingsUnitsSnapshot * line.qty,
      lastDayByMeal: {},
    }));

  // Daily household requirement per category: per member per day x members.
  const dailyUnitsByCategory: Record<string, number> = {};
  for (const req of snapshot.requirements) {
    dailyUnitsByCategory[req.categoryKey] =
      req.servingsPerMemberPerDayUnits * snapshot.memberCount;
  }

  const orderedCategories = snapshot.categories
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const days: PlanDay[] = [];
  let complete = true;

  for (let dayIndex = 0; dayIndex < snapshot.daysCovered; dayIndex++) {
    const meals: MealSlot[] = MEAL_KEYS.map((meal) => ({
      meal,
      items: [],
      shortfalls: [],
    }));

    for (const cat of orderedCategories) {
      const dailyUnits = dailyUnitsByCategory[cat.key] ?? 0;
      if (dailyUnits <= 0) continue;
      const allocation = mealAllocationForCategory(snapshot, cat.key, dailyUnits);

      for (let mealIdx = 0; mealIdx < MEAL_KEYS.length; mealIdx++) {
        const meal = MEAL_KEYS[mealIdx]!;
        const slot = meals[mealIdx]!;
        let need = allocation[meal];
        if (need <= 0) continue;

        const candidates = pools.filter(
          (p) =>
            p.categoryKey === cat.key &&
            p.remainingUnits > 0 &&
            // FR-10: a restricted item never lands in the plan.
            restrictions.every((tag) => p.tags.includes(tag)),
        );

        const take = (pool: Pool, units: number) => {
          pool.remainingUnits -= units;
          pool.lastDayByMeal[meal] = dayIndex;
          need -= units;

          const existing = slot.items.find((i) => i.itemId === pool.itemId);
          if (existing) {
            existing.units += units;
          } else {
            const entry: MealSlotItem = {
              itemId: pool.itemId,
              itemName: pool.itemName,
              itemNameEs: pool.itemNameEs,
              categoryKey: pool.categoryKey,
              units,
            };
            slot.items.push(entry);
          }
        };

        /**
         * Perishability tier. Items are drawn tier by tier, so a shelf-stable
         * item is never opened while fresh food of the same category is still
         * in date. Only items sharing a tier compete on variety.
         */
        const tierOf = (p: Pool): number => {
          const horizon = horizonFor(snapshot, p.shelfLifeClass);
          const pastHorizon = horizon !== null && dayIndex > horizon;
          return (
            SHELF_RANK_WEIGHT * SHELF_LIFE_RANK[p.shelfLifeClass] +
            (pastHorizon ? PAST_HORIZON_PENALTY : 0)
          );
        };

        const tiers = [...new Set(candidates.map(tierOf))].sort((a, b) => a - b);

        for (const tier of tiers) {
          if (need <= 0) break;
          const inTier = candidates.filter((p) => tierOf(p) === tier && p.remainingUnits > 0);
          if (inTier.length === 0) continue;

          // Spread within a tier so one item does not dominate a meal, but
          // never at the cost of leaving the meal short (FR-28 outranks it).
          const spreadCap = inTier.length > 1 ? Math.max(4, Math.ceil(need / 2)) : need;

          const ranked = inTier
            .map((p) => {
              let score = 0;
              const lastDay = p.lastDayByMeal[meal];
              if (lastDay !== undefined) {
                const gap = dayIndex - lastDay;
                if (gap < VARIETY_WINDOW_DAYS) {
                  score += (VARIETY_WINDOW_DAYS - gap) * VARIETY_PENALTY_PER_DAY;
                }
              }
              score += Math.floor(rng() * JITTER_RANGE);
              return { pool: p, score };
            })
            .sort((a, b) => a.score - b.score);

          // First pass respects the spread cap; second pass lifts it so the
          // tier is fully drained before moving to less perishable food.
          for (const cap of [spreadCap, Number.MAX_SAFE_INTEGER]) {
            for (const { pool } of ranked) {
              if (need <= 0) break;
              const amount = Math.min(need, pool.remainingUnits, cap);
              if (amount <= 0) continue;
              take(pool, amount);
            }
            if (need <= 0) break;
          }
        }

        if (need > 0) {
          // FR-28: say it plainly on the meal, with the exact gap.
          const shortfall: MealSlotShortfall = { categoryKey: cat.key, units: need };
          slot.shortfalls.push(shortfall);
          complete = false;
        }
      }
    }

    days.push({
      dayIndex,
      date: addDaysIso(periodStart, dayIndex),
      meals,
    });
  }

  // FR-29: anything purchased that the plan did not consume.
  const unused: UnusedItem[] = [];
  for (const pool of pools) {
    if (pool.remainingUnits > 0) {
      unused.push({
        itemId: pool.itemId,
        itemName: pool.itemName,
        leftoverUnits: pool.remainingUnits,
        entirelyUnused: pool.remainingUnits === pool.totalUnits,
        nonCreditable: false,
      });
    }
  }
  for (const line of lines) {
    if (line.servingsUnitsSnapshot <= 0 && line.qty > 0) {
      unused.push({
        itemId: line.itemId,
        itemName: line.itemNameSnapshot,
        leftoverUnits: 0,
        entirelyUnused: true,
        nonCreditable: true,
      });
    }
  }

  return { days, unused, complete, seed };
}

/**
 * Section 5: a plan is only valid for the exact set of lines it was built
 * from. Removing or re-quantifying anything must mark the old plan stale
 * rather than leave a plan on screen that no longer matches the order.
 */
export function hashOrderLines(lines: readonly OrderLine[]): string {
  const parts = lines
    .map((l) => `${l.itemId}:${l.qty}:${l.servingsUnitsSnapshot}:${l.categorySnapshot}`)
    .sort();
  let hash = 2166136261;
  const text = parts.join('|');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Total quarter-servings the plan schedules, per category. Used by tests. */
export function scheduledUnitsByCategory(days: readonly PlanDay[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const day of days) {
    for (const meal of day.meals) {
      for (const item of meal.items) {
        out[item.categoryKey] = (out[item.categoryKey] ?? 0) + item.units;
      }
    }
  }
  return out;
}

/** Total quarter-servings the plan schedules, per item. Used by tests. */
export function scheduledUnitsByItem(days: readonly PlanDay[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const day of days) {
    for (const meal of day.meals) {
      for (const item of meal.items) {
        out[item.itemId] = (out[item.itemId] ?? 0) + item.units;
      }
    }
  }
  return out;
}
