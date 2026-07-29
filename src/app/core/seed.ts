/**
 * First-run seed data.
 *
 * Everything here is editable in the admin screens — none of it is a constant
 * the compliance engine reads. The starting profile deliberately matches the
 * numbers in acceptance criterion 1 so the tool can be checked against the
 * spec the moment it opens, but the owner is expected to replace it with the
 * real SCN contract terms (spec section 1, DECIDE #1-#5).
 */

import type { Category, Item, MealSplit, ProgramProfile, ShelfLifeClass } from '../../shared/types';
import { MEAL_KEYS } from '../../shared/types';
import { servingsToUnits } from '../../shared/units';
import { newId } from '../../shared/ids';

export const SEED_CATEGORIES: Category[] = [
  { id: 'cat-fruit', key: 'fruit', label: 'Fruit', unitLabel: 'cup-eq', sortOrder: 1, active: true },
  { id: 'cat-vegetable', key: 'vegetable', label: 'Vegetable', unitLabel: 'cup-eq', sortOrder: 2, active: true },
  { id: 'cat-protein', key: 'protein', label: 'Protein', unitLabel: 'oz-eq', sortOrder: 3, active: true },
  { id: 'cat-starch', key: 'starch', label: 'Starch / Grain', unitLabel: 'oz-eq', sortOrder: 4, active: true },
];

/**
 * A 30 / 35 / 35 split across breakfast / lunch / supper for every category.
 * Sums to exactly 100% per category, as FR-25 requires.
 */
export function defaultMealSplits(categoryKeys: readonly string[]): MealSplit[] {
  const weights: Record<string, number> = { breakfast: 3000, lunch: 3500, supper: 3500 };
  const splits: MealSplit[] = [];
  for (const key of categoryKeys) {
    for (const meal of MEAL_KEYS) {
      splits.push({ meal, categoryKey: key, fractionBp: weights[meal] ?? 0 });
    }
  }
  return splits;
}

export const DEFAULT_SHELF_LIFE_HORIZONS: Record<ShelfLifeClass, number | null> = {
  fresh: 2,
  refrigerated: 4,
  frozen: null,
  shelf_stable: null,
};

export function seedProfile(): ProgramProfile {
  const familyId = 'family-default';
  return {
    id: 'profile-default-v1',
    familyId,
    version: 1,
    name: 'Standard household (example)',
    scnName: 'SCN lead entity — replace with the real contract',
    effectiveFrom: new Date().toISOString().slice(0, 10),
    effectiveTo: null,
    daysCovered: 7,
    capAmountCents: 9500,
    capBasis: 'per_member',
    requirements: [
      { categoryKey: 'fruit', servingsPerMemberPerDayUnits: servingsToUnits(2), maxServingsPerMemberPerDayUnits: null, minDistinctItems: null },
      { categoryKey: 'vegetable', servingsPerMemberPerDayUnits: servingsToUnits(3), maxServingsPerMemberPerDayUnits: null, minDistinctItems: null },
      { categoryKey: 'protein', servingsPerMemberPerDayUnits: servingsToUnits(3), maxServingsPerMemberPerDayUnits: null, minDistinctItems: null },
      { categoryKey: 'starch', servingsPerMemberPerDayUnits: servingsToUnits(4), maxServingsPerMemberPerDayUnits: null, minDistinctItems: null },
    ],
    mealSplits: defaultMealSplits(['fruit', 'vegetable', 'protein', 'starch']),
    allowNonCreditableItems: true,
    shelfLifeHorizonDays: { ...DEFAULT_SHELF_LIFE_HORIZONS },
    archived: false,
    createdAt: new Date().toISOString(),
  };
}

interface SeedItemSpec {
  name: string;
  nameEs: string;
  packageSize: string;
  categoryKey: string;
  price: number; // dollars, converted below
  servings: number;
  shelfLifeClass: ShelfLifeClass;
  tags: Item['tags'];
  upc: string;
}

const SEED_ITEM_SPECS: SeedItemSpec[] = [
  // --- fruit
  { name: 'Apples, 3 lb bag', nameEs: 'Manzanas, bolsa de 3 lb', packageSize: '3 lb', categoryKey: 'fruit', price: 3.99, servings: 6, shelfLifeClass: 'fresh', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free'], upc: '011110000101' },
  { name: 'Bananas, 3 lb', nameEs: 'Plátanos, 3 lb', packageSize: '3 lb', categoryKey: 'fruit', price: 2.19, servings: 6, shelfLifeClass: 'fresh', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free'], upc: '011110000102' },
  { name: 'Navel oranges, 4 lb', nameEs: 'Naranjas navel, 4 lb', packageSize: '4 lb', categoryKey: 'fruit', price: 4.49, servings: 8, shelfLifeClass: 'fresh', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free'], upc: '011110000103' },
  { name: 'Canned peaches in juice', nameEs: 'Duraznos en jugo, enlatados', packageSize: '15 oz can', categoryKey: 'fruit', price: 1.89, servings: 4, shelfLifeClass: 'shelf_stable', tags: ['halal', 'gluten_free', 'vegan', 'vegetarian', 'nut_free'], upc: '011110000104' },
  { name: 'Raisins', nameEs: 'Pasas', packageSize: '15 oz', categoryKey: 'fruit', price: 3.29, servings: 5, shelfLifeClass: 'shelf_stable', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free'], upc: '011110000105' },
  { name: 'Frozen mixed berries', nameEs: 'Bayas mixtas congeladas', packageSize: '12 oz', categoryKey: 'fruit', price: 3.79, servings: 4, shelfLifeClass: 'frozen', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free'], upc: '011110000106' },
  { name: 'Unsweetened applesauce cups', nameEs: 'Puré de manzana sin azúcar', packageSize: '6 ct', categoryKey: 'fruit', price: 2.99, servings: 6, shelfLifeClass: 'shelf_stable', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free', 'low_sodium'], upc: '011110000107' },

  // --- vegetable
  { name: 'Carrots, 2 lb bag', nameEs: 'Zanahorias, bolsa de 2 lb', packageSize: '2 lb', categoryKey: 'vegetable', price: 2.19, servings: 8, shelfLifeClass: 'fresh', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free'], upc: '011110000201' },
  { name: 'Yellow onions, 3 lb', nameEs: 'Cebollas amarillas, 3 lb', packageSize: '3 lb', categoryKey: 'vegetable', price: 2.99, servings: 9, shelfLifeClass: 'fresh', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free'], upc: '011110000202' },
  { name: 'Frozen broccoli florets', nameEs: 'Floretes de brócoli congelados', packageSize: '12 oz', categoryKey: 'vegetable', price: 1.99, servings: 6, shelfLifeClass: 'frozen', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free'], upc: '011110000203' },
  { name: 'Canned green beans, no salt added', nameEs: 'Ejotes enlatados, sin sal añadida', packageSize: '14.5 oz', categoryKey: 'vegetable', price: 1.29, servings: 4, shelfLifeClass: 'shelf_stable', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free', 'low_sodium'], upc: '011110000204' },
  { name: 'Canned diced tomatoes', nameEs: 'Tomates picados enlatados', packageSize: '28 oz', categoryKey: 'vegetable', price: 2.09, servings: 7, shelfLifeClass: 'shelf_stable', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free'], upc: '011110000205' },
  { name: 'Russet potatoes, 5 lb', nameEs: 'Papas russet, 5 lb', packageSize: '5 lb', categoryKey: 'vegetable', price: 4.49, servings: 10, shelfLifeClass: 'fresh', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free'], upc: '011110000206' },
  { name: 'Frozen spinach', nameEs: 'Espinaca congelada', packageSize: '16 oz', categoryKey: 'vegetable', price: 2.49, servings: 8, shelfLifeClass: 'frozen', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free', 'low_sodium'], upc: '011110000207' },
  { name: 'Cabbage, head', nameEs: 'Repollo, cabeza', packageSize: '~2 lb', categoryKey: 'vegetable', price: 1.79, servings: 8, shelfLifeClass: 'fresh', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free'], upc: '011110000208' },

  // --- protein
  { name: 'Chicken thighs, bone-in', nameEs: 'Muslos de pollo con hueso', packageSize: '3 lb', categoryKey: 'protein', price: 7.49, servings: 12, shelfLifeClass: 'refrigerated', tags: ['halal', 'gluten_free', 'nut_free', 'dairy_free'], upc: '011110000301' },
  { name: 'Dried lentils', nameEs: 'Lentejas secas', packageSize: '2 lb', categoryKey: 'protein', price: 2.79, servings: 16, shelfLifeClass: 'shelf_stable', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free', 'dairy_free', 'low_sodium'], upc: '011110000302' },
  { name: 'Canned black beans', nameEs: 'Frijoles negros enlatados', packageSize: '15 oz', categoryKey: 'protein', price: 1.19, servings: 4, shelfLifeClass: 'shelf_stable', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free', 'dairy_free'], upc: '011110000303' },
  { name: 'Canned tuna in water, 5 pack', nameEs: 'Atún en agua, paquete de 5', packageSize: '5 x 5 oz', categoryKey: 'protein', price: 5.99, servings: 10, shelfLifeClass: 'shelf_stable', tags: ['halal', 'gluten_free', 'nut_free', 'dairy_free'], upc: '011110000304' },
  { name: 'Peanut butter', nameEs: 'Crema de cacahuate', packageSize: '40 oz', categoryKey: 'protein', price: 5.49, servings: 14, shelfLifeClass: 'shelf_stable', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'dairy_free'], upc: '011110000305' },
  { name: 'Large eggs', nameEs: 'Huevos grandes', packageSize: '18 ct', categoryKey: 'protein', price: 4.99, servings: 18, shelfLifeClass: 'refrigerated', tags: ['halal', 'kosher', 'gluten_free', 'vegetarian', 'nut_free'], upc: '011110000306' },
  { name: 'Dried pinto beans', nameEs: 'Frijoles pintos secos', packageSize: '2 lb', categoryKey: 'protein', price: 2.49, servings: 16, shelfLifeClass: 'shelf_stable', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free', 'dairy_free', 'low_sodium'], upc: '011110000307' },

  // --- starch / grain
  { name: 'Brown rice', nameEs: 'Arroz integral', packageSize: '5 lb', categoryKey: 'starch', price: 5.49, servings: 25, shelfLifeClass: 'shelf_stable', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free', 'dairy_free', 'low_sodium'], upc: '011110000401' },
  { name: 'Whole wheat pasta', nameEs: 'Pasta de trigo integral', packageSize: '2 lb', categoryKey: 'starch', price: 2.49, servings: 12, shelfLifeClass: 'shelf_stable', tags: ['halal', 'kosher', 'vegan', 'vegetarian', 'nut_free', 'dairy_free'], upc: '011110000402' },
  { name: 'Rolled oats', nameEs: 'Avena en hojuelas', packageSize: '42 oz', categoryKey: 'starch', price: 4.29, servings: 20, shelfLifeClass: 'shelf_stable', tags: ['halal', 'kosher', 'vegan', 'vegetarian', 'nut_free', 'dairy_free', 'low_sodium'], upc: '011110000403' },
  { name: 'Corn tortillas', nameEs: 'Tortillas de maíz', packageSize: '30 ct', categoryKey: 'starch', price: 2.89, servings: 15, shelfLifeClass: 'refrigerated', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free', 'dairy_free'], upc: '011110000404' },
  { name: 'Whole wheat bread', nameEs: 'Pan integral', packageSize: '20 oz loaf', categoryKey: 'starch', price: 3.19, servings: 10, shelfLifeClass: 'fresh', tags: ['halal', 'kosher', 'vegan', 'vegetarian', 'nut_free', 'dairy_free'], upc: '011110000405' },
  { name: 'Cornmeal', nameEs: 'Harina de maíz', packageSize: '32 oz', categoryKey: 'starch', price: 2.29, servings: 14, shelfLifeClass: 'shelf_stable', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free', 'dairy_free', 'low_sodium'], upc: '011110000406' },

  // --- non-creditable staple (section 5): budget only, zero servings
  { name: 'Vegetable oil', nameEs: 'Aceite vegetal', packageSize: '48 oz', categoryKey: 'starch', price: 5.49, servings: 0, shelfLifeClass: 'shelf_stable', tags: ['halal', 'kosher', 'gluten_free', 'vegan', 'vegetarian', 'nut_free', 'dairy_free'], upc: '011110000501' },
];

export function seedItems(): Item[] {
  const now = new Date().toISOString();
  return SEED_ITEM_SPECS.map((spec, index) => ({
    id: newId('item'),
    name: spec.name,
    nameEs: spec.nameEs,
    packageSize: spec.packageSize,
    categoryKey: spec.categoryKey,
    priceCents: Math.round(spec.price * 100),
    servingsPerPackageUnits: servingsToUnits(spec.servings),
    sku: `SCN-${String(index + 1).padStart(4, '0')}`,
    upc: spec.upc,
    tags: spec.tags,
    shelfLifeClass: spec.shelfLifeClass,
    active: true,
    updatedAt: now,
  }));
}
