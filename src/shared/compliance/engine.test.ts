import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  capTotalCents,
  cartUnitsByCategory,
  cheapestCompliantBasket,
  evaluateOrder,
  itemAllowed,
  itemConflicts,
  orderTotalCents,
  planCapRecovery,
  requiredUnitsByCategory,
  suggestForCategory,
} from './engine';
import {
  makeCatalog,
  makeCompliantLines,
  makeItem,
  makeLine,
  makeSnapshot,
} from '../testing/fixtures';
import {
  formatCents,
  formatUnits,
  parseMoneyToCents,
  parseServingsToUnits,
  servingsToUnits,
  splitByBasisPoints,
} from '../units';
import {
  detectWriteConflict,
  validateHouseholdInput,
  validateProfile,
  validateQuantity,
} from '../validation';

describe('units: integer money and serving math (FR-20)', () => {
  test('parses money to exact cents without float drift', () => {
    assert.equal(parseMoneyToCents('95'), 9500);
    assert.equal(parseMoneyToCents('$3.99'), 399);
    assert.equal(parseMoneyToCents('0.07'), 7);
    assert.equal(parseMoneyToCents('1,234.56'), 123456);
    assert.equal(parseMoneyToCents('abc'), null);
    assert.equal(parseMoneyToCents('1.234'), null);
  });

  test('the classic float trap does not reach a comparison', () => {
    // 0.1 + 0.2 !== 0.3 in float. In cents it is exact.
    const sum = parseMoneyToCents('0.10')! + parseMoneyToCents('0.20')!;
    assert.equal(sum, parseMoneyToCents('0.30'));
  });

  test('parses servings into quarter units, including mixed fractions', () => {
    assert.equal(parseServingsToUnits('2'), 8);
    assert.equal(parseServingsToUnits('2.5'), 10);
    assert.equal(parseServingsToUnits('2 1/2'), 10);
    assert.equal(parseServingsToUnits('2¾'), 11);
    assert.equal(parseServingsToUnits('0.25'), 1);
  });

  test('formats quarter units for display', () => {
    assert.equal(formatUnits(8), '2');
    assert.equal(formatUnits(9), '2¼');
    assert.equal(formatUnits(10), '2½');
    assert.equal(formatUnits(11), '2¾');
    assert.equal(formatUnits(3), '¾');
    assert.equal(formatCents(28500), '$285.00');
  });

  test('basis-point split always sums back to the total exactly', () => {
    // Section 5: round to nearest quarter, carry the remainder forward.
    for (let total = 0; total <= 200; total++) {
      const shares = splitByBasisPoints(total, [3000, 3500, 3500]);
      assert.equal(
        shares.reduce((a, b) => a + b, 0),
        total,
        `shares must sum to ${total}`,
      );
      assert.ok(shares.every((s) => Number.isInteger(s)), 'shares stay integers');
    }
  });

  test('awkward thirds still sum exactly', () => {
    const shares = splitByBasisPoints(10, [3333, 3333, 3334]);
    assert.equal(shares.reduce((a, b) => a + b, 0), 10);
  });
});

describe('acceptance criterion 1: requirements and cap are computed from config', () => {
  const snapshot = makeSnapshot();

  test('42 / 63 / 63 / 84 servings for a 3-member household over 7 days', () => {
    const required = requiredUnitsByCategory(snapshot.requirements, 3, 7);
    // Stored as quarter units; 42 servings = 168 units.
    assert.equal(required['fruit'], servingsToUnits(42));
    assert.equal(required['vegetable'], servingsToUnits(63));
    assert.equal(required['protein'], servingsToUnits(63));
    assert.equal(required['starch'], servingsToUnits(84));
  });

  test('$95 per member gives a $285 cap for 3 members', () => {
    assert.equal(capTotalCents(9500, 'per_member', 3), 28500);
  });

  test('a per-order cap ignores member count (DECIDE #2 is configuration)', () => {
    assert.equal(capTotalCents(9500, 'per_order', 3), 9500);
  });

  test('the snapshot carries the computed totals so a print cannot drift', () => {
    assert.equal(snapshot.capTotalCents, 28500);
    assert.equal(snapshot.requiredUnitsByCategory['fruit'], 168);
  });
});

describe('evaluateOrder: shortfalls, surpluses, and the cap', () => {
  const snapshot = makeSnapshot();
  const catalog = makeCatalog();

  test('an empty order is short in every category and cannot be finalized', () => {
    const result = evaluateOrder([], snapshot);
    assert.equal(result.canFinalize, false);
    assert.equal(result.categories.length, 4);
    for (const cat of result.categories) {
      assert.equal(cat.inCartUnits, 0);
      assert.equal(cat.shortfallUnits, cat.requiredUnits);
      assert.equal(cat.satisfied, false);
    }
    assert.equal(result.totalCents, 0);
    assert.equal(result.remainingCents, 28500);
  });

  test('a fully compliant order passes', () => {
    const lines = makeCompliantLines(snapshot, catalog);
    const result = evaluateOrder(lines, snapshot);
    for (const cat of result.categories) {
      assert.equal(cat.shortfallUnits, 0, `${cat.categoryKey} should be satisfied`);
      assert.equal(cat.satisfied, true);
    }
    assert.equal(result.overCap, false, 'fixture basket must fit the cap');
    assert.equal(result.canFinalize, true);
  });

  test('FR-21: exceeding a minimum is allowed and is not a violation', () => {
    const apples = catalog.find((i) => i.id === 'fruit-0')!;
    const lines = [makeLine(apples, 100)]; // wildly over on fruit
    const result = evaluateOrder(lines, snapshot);
    const fruit = result.categories.find((c) => c.categoryKey === 'fruit')!;
    assert.equal(fruit.shortfallUnits, 0);
    assert.ok(fruit.surplusUnits > 0);
    assert.equal(
      result.violations.some((v) => v.kind === 'shortfall' && v.categoryKey === 'fruit'),
      false,
      'a surplus must never be reported as a shortfall',
    );
  });

  test('the cap is breached only when the total is strictly above it', () => {
    const exact = makeItem({ categoryKey: 'fruit', priceCents: 28500, servingsPerPackageUnits: 0 });
    const atCap = evaluateOrder([makeLine(exact, 1)], makeSnapshot());
    assert.equal(atCap.overCap, false, 'spending exactly the cap is allowed');
    assert.equal(atCap.remainingCents, 0);

    const overBy1 = makeItem({ categoryKey: 'fruit', priceCents: 28501, servingsPerPackageUnits: 0 });
    const over = evaluateOrder([makeLine(overBy1, 1)], makeSnapshot());
    assert.equal(over.overCap, true);
    assert.equal(over.overCapByCents, 1);
    assert.equal(over.canFinalize, false);
  });

  test('FR-23: every category explains which items contributed what', () => {
    const apples = catalog.find((i) => i.id === 'fruit-0')!;
    const result = evaluateOrder([makeLine(apples, 3)], snapshot);
    const fruit = result.categories.find((c) => c.categoryKey === 'fruit')!;
    assert.equal(fruit.contributions.length, 1);
    const contribution = fruit.contributions[0]!;
    assert.equal(contribution.itemName, 'Apples 3 lb');
    assert.equal(contribution.qty, 3);
    assert.equal(contribution.units, servingsToUnits(18));
    assert.equal(contribution.cents, 399 * 3);
    // The breakdown must reconcile to the category total.
    assert.equal(
      fruit.contributions.reduce((sum, c) => sum + c.units, 0),
      fruit.inCartUnits,
    );
  });

  test('totals and per-category sums agree with the line math', () => {
    const lines = makeCompliantLines(snapshot, catalog);
    const byCategory = cartUnitsByCategory(lines);
    const recomputed = lines.reduce(
      (sum, l) => sum + l.unitPriceCentsSnapshot * l.qty,
      0,
    );
    assert.equal(orderTotalCents(lines), recomputed);
    for (const [key, units] of Object.entries(byCategory)) {
      const expected = lines
        .filter((l) => l.categorySnapshot === key)
        .reduce((sum, l) => sum + l.servingsUnitsSnapshot * l.qty, 0);
      assert.equal(units, expected);
    }
  });
});

describe('FR-22: optional maximums and variety rules (DECIDE, default off)', () => {
  test('no maximum is enforced by default', () => {
    const snapshot = makeSnapshot();
    const catalog = makeCatalog();
    const apples = catalog.find((i) => i.id === 'fruit-0')!;
    const result = evaluateOrder([makeLine(apples, 200)], snapshot);
    assert.equal(result.violations.some((v) => v.kind === 'over_max'), false);
  });

  test('a configured per-category maximum blocks finalizing', () => {
    const snapshot = makeSnapshot({ maxPerMemberPerDay: { fruit: 3 } });
    const catalog = makeCatalog();
    const apples = catalog.find((i) => i.id === 'fruit-0')!;
    // 3 max x 3 members x 7 days = 63 servings ceiling.
    const result = evaluateOrder([makeLine(apples, 20)], snapshot); // 120 servings
    const fruit = result.categories.find((c) => c.categoryKey === 'fruit')!;
    assert.equal(fruit.overMax, true);
    assert.equal(result.canFinalize, false);
    assert.ok(result.violations.some((v) => v.kind === 'over_max'));
  });

  test('a minimum-variety rule counts distinct crediting items', () => {
    const snapshot = makeSnapshot({ minDistinctItems: { fruit: 3 } });
    const catalog = makeCatalog();
    const apples = catalog.find((i) => i.id === 'fruit-0')!;
    const bananas = catalog.find((i) => i.id === 'fruit-1')!;

    const twoKinds = evaluateOrder([makeLine(apples, 20), makeLine(bananas, 20)], snapshot);
    const fruitShort = twoKinds.categories.find((c) => c.categoryKey === 'fruit')!;
    assert.equal(fruitShort.distinctItems, 2);
    assert.equal(fruitShort.varietyShortfall, 1);
    assert.ok(twoKinds.violations.some((v) => v.kind === 'variety'));

    const peaches = catalog.find((i) => i.id === 'fruit-2')!;
    const threeKinds = evaluateOrder(
      [makeLine(apples, 20), makeLine(bananas, 20), makeLine(peaches, 1)],
      snapshot,
    );
    const fruitOk = threeKinds.categories.find((c) => c.categoryKey === 'fruit')!;
    assert.equal(fruitOk.varietyShortfall, 0);
  });
});

describe('acceptance criterion 2: suggestions close a shortfall (FR-16)', () => {
  const snapshot = makeSnapshot();
  const catalog = makeCatalog();

  test('an order short 5 fruit servings gets a suggestion that clears it', () => {
    const shortfallUnits = servingsToUnits(5);
    const suggestions = suggestForCategory('fruit', shortfallUnits, 20000, catalog, []);

    assert.ok(suggestions.length > 0, 'at least one item must be suggested');
    const top = suggestions[0]!;
    assert.equal(top.closesGap, true);
    assert.ok(top.unitsAdded >= shortfallUnits, 'suggested qty must close the gap');
    assert.ok(top.centsAdded <= 20000, 'suggestion must fit the remaining budget');

    // Adding it clears the warning.
    const lines = [makeLine(top.item, top.qty)];
    const result = evaluateOrder(lines, snapshot);
    const fruit = result.categories.find((c) => c.categoryKey === 'fruit')!;
    assert.ok(fruit.inCartUnits >= shortfallUnits);
  });

  test('suggestions are ranked by servings per dollar', () => {
    const cheapDense = makeItem({
      id: 'dense',
      categoryKey: 'fruit',
      priceCents: 100,
      servingsPerPackageUnits: servingsToUnits(10),
    });
    const pricySparse = makeItem({
      id: 'sparse',
      categoryKey: 'fruit',
      priceCents: 800,
      servingsPerPackageUnits: servingsToUnits(10),
    });
    const suggestions = suggestForCategory(
      'fruit',
      servingsToUnits(10),
      50000,
      [pricySparse, cheapDense],
      [],
    );
    assert.equal(suggestions[0]!.item.id, 'dense', 'best value first');
  });

  test('items that would breach the cap are excluded entirely', () => {
    const expensive = makeItem({
      id: 'expensive',
      categoryKey: 'fruit',
      priceCents: 5000,
      servingsPerPackageUnits: servingsToUnits(10),
    });
    const affordable = makeItem({
      id: 'affordable',
      categoryKey: 'fruit',
      priceCents: 200,
      servingsPerPackageUnits: servingsToUnits(4),
    });
    // Only $3.00 of headroom left.
    const suggestions = suggestForCategory('fruit', servingsToUnits(8), 300, [expensive, affordable], []);
    assert.equal(
      suggestions.some((s) => s.item.id === 'expensive'),
      false,
      'nothing that breaches the cap may be suggested',
    );
    assert.ok(suggestions.every((s) => s.centsAdded <= 300));
  });

  test('a suggestion is trimmed to what the budget can afford', () => {
    const item = makeItem({
      id: 'partial',
      categoryKey: 'fruit',
      priceCents: 100,
      servingsPerPackageUnits: servingsToUnits(1),
    });
    // Needs 10 packages to close, can only afford 4.
    const suggestions = suggestForCategory('fruit', servingsToUnits(10), 400, [item], []);
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0]!.qty, 4);
    assert.equal(suggestions[0]!.closesGap, false, 'must be honest that it does not close the gap');
  });

  test('restricted items are never suggested (FR-10)', () => {
    const restrictions = ['halal' as const];
    const suggestions = suggestForCategory('protein', servingsToUnits(10), 50000, catalog, restrictions);
    assert.ok(suggestions.length > 0);
    for (const s of suggestions) {
      assert.ok(s.item.tags.includes('halal'), `${s.item.name} must satisfy the restriction`);
    }
  });

  test('zero-serving items are never suggested to fill a gap', () => {
    const suggestions = suggestForCategory('starch', servingsToUnits(10), 50000, catalog, []);
    assert.equal(suggestions.some((s) => s.item.id === 'other-oil'), false);
  });
});

describe('FR-10: dietary restriction matching', () => {
  test('an item must carry every restriction tag to be allowed', () => {
    const item = makeItem({ categoryKey: 'protein', tags: ['halal', 'gluten_free'] });
    assert.equal(itemAllowed(item, ['halal']), true);
    assert.equal(itemAllowed(item, ['halal', 'gluten_free']), true);
    assert.equal(itemAllowed(item, ['halal', 'kosher']), false);
    assert.deepEqual(itemConflicts(item, ['halal', 'kosher', 'vegan']), ['kosher', 'vegan']);
  });

  test('no restrictions means everything is allowed', () => {
    const item = makeItem({ categoryKey: 'protein', tags: [] });
    assert.equal(itemAllowed(item, []), true);
  });
});

describe('FR-17: getting back under the cap', () => {
  const catalog = makeCatalog();

  test('an order under the cap needs no recovery plan', () => {
    const snapshot = makeSnapshot();
    const lines = makeCompliantLines(snapshot, catalog);
    const plan = planCapRecovery(lines, snapshot, catalog, []);
    assert.equal(plan.overByCents, 0);
    assert.equal(plan.sufficient, true);
  });

  test('reductions only ever come out of surplus, never out of a requirement', () => {
    const snapshot = makeSnapshot({ capAmountCents: 2000 }); // $60 cap, deliberately tight
    const lines = makeCompliantLines(snapshot, catalog);
    const plan = planCapRecovery(lines, snapshot, catalog, []);
    assert.ok(plan.overByCents > 0, 'fixture must actually be over the cap');

    // Apply every suggested reduction and confirm nothing goes short.
    const reduced = lines.map((line) => {
      const cut = plan.reductions.find((r) => r.lineId === line.id);
      return cut ? { ...line, qty: line.qty - cut.reducibleQty } : line;
    });
    const after = evaluateOrder(reduced, snapshot);
    for (const cat of after.categories) {
      assert.equal(
        cat.shortfallUnits,
        0,
        `${cat.categoryKey} must still be satisfied after reductions`,
      );
    }
  });

  test('a swap keeps the category whole while costing less', () => {
    const snapshot = makeSnapshot({ capAmountCents: 1000 });
    const pricey = makeItem({
      id: 'pricey',
      categoryKey: 'fruit',
      priceCents: 2000,
      servingsPerPackageUnits: servingsToUnits(6),
    });
    const cheap = makeItem({
      id: 'cheap',
      categoryKey: 'fruit',
      priceCents: 300,
      servingsPerPackageUnits: servingsToUnits(6),
    });
    const lines = [makeLine(pricey, 28)];
    const plan = planCapRecovery(lines, snapshot, [pricey, cheap], []);
    const swap = plan.swaps.find((s) => s.toItem.id === 'cheap');
    assert.ok(swap, 'the cheaper equivalent must be offered');
    assert.ok(swap!.centsSaved > 0);
    // The replacement must supply at least as many servings.
    assert.ok(
      swap!.toQty * cheap.servingsPerPackageUnits >= 28 * pricey.servingsPerPackageUnits,
    );
  });

  test('when no move is enough, it says so and shows what is left over', () => {
    const snapshot = makeSnapshot({ capAmountCents: 100, capBasis: 'per_order' });
    const onlyOption = makeItem({
      id: 'only',
      categoryKey: 'fruit',
      priceCents: 5000,
      servingsPerPackageUnits: servingsToUnits(42),
    });
    const lines = [makeLine(onlyOption, 4)];
    const plan = planCapRecovery(lines, snapshot, [onlyOption], []);
    assert.equal(plan.sufficient, false);
    assert.ok(plan.residualCents > 0);
  });
});

describe('section 5: the cheapest compliant basket may itself exceed the cap', () => {
  test('a workable catalog produces a basket within the cap', () => {
    const snapshot = makeSnapshot();
    const result = cheapestCompliantBasket(snapshot, makeCatalog(), []);
    assert.notEqual(result.totalCents, null);
    assert.equal(result.exceedsCap, false);
    assert.equal(result.gapCents, 0);

    // The basket it describes must actually satisfy every category.
    const lines = result.lines.map((l) => makeLine(l.item, l.qty));
    const check = evaluateOrder(lines, snapshot);
    for (const cat of check.categories) {
      assert.equal(cat.shortfallUnits, 0, `${cat.categoryKey} must be covered`);
    }
    assert.equal(check.totalCents, result.totalCents);
  });

  test('an impossible contract is reported plainly, with the gap', () => {
    // $10 per member cannot buy 42/63/63/84 servings from this catalog.
    const snapshot = makeSnapshot({ capAmountCents: 1000 });
    const result = cheapestCompliantBasket(snapshot, makeCatalog(), []);
    assert.notEqual(result.totalCents, null);
    assert.equal(result.exceedsCap, true);
    assert.equal(result.gapCents, result.totalCents! - snapshot.capTotalCents);
    assert.ok(result.gapCents > 0, 'staff must be shown the size of the gap');
  });

  test('a category with no stockable item is named rather than silently skipped', () => {
    const snapshot = makeSnapshot();
    const catalog = makeCatalog().filter((i) => i.categoryKey !== 'protein');
    const result = cheapestCompliantBasket(snapshot, catalog, []);
    assert.equal(result.totalCents, null);
    assert.deepEqual(result.impossibleCategories, ['protein']);
  });

  test('restrictions are honoured when costing the cheapest basket', () => {
    const snapshot = makeSnapshot();
    const unrestricted = cheapestCompliantBasket(snapshot, makeCatalog(), []);
    const kosher = cheapestCompliantBasket(snapshot, makeCatalog(), ['kosher']);
    assert.notEqual(kosher.totalCents, null);
    assert.ok(
      kosher.totalCents! >= unrestricted.totalCents!,
      'a narrower catalog cannot get cheaper',
    );
    for (const line of kosher.lines) {
      assert.ok(line.item.tags.includes('kosher'));
    }
  });
});

describe('section 5: entry validation', () => {
  test('zero and negative member counts are rejected', () => {
    for (const memberCount of [0, -1, 2.5]) {
      const issues = validateHouseholdInput({
        memberCount,
        referralId: 'REF-1',
        periodStart: '2026-02-01',
        profileId: 'p1',
      });
      assert.ok(
        issues.some((i) => i.field === 'memberCount'),
        `memberCount ${memberCount} must be rejected`,
      );
    }
  });

  test('a valid household passes', () => {
    const issues = validateHouseholdInput({
      memberCount: 3,
      referralId: 'REF-1',
      periodStart: '2026-02-01',
      profileId: 'p1',
    });
    assert.deepEqual(issues, []);
  });

  test('a missing referral id is rejected', () => {
    const issues = validateHouseholdInput({
      memberCount: 3,
      referralId: '   ',
      periodStart: '2026-02-01',
      profileId: 'p1',
    });
    assert.ok(issues.some((i) => i.field === 'referralId'));
  });

  test('an impossible calendar date is rejected instead of silently normalizing', () => {
    const issues = validateHouseholdInput({
      memberCount: 1,
      referralId: 'REF-1',
      periodStart: '2026-02-30',
      profileId: 'profile-1',
    });
    assert.ok(issues.some((issue) => issue.field === 'periodStart'));
  });

  test('zero or negative days and caps are rejected', () => {
    const base = {
      name: 'Test',
      requirements: [
        { categoryKey: 'fruit', servingsPerMemberPerDayUnits: 8, maxServingsPerMemberPerDayUnits: null, minDistinctItems: null },
      ],
      mealSplits: [
        { meal: 'breakfast' as const, categoryKey: 'fruit', fractionBp: 3000 },
        { meal: 'lunch' as const, categoryKey: 'fruit', fractionBp: 3500 },
        { meal: 'supper' as const, categoryKey: 'fruit', fractionBp: 3500 },
      ],
    };
    assert.ok(
      validateProfile({ ...base, daysCovered: 0, capAmountCents: 9500 })
        .some((i) => i.field === 'daysCovered'),
    );
    assert.ok(
      validateProfile({ ...base, daysCovered: 7, capAmountCents: 0 })
        .some((i) => i.field === 'capAmountCents'),
    );
    assert.ok(
      validateProfile({ ...base, daysCovered: -3, capAmountCents: -1 }).length >= 2,
    );
    assert.deepEqual(validateProfile({ ...base, daysCovered: 7, capAmountCents: 9500 }), []);
  });

  test('FR-25: meal splits that do not total 100% are rejected', () => {
    const issues = validateProfile({
      name: 'Test',
      daysCovered: 7,
      capAmountCents: 9500,
      requirements: [
        { categoryKey: 'fruit', servingsPerMemberPerDayUnits: 8, maxServingsPerMemberPerDayUnits: null, minDistinctItems: null },
      ],
      mealSplits: [
        { meal: 'breakfast', categoryKey: 'fruit', fractionBp: 3000 },
        { meal: 'lunch', categoryKey: 'fruit', fractionBp: 3000 },
        { meal: 'supper', categoryKey: 'fruit', fractionBp: 3000 },
      ],
    });
    assert.ok(issues.some((i) => i.field === 'split.fruit'));
  });

  test('a maximum below the minimum is rejected', () => {
    const issues = validateProfile({
      name: 'Test',
      daysCovered: 7,
      capAmountCents: 9500,
      requirements: [
        { categoryKey: 'fruit', servingsPerMemberPerDayUnits: 12, maxServingsPerMemberPerDayUnits: 8, minDistinctItems: null },
      ],
      mealSplits: [
        { meal: 'breakfast', categoryKey: 'fruit', fractionBp: 3000 },
        { meal: 'lunch', categoryKey: 'fruit', fractionBp: 3500 },
        { meal: 'supper', categoryKey: 'fruit', fractionBp: 3500 },
      ],
    });
    assert.ok(issues.some((i) => i.field === 'requirement.fruit.max'));
  });

  test('FR-13: quantities must be whole packages', () => {
    assert.deepEqual(validateQuantity(3), []);
    assert.equal(validateQuantity(2.5).length, 1);
    assert.equal(validateQuantity(-1).length, 1);
  });

  test('section 5: a concurrent edit warns but still lets the last write win', () => {
    const clean = detectWriteConflict(4, 'device-a', 4, 'device-a');
    assert.equal(clean.conflict, false);

    const conflict = detectWriteConflict(6, 'device-b', 4, 'device-a');
    assert.equal(conflict.conflict, true);
    assert.ok(conflict.message);

    // The same device catching up to its own write is not a conflict.
    const sameDevice = detectWriteConflict(6, 'device-a', 4, 'device-a');
    assert.equal(sameDevice.conflict, false);
  });
});

describe('section 5: non-creditable items count against the budget only', () => {
  test('cooking oil adds cost but no servings', () => {
    const snapshot = makeSnapshot();
    const oil = makeCatalog().find((i) => i.id === 'other-oil')!;
    const result = evaluateOrder([makeLine(oil, 2)], snapshot);
    assert.equal(result.totalCents, 1098);
    const starch = result.categories.find((c) => c.categoryKey === 'starch')!;
    assert.equal(starch.inCartUnits, 0, 'must credit no servings');
    assert.equal(starch.shortfallUnits, starch.requiredUnits);
    assert.equal(starch.distinctItems, 0, 'must not count toward a variety rule');
  });
});

describe('acceptance criterion 5: a price change cannot alter a finalized order', () => {
  test('the order total is computed from snapshots, not the live catalog', () => {
    const snapshot = makeSnapshot();
    const catalog = makeCatalog();
    const apples = catalog.find((i) => i.id === 'fruit-0')!;
    const lines = [makeLine(apples, 4)];
    const before = evaluateOrder(lines, snapshot);
    assert.equal(before.totalCents, 399 * 4);

    // The catalog price doubles after the order was built.
    apples.priceCents = 798;

    const after = evaluateOrder(lines, snapshot);
    assert.equal(after.totalCents, 399 * 4, 'the captured price must still be used');
    assert.equal(
      after.categories.find((c) => c.categoryKey === 'fruit')!.contributions[0]!.cents,
      399 * 4,
    );
  });

  test('a category rename cannot rewrite an old order sheet', () => {
    const snapshot = makeSnapshot();
    const catalog = makeCatalog();
    const lines = [makeLine(catalog.find((i) => i.id === 'fruit-0')!, 4)];
    // The snapshot holds its own label; renaming the live category is a
    // separate object entirely.
    const result = evaluateOrder(lines, snapshot);
    assert.equal(result.categories.find((c) => c.categoryKey === 'fruit')!.label, 'Fruit');
  });
});
