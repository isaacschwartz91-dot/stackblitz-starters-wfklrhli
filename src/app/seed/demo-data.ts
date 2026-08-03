/**
 * A small but realistic store, so the app can be tried before the owner's real
 * spreadsheets arrive. Loaded from Settings → "Load demo store".
 */

import { newId } from '../core/ids';
import type { Aisle, Alias, Customer, Item, Snapshot } from '../core/models';
import { DEFAULT_SETTINGS } from '../core/models';
import { normalize } from '../matching/normalize';

const AISLES: Aisle[] = [
  { id: '1', sequence: 1, name: 'Produce' },
  { id: '2', sequence: 2, name: 'Bakery' },
  { id: '3', sequence: 3, name: 'Dairy & Eggs' },
  { id: '4', sequence: 4, name: 'Meat & Deli' },
  { id: '5', sequence: 5, name: 'Pantry' },
  { id: '6', sequence: 6, name: 'Snacks & Drinks' },
  { id: '7', sequence: 7, name: 'Frozen' },
  { id: '8', sequence: 8, name: 'Household' },
];

/** [id, name, brand, size, department, aisle, shelfSequence, unit, price] */
type Row = [string, string, string, string, string, string, number, string, number];

const ROWS: Row[] = [
  ['1001', 'Bananas', '', 'per lb', 'Produce', '1', 1.1, 'lb', 0.59],
  ['1002', 'Apples Gala', '', 'per lb', 'Produce', '1', 1.2, 'lb', 1.99],
  ['1003', 'Apples Granny Smith', '', 'per lb', 'Produce', '1', 1.3, 'lb', 2.09],
  ['1004', 'Navel Oranges', '', '4 lb bag', 'Produce', '1', 1.4, 'bag', 5.49],
  ['1005', 'Baby Carrots', 'Green Field', '1 lb', 'Produce', '1', 1.5, 'bag', 1.79],
  ['1006', 'Romaine Lettuce', '', 'each', 'Produce', '1', 1.6, 'each', 2.29],
  ['1007', 'Roma Tomatoes', '', 'per lb', 'Produce', '1', 1.7, 'lb', 1.89],
  ['1008', 'Yellow Onions', '', '3 lb bag', 'Produce', '1', 1.8, 'bag', 2.99],
  ['1009', 'Russet Potatoes', '', '5 lb bag', 'Produce', '1', 1.9, 'bag', 4.29],
  ['1010', 'Avocados', '', 'each', 'Produce', '1', 2.0, 'each', 1.29],
  ['1011', 'Baby Spinach', 'Green Field', '5 oz', 'Produce', '1', 2.1, 'bag', 3.49],
  ['1012', 'Seedless Grapes Red', '', 'per lb', 'Produce', '1', 2.2, 'lb', 2.99],

  ['2001', 'White Sandwich Bread', 'Hearth', '20 oz', 'Bakery', '2', 1.1, 'loaf', 3.29],
  ['2002', 'Rye Bread Sliced', 'Hearth', '24 oz', 'Bakery', '2', 1.2, 'loaf', 4.25],
  ['2003', 'Whole Wheat Bread', 'Hearth', '20 oz', 'Bakery', '2', 1.3, 'loaf', 3.79],
  ['2004', 'Sourdough Boule', 'Hearth', '18 oz', 'Bakery', '2', 1.4, 'each', 4.99],
  ['2005', 'Bagels Plain', 'Hearth', '6 ct', 'Bakery', '2', 1.5, 'pack', 3.99],
  ['2006', 'Hamburger Buns', 'Hearth', '8 ct', 'Bakery', '2', 1.6, 'pack', 2.99],
  ['2007', 'Blueberry Muffins', 'Hearth', '4 ct', 'Bakery', '2', 1.7, 'pack', 4.49],

  ['3001', 'Milk Whole Gallon', 'Farmland', '1 gal', 'Dairy', '3', 1.1, 'each', 4.99],
  ['3002', 'Milk 2% Gallon', 'Farmland', '1 gal', 'Dairy', '3', 1.2, 'each', 4.89],
  ['3003', 'Milk 2% Half Gallon', 'Farmland', '1/2 gal', 'Dairy', '3', 1.3, 'each', 3.49],
  ['3004', 'Milk Skim Half Gallon', 'Farmland', '1/2 gal', 'Dairy', '3', 1.4, 'each', 3.39],
  ['3005', 'Almond Milk Unsweetened', 'Silk', '64 oz', 'Dairy', '3', 1.5, 'each', 4.29],
  ['3006', 'Heavy Cream', 'Farmland', '16 oz', 'Dairy', '3', 1.6, 'each', 4.79],
  ['3007', 'Salted Butter', 'Farmland', '1 lb', 'Dairy', '3', 1.7, 'pack', 5.49],
  ['3008', 'Unsalted Butter', 'Farmland', '1 lb', 'Dairy', '3', 1.8, 'pack', 5.49],
  ['3009', 'Cheddar Cheese Sharp', 'Hill Top', '8 oz', 'Dairy', '3', 1.9, 'each', 4.99],
  ['3010', 'Mozzarella Shredded', 'Hill Top', '8 oz', 'Dairy', '3', 2.0, 'bag', 3.99],
  ['3011', 'Cream Cheese', 'Hill Top', '8 oz', 'Dairy', '3', 2.1, 'each', 3.29],
  ['3012', 'Greek Yogurt Plain', 'Meadow', '32 oz', 'Dairy', '3', 2.2, 'tub', 5.99],
  ['3013', 'Sour Cream', 'Meadow', '16 oz', 'Dairy', '3', 2.3, 'tub', 2.49],
  ['3014', 'Eggs Large Grade A', 'Sunny Acres', 'dozen', 'Dairy', '3', 2.4, 'dozen', 3.19],
  ['3015', 'Eggs Extra Large', 'Sunny Acres', 'dozen', 'Dairy', '3', 2.5, 'dozen', 3.79],
  ['3016', 'Orange Juice No Pulp', 'Sunrise', '52 oz', 'Dairy', '3', 2.6, 'each', 4.49],

  ['4001', 'Chicken Breast Boneless', '', 'per lb', 'Meat', '4', 1.1, 'lb', 5.99],
  ['4002', 'Ground Beef 85/15', '', 'per lb', 'Meat', '4', 1.2, 'lb', 6.49],
  ['4003', 'Pork Chops Center Cut', '', 'per lb', 'Meat', '4', 1.3, 'lb', 4.99],
  ['4004', 'Bacon Thick Cut', 'Smokehouse', '16 oz', 'Meat', '4', 1.4, 'pack', 7.99],
  ['4005', 'Turkey Breast Sliced', 'Deli', 'per lb', 'Deli', '4', 1.5, 'lb', 8.99],
  ['4006', 'Swiss Cheese Sliced', 'Deli', 'per lb', 'Deli', '4', 1.6, 'lb', 9.49],
  ['4007', 'Salmon Fillet', '', 'per lb', 'Meat', '4', 1.7, 'lb', 12.99],

  ['5001', 'Peanut Butter Creamy', 'Nutty', '16 oz', 'Pantry', '5', 1.1, 'jar', 3.99],
  ['5002', 'Peanut Butter Crunchy', 'Nutty', '16 oz', 'Pantry', '5', 1.2, 'jar', 3.99],
  ['5003', 'Strawberry Jam', 'Orchard', '18 oz', 'Pantry', '5', 1.3, 'jar', 4.29],
  ['5004', 'Spaghetti', 'Bella', '16 oz', 'Pantry', '5', 1.4, 'box', 1.99],
  ['5005', 'Marinara Sauce', 'Bella', '24 oz', 'Pantry', '5', 1.5, 'jar', 3.49],
  ['5006', 'White Rice Long Grain', 'Harvest', '5 lb', 'Pantry', '5', 1.6, 'bag', 6.99],
  ['5007', 'All Purpose Flour', 'Harvest', '5 lb', 'Pantry', '5', 1.7, 'bag', 4.49],
  ['5008', 'Granulated Sugar', 'Harvest', '4 lb', 'Pantry', '5', 1.8, 'bag', 3.99],
  ['5009', 'Olive Oil Extra Virgin', 'Grove', '17 oz', 'Pantry', '5', 1.9, 'bottle', 9.99],
  ['5010', 'Sea Salt Grinder', 'Grove', '4 oz', 'Pantry', '5', 2.0, 'each', 2.99],
  ['5011', 'Black Pepper Ground', 'Grove', '3 oz', 'Pantry', '5', 2.1, 'each', 3.49],
  ['5012', 'Chicken Broth', 'Kettle', '32 oz', 'Pantry', '5', 2.2, 'each', 2.79],
  ['5013', 'Black Beans Canned', 'Kettle', '15 oz', 'Pantry', '5', 2.3, 'can', 1.29],
  ['5014', 'Cereal Toasted Oats', 'Morning', '18 oz', 'Pantry', '5', 2.4, 'box', 4.99],
  ['5015', 'Coffee Ground Medium', 'Roast Co', '12 oz', 'Pantry', '5', 2.5, 'bag', 8.99],
  ['5016', 'Tea Bags Black', 'Roast Co', '40 ct', 'Pantry', '5', 2.6, 'box', 4.49],

  ['6001', 'Potato Chips Classic', 'Crisp', '8 oz', 'Snacks', '6', 1.1, 'bag', 4.29],
  ['6002', 'Tortilla Chips', 'Crisp', '11 oz', 'Snacks', '6', 1.2, 'bag', 4.49],
  ['6003', 'Salsa Medium', 'Crisp', '16 oz', 'Snacks', '6', 1.3, 'jar', 3.99],
  ['6004', 'Chocolate Chip Cookies', 'Sweet Lane', '14 oz', 'Snacks', '6', 1.4, 'pack', 4.79],
  ['6005', 'Sparkling Water Lime', 'Clear Springs', '12 pk', 'Drinks', '6', 1.5, 'pack', 5.99],
  ['6006', 'Cola', 'Fizz', '12 pk', 'Drinks', '6', 1.6, 'pack', 7.49],
  ['6007', 'Apple Juice', 'Orchard', '64 oz', 'Drinks', '6', 1.7, 'bottle', 3.99],

  ['7001', 'Frozen Peas', 'Green Field', '16 oz', 'Frozen', '7', 1.1, 'bag', 2.29],
  ['7002', 'Frozen Blueberries', 'Green Field', '16 oz', 'Frozen', '7', 1.2, 'bag', 4.99],
  ['7003', 'Vanilla Ice Cream', 'Creamery', '48 oz', 'Frozen', '7', 1.3, 'tub', 5.99],
  ['7004', 'Frozen Pizza Pepperoni', 'Brick Oven', '16 oz', 'Frozen', '7', 1.4, 'each', 6.99],

  ['8001', 'Paper Towels', 'Everyday', '6 rolls', 'Household', '8', 1.1, 'pack', 9.99],
  ['8002', 'Toilet Paper', 'Everyday', '12 rolls', 'Household', '8', 1.2, 'pack', 12.99],
  ['8003', 'Dish Soap', 'Everyday', '18 oz', 'Household', '8', 1.3, 'bottle', 3.49],
  ['8004', 'Laundry Detergent', 'Everyday', '92 oz', 'Household', '8', 1.4, 'bottle', 13.99],
  ['8005', 'Trash Bags 13 Gallon', 'Everyday', '40 ct', 'Household', '8', 1.5, 'box', 11.49],
  ['8006', 'Aluminum Foil', 'Everyday', '75 sq ft', 'Household', '8', 1.6, 'box', 5.49],
];

function toItem(row: Row): Item {
  const [id, name, brand, size, department, aisle, shelfSequence, unit, price] = row;
  return {
    id,
    name,
    brand,
    size,
    department,
    aisle,
    shelfSequence,
    unit,
    price,
    barcode: '',
    active: true,
    updatedAt: new Date().toISOString(),
  };
}

/** Example orders exactly as they arrive — one phoned in, one forwarded email. */
export const DEMO_ORDER_TEXT = {
  phone: ['2 milk', 'dozen eggs', '3 lb apples', 'rye bread', 'pnut butter', 'bananas'].join('\n'),
  email: [
    'From: sarah.klein@example.com',
    'Subject: Thursday delivery',
    '',
    'Hi — usual order please:',
    '- 1 gal whole milk',
    '- 2 loaves whole wheat',
    '- 1 lb butter (unsalted)',
    '- orange juice, no pulp',
    '- 2 bags baby carrots',
    '- ice cream',
    'Thanks!',
  ].join('\n'),
  messy: [
    'coffee x2',
    'tomatos 2 lb',
    'chedar cheese',
    'spagetti',
    'marinara',
    'paper towles',
    'zucchini',
  ].join('\n'),
};

export function demoSnapshot(): Snapshot {
  const items = ROWS.map(toItem);

  const customers: Customer[] = [
    {
      id: 'cust_john',
      name: 'John Cohen',
      phone: '(555) 214-8890',
      email: 'jcohen@example.com',
      address: '14 Elm Street, Apt 3',
      notes: 'Calls Tuesday mornings. Leave with doorman if out.',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'cust_sarah',
      name: 'Sarah Klein',
      phone: '(555) 663-2201',
      email: 'sarah.klein@example.com',
      address: '882 Oak Avenue',
      notes: 'Emails her order. Thursday delivery.',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'cust_diner',
      name: "Marino's Diner",
      phone: '(555) 900-1112',
      email: 'orders@marinos.example.com',
      address: '5 Market Square — back entrance',
      notes: 'Standing weekly order. Deliver before 7am.',
      createdAt: new Date().toISOString(),
    },
  ];

  const aliasSeeds: Array<{ phrase: string; itemId: string; customerId: string | null }> = [
    // John's shorthand — the example from the brief.
    { phrase: 'milk', itemId: '3003', customerId: 'cust_john' },
    { phrase: 'bread', itemId: '2002', customerId: 'cust_john' },
    { phrase: 'cheese', itemId: '3009', customerId: 'cust_john' },
    // Sarah always means the gallon.
    { phrase: 'milk', itemId: '3001', customerId: 'cust_sarah' },
    // Store-wide shorthand everyone types.
    { phrase: 'pnut butter', itemId: '5001', customerId: null },
    { phrase: 'oj', itemId: '3016', customerId: null },
    { phrase: 'tp', itemId: '8002', customerId: null },
  ];

  const aliases: Alias[] = aliasSeeds.map((seed) => ({
    id: newId('alias'),
    phrase: seed.phrase,
    normalizedPhrase: normalize(seed.phrase),
    itemId: seed.itemId,
    customerId: seed.customerId,
    hits: 0,
    createdAt: new Date().toISOString(),
    createdBy: 'demo',
  }));

  return {
    items,
    aisles: AISLES,
    customers,
    aliases,
    orders: [],
    orderLines: [],
    settings: { ...DEFAULT_SETTINGS, storeName: 'Green Street Grocery' },
  };
}
