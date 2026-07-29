/**
 * Fixed fixtures for the compliance and meal-plan tests (spec section 8).
 *
 * The numbers here are the ones from acceptance criterion 1:
 *   2 fruit / 3 vegetable / 3 protein / 4 starch per member per day,
 *   7 days, $95 per member, 3-member household
 *   => 42 / 63 / 63 / 84 servings and a $285 cap.
 */

import type {
  DietaryTag,
  Item,
  MealSplit,
  OrderLine,
  RulesSnapshot,
  ShelfLifeClass,
} from '../types';
import { servingsToUnits } from '../units';

export const CATEGORY_KEYS = ['fruit', 'vegetable', 'protein', 'starch'] as const;

export const testCategories = [
  { key: 'fruit', label: 'Fruit', unitLabel: 'cup-eq', sortOrder: 1 },
  { key: 'vegetable', label: 'Vegetable', unitLabel: 'cup-eq', sortOrder: 2 },
  { key: 'protein', label: 'Protein', unitLabel: 'oz-eq', sortOrder: 3 },
  { key: 'starch', label: 'Starch', unitLabel: 'oz-eq', sortOrder: 4 },
];

/** An even-ish split that sums to exactly 100% per category (FR-25). */
export function evenSplits(categoryKeys: readonly string[] = CATEGORY_KEYS): MealSplit[] {
  const splits: MealSplit[] = [];
  for (const key of categoryKeys) {
    splits.push({ meal: 'breakfast', categoryKey: key, fractionBp: 3000 });
    splits.push({ meal: 'lunch', categoryKey: key, fractionBp: 3500 });
    splits.push({ meal: 'supper', categoryKey: key, fractionBp: 3500 });
  }
  return splits;
}

export interface SnapshotOverrides {
  memberCount?: number;
  daysCovered?: number;
  capAmountCents?: number;
  capBasis?: 'per_member' | 'per_order';
  perMemberPerDay?: Record<string, number>;
  maxPerMemberPerDay?: Record<string, number | null>;
  minDistinctItems?: Record<string, number | null>;
  mealSplits?: MealSplit[];
  categoryKeys?: readonly string[];
  shelfLifeHorizonDays?: Record<ShelfLifeClass, number | null>;
}

/** Builds a rules snapshot exactly as the app would freeze it onto an order. */
export function makeSnapshot(overrides: SnapshotOverrides = {}): RulesSnapshot {
  const memberCount = overrides.memberCount ?? 3;
  const daysCovered = overrides.daysCovered ?? 7;
  const capAmountCents = overrides.capAmountCents ?? 9500; // $95
  const capBasis = overrides.capBasis ?? 'per_member';
  const categoryKeys = overrides.categoryKeys ?? CATEGORY_KEYS;
  const perDay = overrides.perMemberPerDay ?? {
    fruit: 2,
    vegetable: 3,
    protein: 3,
    starch: 4,
  };

  const requirements = categoryKeys.map((key) => ({
    categoryKey: key,
    servingsPerMemberPerDayUnits: servingsToUnits(perDay[key] ?? 0),
    maxServingsPerMemberPerDayUnits:
      overrides.maxPerMemberPerDay?.[key] === undefined
        ? null
        : overrides.maxPerMemberPerDay[key] === null
          ? null
          : servingsToUnits(overrides.maxPerMemberPerDay[key]!),
    minDistinctItems: overrides.minDistinctItems?.[key] ?? null,
  }));

  const requiredUnitsByCategory: Record<string, number> = {};
  for (const req of requirements) {
    requiredUnitsByCategory[req.categoryKey] =
      req.servingsPerMemberPerDayUnits * memberCount * daysCovered;
  }

  return {
    profileId: 'profile-test',
    profileFamilyId: 'family-test',
    profileVersion: 1,
    profileName: 'Test SCN Standard',
    scnName: 'Test SCN Lead Entity',
    daysCovered,
    capAmountCents,
    capBasis,
    memberCount,
    capTotalCents: capBasis === 'per_member' ? capAmountCents * memberCount : capAmountCents,
    requirements,
    mealSplits: overrides.mealSplits ?? evenSplits(categoryKeys),
    allowNonCreditableItems: true,
    shelfLifeHorizonDays:
      overrides.shelfLifeHorizonDays ??
      ({ fresh: 2, refrigerated: 4, frozen: null, shelf_stable: null } as Record<
        ShelfLifeClass,
        number | null
      >),
    categories: testCategories.filter((c) => categoryKeys.includes(c.key)),
    requiredUnitsByCategory,
    snapshotAt: '2026-01-01T00:00:00.000Z',
  };
}

let itemCounter = 0;

export function makeItem(overrides: Partial<Item> & { categoryKey: string }): Item {
  itemCounter += 1;
  return {
    id: overrides.id ?? `item-${itemCounter}`,
    name: overrides.name ?? `Item ${itemCounter}`,
    nameEs: overrides.nameEs ?? '',
    packageSize: overrides.packageSize ?? '1 lb',
    categoryKey: overrides.categoryKey,
    priceCents: overrides.priceCents ?? 100,
    servingsPerPackageUnits: overrides.servingsPerPackageUnits ?? servingsToUnits(4),
    sku: overrides.sku ?? `SKU-${itemCounter}`,
    upc: overrides.upc ?? `0000000000${itemCounter}`,
    tags: overrides.tags ?? [],
    shelfLifeClass: overrides.shelfLifeClass ?? 'shelf_stable',
    active: overrides.active ?? true,
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

let lineCounter = 0;

export function makeLine(item: Item, qty: number): OrderLine {
  lineCounter += 1;
  return {
    id: `line-${lineCounter}`,
    itemId: item.id,
    itemNameSnapshot: item.name,
    itemNameEsSnapshot: item.nameEs,
    packageSizeSnapshot: item.packageSize,
    qty,
    unitPriceCentsSnapshot: item.priceCents,
    servingsUnitsSnapshot: item.servingsPerPackageUnits,
    categorySnapshot: item.categoryKey,
    tagsSnapshot: item.tags,
    shelfLifeClassSnapshot: item.shelfLifeClass,
    addedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A catalog with several priced options per category, plus tagged variants. */
export function makeCatalog(): Item[] {
  const items: Item[] = [];
  const spec: {
    key: string;
    names: string[];
    servings: number[];
    prices: number[];
    shelf: ShelfLifeClass[];
    tags?: DietaryTag[][];
  }[] = [
    {
      key: 'fruit',
      names: ['Apples 3 lb', 'Bananas 3 lb', 'Canned Peaches', 'Raisins 15 oz'],
      servings: [6, 6, 4, 5],
      prices: [399, 249, 189, 329],
      shelf: ['fresh', 'fresh', 'shelf_stable', 'shelf_stable'],
      tags: [
        ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian'],
        ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian'],
        ['halal', 'gluten_free', 'vegan', 'vegetarian'],
        ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian'],
      ],
    },
    {
      key: 'vegetable',
      names: ['Carrots 2 lb', 'Frozen Broccoli', 'Canned Green Beans', 'Potatoes 5 lb'],
      servings: [8, 6, 4, 10],
      prices: [219, 199, 129, 449],
      shelf: ['fresh', 'frozen', 'shelf_stable', 'fresh'],
      tags: [
        ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian'],
        ['halal', 'gluten_free', 'vegan', 'vegetarian'],
        ['halal', 'gluten_free', 'vegan', 'vegetarian'],
        ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian'],
      ],
    },
    {
      key: 'protein',
      names: ['Chicken Thighs 3 lb', 'Dried Lentils 2 lb', 'Canned Tuna 5 pk', 'Peanut Butter 40 oz'],
      servings: [12, 16, 10, 14],
      prices: [749, 279, 599, 549],
      shelf: ['refrigerated', 'shelf_stable', 'shelf_stable', 'shelf_stable'],
      tags: [
        ['halal', 'gluten_free'],
        ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free'],
        ['halal', 'gluten_free', 'nut_free'],
        ['halal', 'kosher', 'gluten_free', 'vegetarian', 'vegan'],
      ],
    },
    {
      key: 'starch',
      names: ['Brown Rice 5 lb', 'Whole Wheat Pasta 2 lb', 'Oats 42 oz', 'Corn Tortillas 30 ct'],
      servings: [25, 12, 20, 15],
      prices: [549, 249, 429, 289],
      shelf: ['shelf_stable', 'shelf_stable', 'shelf_stable', 'refrigerated'],
      tags: [
        ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free'],
        ['halal', 'kosher', 'vegan', 'vegetarian', 'nut_free'],
        ['halal', 'kosher', 'vegan', 'vegetarian', 'nut_free'],
        ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free'],
      ],
    },
  ];

  for (const group of spec) {
    group.names.forEach((name, idx) => {
      items.push(
        makeItem({
          id: `${group.key}-${idx}`,
          name,
          categoryKey: group.key,
          servingsPerPackageUnits: servingsToUnits(group.servings[idx]!),
          priceCents: group.prices[idx]!,
          shelfLifeClass: group.shelf[idx]!,
          tags: group.tags?.[idx] ?? [],
        }),
      );
    });
  }

  // A non-creditable staple: budget only, zero servings (section 5).
  items.push(
    makeItem({
      id: 'other-oil',
      name: 'Vegetable Oil 48 oz',
      categoryKey: 'starch',
      servingsPerPackageUnits: 0,
      priceCents: 549,
      shelfLifeClass: 'shelf_stable',
      tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian'],
    }),
  );

  return items;
}

/** Builds a cart that exactly satisfies every category in the snapshot. */
export function makeCompliantLines(snapshot: RulesSnapshot, catalog: Item[]): OrderLine[] {
  const lines: OrderLine[] = [];
  for (const cat of snapshot.categories) {
    const required = snapshot.requiredUnitsByCategory[cat.key] ?? 0;
    if (required <= 0) continue;
    // Spread across two items per category so variety rules have something
    // to work with in the meal planner.
    const options = catalog.filter(
      (i) => i.categoryKey === cat.key && i.servingsPerPackageUnits > 0,
    );
    const half = Math.ceil(required / 2);
    const first = options[0]!;
    const second = options[1] ?? first;
    const firstQty = Math.ceil(half / first.servingsPerPackageUnits);
    const covered = firstQty * first.servingsPerPackageUnits;
    const secondQty = Math.max(
      1,
      Math.ceil(Math.max(0, required - covered) / second.servingsPerPackageUnits),
    );
    lines.push(makeLine(first, firstQty));
    if (second.id !== first.id) lines.push(makeLine(second, secondQty));
  }
  return lines;
}
