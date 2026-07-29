import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDaysIso,
  generateMealPlan,
  hashOrderLines,
  mealAllocationForCategory,
  scheduledUnitsByCategory,
  scheduledUnitsByItem,
} from './planner';
import { cartUnitsByCategory } from '../compliance/engine';
import {
  evenSplits,
  makeCatalog,
  makeCompliantLines,
  makeItem,
  makeLine,
  makeSnapshot,
} from '../testing/fixtures';
import { servingsToUnits, UNITS_PER_SERVING } from '../units';
import { MEAL_KEYS } from '../types';

const PERIOD_START = '2026-02-02';

describe('date arithmetic', () => {
  test('adds days without timezone drift', () => {
    assert.equal(addDaysIso('2026-02-02', 0), '2026-02-02');
    assert.equal(addDaysIso('2026-02-02', 6), '2026-02-08');
    assert.equal(addDaysIso('2026-02-26', 3), '2026-03-01');
    // Across a DST boundary in US timezones.
    assert.equal(addDaysIso('2026-03-07', 2), '2026-03-09');
    // Leap year.
    assert.equal(addDaysIso('2028-02-28', 1), '2028-02-29');
  });
});

describe('FR-25 + section 5: meal splits allocate the daily requirement exactly', () => {
  test('the three meals always sum to the daily total', () => {
    const snapshot = makeSnapshot();
    // 2 fruit servings/member/day x 3 members = 6 servings = 24 quarter units.
    const daily = 24;
    const allocation = mealAllocationForCategory(snapshot, 'fruit', daily);
    const sum = MEAL_KEYS.reduce((acc, meal) => acc + allocation[meal], 0);
    assert.equal(sum, daily);
  });

  test('a fractional split rounds to a quarter serving and carries the remainder', () => {
    const snapshot = makeSnapshot({
      mealSplits: [
        { meal: 'breakfast', categoryKey: 'fruit', fractionBp: 3333 },
        { meal: 'lunch', categoryKey: 'fruit', fractionBp: 3333 },
        { meal: 'supper', categoryKey: 'fruit', fractionBp: 3334 },
      ],
    });
    for (let daily = 0; daily <= 120; daily++) {
      const allocation = mealAllocationForCategory(snapshot, 'fruit', daily);
      const sum = MEAL_KEYS.reduce((acc, meal) => acc + allocation[meal], 0);
      assert.equal(sum, daily, `daily total must stay exact at ${daily}`);
      for (const meal of MEAL_KEYS) {
        assert.ok(Number.isInteger(allocation[meal]), 'allocations stay whole quarter servings');
        assert.ok(allocation[meal] >= 0, 'no negative allocation');
      }
    }
  });

  test('an unconfigured category falls back to an even split rather than vanishing', () => {
    const snapshot = makeSnapshot({ mealSplits: [] });
    const allocation = mealAllocationForCategory(snapshot, 'fruit', 24);
    assert.equal(MEAL_KEYS.reduce((acc, m) => acc + allocation[m], 0), 24);
    assert.ok(MEAL_KEYS.every((m) => allocation[m] > 0));
  });
});

describe('acceptance criterion 4: a compliant order produces a full 7-day plan', () => {
  const snapshot = makeSnapshot();
  const catalog = makeCatalog();
  const lines = makeCompliantLines(snapshot, catalog);
  const plan = generateMealPlan({
    lines,
    snapshot,
    periodStart: PERIOD_START,
    restrictions: [],
    seed: 12345,
  });

  test('covers every day of the benefit period with three meals', () => {
    assert.equal(plan.days.length, 7);
    plan.days.forEach((day, idx) => {
      assert.equal(day.dayIndex, idx);
      assert.equal(day.date, addDaysIso(PERIOD_START, idx));
      assert.equal(day.meals.length, 3);
      assert.deepEqual(day.meals.map((m) => m.meal), ['breakfast', 'lunch', 'supper']);
    });
  });

  test('every meal is filled — no shortfalls anywhere', () => {
    for (const day of plan.days) {
      for (const meal of day.meals) {
        assert.deepEqual(
          meal.shortfalls,
          [],
          `${day.date} ${meal.meal} should be fully filled`,
        );
      }
    }
    assert.equal(plan.complete, true);
  });

  test('servings allocated never exceed servings purchased, per item', () => {
    const purchasedByItem: Record<string, number> = {};
    for (const line of lines) {
      purchasedByItem[line.itemId] =
        (purchasedByItem[line.itemId] ?? 0) + line.servingsUnitsSnapshot * line.qty;
    }
    const scheduled = scheduledUnitsByItem(plan.days);
    for (const [itemId, units] of Object.entries(scheduled)) {
      assert.ok(
        units <= (purchasedByItem[itemId] ?? 0),
        `${itemId}: scheduled ${units} exceeds purchased ${purchasedByItem[itemId]}`,
      );
    }
  });

  test('servings allocated never exceed servings purchased, per category', () => {
    const purchased = cartUnitsByCategory(lines);
    const scheduled = scheduledUnitsByCategory(plan.days);
    for (const [key, units] of Object.entries(scheduled)) {
      assert.ok(units <= (purchased[key] ?? 0), `${key}: ${units} > ${purchased[key]}`);
    }
  });

  test('the plan schedules exactly the required servings per category', () => {
    const scheduled = scheduledUnitsByCategory(plan.days);
    for (const cat of snapshot.categories) {
      const required = snapshot.requiredUnitsByCategory[cat.key] ?? 0;
      assert.equal(
        scheduled[cat.key] ?? 0,
        required,
        `${cat.key} should schedule the full requirement`,
      );
    }
  });

  test('FR-29: purchased items the plan never used are listed', () => {
    const scheduled = scheduledUnitsByItem(plan.days);
    const purchasedByItem: Record<string, number> = {};
    for (const line of lines) {
      purchasedByItem[line.itemId] =
        (purchasedByItem[line.itemId] ?? 0) + line.servingsUnitsSnapshot * line.qty;
    }
    for (const [itemId, purchased] of Object.entries(purchasedByItem)) {
      const used = scheduled[itemId] ?? 0;
      if (used < purchased) {
        const reported = plan.unused.find((u) => u.itemId === itemId);
        assert.ok(reported, `${itemId} has ${purchased - used} left over and must be reported`);
        assert.equal(reported!.leftoverUnits, purchased - used);
      }
    }
  });
});

describe('FR-28: a meal that cannot be filled says so', () => {
  test('an under-supplied order reports the exact shortfall, never a thin meal', () => {
    const snapshot = makeSnapshot();
    const catalog = makeCatalog();
    const apples = catalog.find((i) => i.id === 'fruit-0')!;
    // Only fruit, and not even enough of it. Everything else is missing.
    const lines = [makeLine(apples, 1)];
    const plan = generateMealPlan({
      lines,
      snapshot,
      periodStart: PERIOD_START,
      restrictions: [],
      seed: 7,
    });

    assert.equal(plan.complete, false);
    const allShortfalls = plan.days.flatMap((d) => d.meals.flatMap((m) => m.shortfalls));
    assert.ok(allShortfalls.length > 0, 'shortfalls must be reported explicitly');

    // Vegetables were never purchased, so every vegetable allocation is short.
    const vegShort = allShortfalls.filter((s) => s.categoryKey === 'vegetable');
    const totalVegShort = vegShort.reduce((sum, s) => sum + s.units, 0);
    assert.equal(
      totalVegShort,
      snapshot.requiredUnitsByCategory['vegetable'],
      'the reported shortfall must equal the entire missing requirement',
    );

    // Nothing was invented: only apples appear anywhere in the plan.
    const scheduled = scheduledUnitsByItem(plan.days);
    assert.deepEqual(Object.keys(scheduled), ['fruit-0']);
    assert.ok(scheduled['fruit-0']! <= apples.servingsPerPackageUnits);
  });
});

describe('section 5: a household of one still gets a full plan', () => {
  test('three meals a day, every day, for a single member', () => {
    const snapshot = makeSnapshot({ memberCount: 1 });
    const catalog = makeCatalog();
    const lines = makeCompliantLines(snapshot, catalog);
    const plan = generateMealPlan({
      lines,
      snapshot,
      periodStart: PERIOD_START,
      restrictions: [],
      seed: 99,
    });

    assert.equal(plan.days.length, 7);
    assert.equal(plan.complete, true);
    for (const day of plan.days) {
      assert.equal(day.meals.length, 3);
      for (const meal of day.meals) {
        assert.ok(meal.items.length > 0, `${day.date} ${meal.meal} must have food in it`);
        assert.deepEqual(meal.shortfalls, []);
      }
    }
  });

  test('a single member still gets whole quarter-serving allocations', () => {
    const snapshot = makeSnapshot({ memberCount: 1 });
    // 2 fruit servings/day for 1 member = 8 quarter units across 3 meals.
    const allocation = mealAllocationForCategory(snapshot, 'fruit', 8);
    assert.equal(MEAL_KEYS.reduce((acc, m) => acc + allocation[m], 0), 8);
    for (const meal of MEAL_KEYS) {
      assert.ok(Number.isInteger(allocation[meal]));
    }
  });
});

describe('FR-26: variety across days', () => {
  test('the same item does not fill the same meal slot every day when alternatives exist', () => {
    const snapshot = makeSnapshot({
      perMemberPerDay: { fruit: 2 },
      categoryKeys: ['fruit'],
      mealSplits: evenSplits(['fruit']),
    });
    // Four interchangeable fruits, each with plenty of servings.
    const options = [0, 1, 2, 3].map((n) =>
      makeItem({
        id: `f${n}`,
        name: `Fruit ${n}`,
        categoryKey: 'fruit',
        servingsPerPackageUnits: servingsToUnits(20),
        priceCents: 300,
        shelfLifeClass: 'shelf_stable',
      }),
    );
    const lines = options.map((item) => makeLine(item, 3));
    const plan = generateMealPlan({
      lines,
      snapshot,
      periodStart: PERIOD_START,
      restrictions: [],
      seed: 4242,
    });

    for (const meal of MEAL_KEYS) {
      const perDayItems = plan.days.map(
        (d) => d.meals.find((m) => m.meal === meal)!.items.map((i) => i.itemId).sort().join(','),
      );
      const distinct = new Set(perDayItems);
      assert.ok(
        distinct.size > 1,
        `${meal} used the same combination all 7 days: ${perDayItems[0]}`,
      );
    }
  });

  test('a single available item is still used rather than left short', () => {
    const snapshot = makeSnapshot({
      perMemberPerDay: { fruit: 2 },
      categoryKeys: ['fruit'],
      mealSplits: evenSplits(['fruit']),
    });
    const only = makeItem({
      id: 'only-fruit',
      categoryKey: 'fruit',
      servingsPerPackageUnits: servingsToUnits(42),
      priceCents: 500,
    });
    const plan = generateMealPlan({
      lines: [makeLine(only, 1)],
      snapshot,
      periodStart: PERIOD_START,
      restrictions: [],
      seed: 1,
    });
    // Variety is a preference; filling the meal wins.
    assert.equal(plan.complete, true);
  });
});

describe('FR-27: perishables are scheduled early', () => {
  test('fresh produce lands in the earlier days, shelf-stable later', () => {
    const snapshot = makeSnapshot({
      perMemberPerDay: { fruit: 2 },
      categoryKeys: ['fruit'],
      mealSplits: evenSplits(['fruit']),
      shelfLifeHorizonDays: { fresh: 2, refrigerated: 4, frozen: null, shelf_stable: null },
    });
    const fresh = makeItem({
      id: 'fresh-fruit',
      categoryKey: 'fruit',
      servingsPerPackageUnits: servingsToUnits(21),
      priceCents: 400,
      shelfLifeClass: 'fresh',
    });
    const stable = makeItem({
      id: 'stable-fruit',
      categoryKey: 'fruit',
      servingsPerPackageUnits: servingsToUnits(21),
      priceCents: 400,
      shelfLifeClass: 'shelf_stable',
    });
    const plan = generateMealPlan({
      lines: [makeLine(fresh, 1), makeLine(stable, 1)],
      snapshot,
      periodStart: PERIOD_START,
      restrictions: [],
      seed: 55,
    });

    const freshByDay = plan.days.map((d) =>
      d.meals.flatMap((m) => m.items.filter((i) => i.itemId === 'fresh-fruit')).reduce((s, i) => s + i.units, 0),
    );
    const stableByDay = plan.days.map((d) =>
      d.meals.flatMap((m) => m.items.filter((i) => i.itemId === 'stable-fruit')).reduce((s, i) => s + i.units, 0),
    );

    const freshEarly = freshByDay.slice(0, 3).reduce((a, b) => a + b, 0);
    const freshLate = freshByDay.slice(3).reduce((a, b) => a + b, 0);
    assert.ok(
      freshEarly > freshLate,
      `fresh should be weighted early, got early=${freshEarly} late=${freshLate}`,
    );

    const stableLate = stableByDay.slice(3).reduce((a, b) => a + b, 0);
    assert.ok(stableLate > 0, 'shelf-stable food should carry the later days');
  });

  test('perishables are still used rather than wasted when nothing else is left', () => {
    const snapshot = makeSnapshot({
      perMemberPerDay: { fruit: 2 },
      categoryKeys: ['fruit'],
      mealSplits: evenSplits(['fruit']),
      shelfLifeHorizonDays: { fresh: 1, refrigerated: 1, frozen: null, shelf_stable: null },
    });
    const fresh = makeItem({
      id: 'fresh-only',
      categoryKey: 'fruit',
      servingsPerPackageUnits: servingsToUnits(42),
      priceCents: 400,
      shelfLifeClass: 'fresh',
    });
    const plan = generateMealPlan({
      lines: [makeLine(fresh, 1)],
      snapshot,
      periodStart: PERIOD_START,
      restrictions: [],
      seed: 8,
    });
    // The horizon is a ranking preference, not a hard block that would
    // manufacture shortfalls out of food the household actually has.
    assert.equal(plan.complete, true);
  });
});

describe('FR-30: regenerate produces a different valid arrangement', () => {
  const snapshot = makeSnapshot();
  const catalog = makeCatalog();
  const lines = makeCompliantLines(snapshot, catalog);

  test('a different seed rearranges the plan', () => {
    const a = generateMealPlan({ lines, snapshot, periodStart: PERIOD_START, restrictions: [], seed: 1 });
    const b = generateMealPlan({ lines, snapshot, periodStart: PERIOD_START, restrictions: [], seed: 2 });
    assert.notEqual(JSON.stringify(a.days), JSON.stringify(b.days), 'a reroll must differ');
  });

  test('the same seed reproduces the plan exactly', () => {
    const a = generateMealPlan({ lines, snapshot, periodStart: PERIOD_START, restrictions: [], seed: 777 });
    const b = generateMealPlan({ lines, snapshot, periodStart: PERIOD_START, restrictions: [], seed: 777 });
    assert.deepEqual(a.days, b.days);
  });

  test('every reroll is still valid: filled, and within what was purchased', () => {
    const purchased = cartUnitsByCategory(lines);
    for (let seed = 1; seed <= 25; seed++) {
      const plan = generateMealPlan({ lines, snapshot, periodStart: PERIOD_START, restrictions: [], seed });
      assert.equal(plan.complete, true, `seed ${seed} must produce a complete plan`);
      const scheduled = scheduledUnitsByCategory(plan.days);
      for (const [key, units] of Object.entries(scheduled)) {
        assert.ok(units <= (purchased[key] ?? 0), `seed ${seed}: ${key} over-allocated`);
      }
    }
  });
});

describe('FR-10: restricted items never appear in the plan', () => {
  test('an item missing a required tag is never scheduled', () => {
    const snapshot = makeSnapshot({
      perMemberPerDay: { protein: 3 },
      categoryKeys: ['protein'],
      mealSplits: evenSplits(['protein']),
    });
    const halal = makeItem({
      id: 'halal-protein',
      categoryKey: 'protein',
      servingsPerPackageUnits: servingsToUnits(63),
      priceCents: 900,
      tags: ['halal'],
    });
    const notHalal = makeItem({
      id: 'other-protein',
      categoryKey: 'protein',
      servingsPerPackageUnits: servingsToUnits(63),
      priceCents: 300,
      tags: [],
    });
    const plan = generateMealPlan({
      lines: [makeLine(halal, 1), makeLine(notHalal, 1)],
      snapshot,
      periodStart: PERIOD_START,
      restrictions: ['halal'],
      seed: 3,
    });

    const scheduled = scheduledUnitsByItem(plan.days);
    assert.equal(scheduled['other-protein'], undefined, 'restricted item must never be placed');
    assert.ok((scheduled['halal-protein'] ?? 0) > 0);
    // And the unusable purchase is reported rather than hidden.
    assert.ok(plan.unused.some((u) => u.itemId === 'other-protein' && u.entirelyUnused));
  });
});

describe('section 5: non-creditable items and plan staleness', () => {
  test('a zero-serving item is reported as purchased but unschedulable', () => {
    const snapshot = makeSnapshot();
    const catalog = makeCatalog();
    const lines = [...makeCompliantLines(snapshot, catalog), makeLine(catalog.find((i) => i.id === 'other-oil')!, 1)];
    const plan = generateMealPlan({ lines, snapshot, periodStart: PERIOD_START, restrictions: [], seed: 11 });

    const oil = plan.unused.find((u) => u.itemId === 'other-oil');
    assert.ok(oil, 'the oil must appear in the unused report');
    assert.equal(oil!.nonCreditable, true);
    assert.equal(oil!.entirelyUnused, true);
  });

  test('changing the order changes its line hash, so the old plan is stale', () => {
    const catalog = makeCatalog();
    const snapshot = makeSnapshot();
    const lines = makeCompliantLines(snapshot, catalog);
    const original = hashOrderLines(lines);

    assert.equal(hashOrderLines(lines.slice().reverse()), original, 'order of lines must not matter');

    const removed = lines.slice(1);
    assert.notEqual(hashOrderLines(removed), original, 'removing an item must invalidate the plan');

    const requantified = lines.map((l, i) => (i === 0 ? { ...l, qty: l.qty + 1 } : l));
    assert.notEqual(hashOrderLines(requantified), original, 'a quantity change must invalidate the plan');
  });
});

describe('the plan never breaks its own arithmetic', () => {
  test('every scheduled amount is a whole number of quarter servings', () => {
    const snapshot = makeSnapshot();
    const catalog = makeCatalog();
    const lines = makeCompliantLines(snapshot, catalog);
    const plan = generateMealPlan({ lines, snapshot, periodStart: PERIOD_START, restrictions: [], seed: 31 });

    for (const day of plan.days) {
      for (const meal of day.meals) {
        for (const item of meal.items) {
          assert.ok(Number.isInteger(item.units), 'units must be integers');
          assert.ok(item.units > 0, 'a zero-serving entry should never be emitted');
        }
        for (const short of meal.shortfalls) {
          assert.ok(Number.isInteger(short.units));
        }
      }
    }
  });

  test('a day total matches the household daily requirement', () => {
    const snapshot = makeSnapshot();
    const catalog = makeCatalog();
    const lines = makeCompliantLines(snapshot, catalog);
    const plan = generateMealPlan({ lines, snapshot, periodStart: PERIOD_START, restrictions: [], seed: 12 });

    for (const day of plan.days) {
      for (const cat of snapshot.categories) {
        const req = snapshot.requirements.find((r) => r.categoryKey === cat.key)!;
        const dailyUnits = req.servingsPerMemberPerDayUnits * snapshot.memberCount;
        const served = day.meals
          .flatMap((m) => m.items.filter((i) => i.categoryKey === cat.key))
          .reduce((sum, i) => sum + i.units, 0);
        const short = day.meals
          .flatMap((m) => m.shortfalls.filter((s) => s.categoryKey === cat.key))
          .reduce((sum, s) => sum + s.units, 0);
        assert.equal(
          served + short,
          dailyUnits,
          `${day.date} ${cat.key}: served + shortfall must equal the daily requirement`,
        );
      }
    }
  });

  test('a 30-day period is handled as readily as a 7-day one', () => {
    const snapshot = makeSnapshot({ daysCovered: 30, capAmountCents: 40000 });
    const catalog = makeCatalog();
    const lines = makeCompliantLines(snapshot, catalog);
    const plan = generateMealPlan({ lines, snapshot, periodStart: PERIOD_START, restrictions: [], seed: 5 });
    assert.equal(plan.days.length, 30);
    assert.equal(plan.complete, true);
    assert.equal(plan.days[29]!.date, addDaysIso(PERIOD_START, 29));
  });

  test('one whole serving is four quarter units, everywhere', () => {
    assert.equal(UNITS_PER_SERVING, 4);
    assert.equal(servingsToUnits(1), 4);
  });
});
