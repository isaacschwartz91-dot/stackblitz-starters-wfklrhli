import { describe, expect, it } from 'vitest';

import type { Aisle, Alias, Item, OrderLine } from '../core/models';
import { buildMatchIndex, matchPhrase, searchItems } from './matcher';
import { normalize } from './normalize';
import { parseLine, splitOrderText } from './parse-line';
import { aisleLabel, buildPickList } from './pick-list';

function item(partial: Partial<Item> & { id: string; name: string }): Item {
  return {
    brand: '',
    size: '',
    department: '',
    aisle: '',
    shelfSequence: null,
    unit: 'each',
    price: null,
    barcode: '',
    active: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

const CATALOG: Item[] = [
  item({
    id: '1042',
    name: 'Milk 2% Half Gallon',
    brand: 'Farmland',
    size: '1/2 gal',
    department: 'Dairy',
    aisle: '3',
    shelfSequence: 3.4,
    price: 3.49,
  }),
  item({
    id: '1043',
    name: 'Milk Whole Gallon',
    brand: 'Farmland',
    size: '1 gal',
    department: 'Dairy',
    aisle: '3',
    shelfSequence: 3.1,
    price: 4.99,
  }),
  item({
    id: '1044',
    name: 'Almond Milk Unsweetened',
    brand: 'Silk',
    size: '64 oz',
    department: 'Dairy',
    aisle: '3',
    shelfSequence: 3.9,
  }),
  item({
    id: '2001',
    name: 'Bananas',
    department: 'Produce',
    aisle: '1',
    shelfSequence: 1.2,
    unit: 'lb',
    price: 0.59,
  }),
  item({
    id: '2002',
    name: 'Apples Gala',
    department: 'Produce',
    aisle: '1',
    shelfSequence: 1.5,
    unit: 'lb',
    price: 1.99,
  }),
  item({
    id: '3001',
    name: 'Rye Bread Sliced',
    brand: 'Hearth',
    size: '24 oz',
    department: 'Bakery',
    aisle: '2',
    shelfSequence: 2.2,
    price: 4.25,
  }),
  item({
    id: '3002',
    name: 'White Sandwich Bread',
    brand: 'Hearth',
    size: '20 oz',
    department: 'Bakery',
    aisle: '2',
    shelfSequence: 2.1,
  }),
  item({
    id: '4001',
    name: 'Eggs Large Grade A',
    brand: 'Sunny',
    size: 'dozen',
    department: 'Dairy',
    aisle: '3',
    shelfSequence: 3.8,
    unit: 'dozen',
    price: 3.19,
  }),
  item({
    id: '5001',
    name: 'Peanut Butter Creamy',
    brand: 'Nutty',
    size: '16 oz',
    department: 'Grocery',
    aisle: '5',
    shelfSequence: 5.3,
  }),
  item({ id: '9001', name: 'Sea Salt Grinder', department: 'Grocery', aisle: '', shelfSequence: null }),
];

const AISLES: Aisle[] = [
  { id: '1', sequence: 1, name: 'Produce' },
  { id: '2', sequence: 2, name: 'Bakery' },
  { id: '3', sequence: 3, name: 'Dairy' },
  { id: '5', sequence: 4, name: 'Grocery' },
];

function alias(partial: Partial<Alias> & { phrase: string; itemId: string }): Alias {
  return {
    id: `alias-${partial.phrase}-${partial.customerId ?? 'global'}`,
    normalizedPhrase: normalize(partial.phrase),
    customerId: null,
    hits: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'test',
    ...partial,
  };
}

describe('normalize', () => {
  it('collapses case, punctuation, plurals and percent signs', () => {
    expect(normalize('  Milk, 2%  Half-Gallon ')).toBe('milk 2 percent half gallon');
    expect(normalize('Bananas')).toBe('banana');
    expect(normalize('Potatoes')).toBe('potato');
    expect(normalize('Loaves')).toBe('loaf');
  });

  it('leaves already-singular words ending in s alone', () => {
    expect(normalize('Hummus')).toBe('hummus');
    expect(normalize('Asparagus')).toBe('asparagus');
  });

  it('expands store shorthand', () => {
    expect(normalize('pnut butter')).toBe('peanut butter');
    expect(normalize('choc chips')).toBe('chocolate chips');
  });
});

describe('parseLine', () => {
  const cases: Array<[string, { qty: number; unit: string; phrase: string }]> = [
    ['2 milk', { qty: 2, unit: '', phrase: 'milk' }],
    ['milk x3', { qty: 3, unit: '', phrase: 'milk' }],
    ['milk X 3', { qty: 3, unit: '', phrase: 'milk' }],
    ['3 lb apples', { qty: 3, unit: 'lb', phrase: 'apples' }],
    ['3lbs apples', { qty: 3, unit: 'lb', phrase: 'apples' }],
    ['dozen eggs', { qty: 1, unit: 'dozen', phrase: 'eggs' }],
    ['2 dozen eggs', { qty: 2, unit: 'dozen', phrase: 'eggs' }],
    ['milk', { qty: 1, unit: '', phrase: 'milk' }],
    ['- 2 loaves rye bread', { qty: 2, unit: 'loaf', phrase: 'rye bread' }],
    ['1. apples', { qty: 1, unit: '', phrase: 'apples' }],
    ['two milk', { qty: 2, unit: '', phrase: 'milk' }],
    ['1/2 lb turkey', { qty: 0.5, unit: 'lb', phrase: 'turkey' }],
    ['2 1/2 lb ground beef', { qty: 2.5, unit: 'lb', phrase: 'ground beef' }],
    ['milk qty 4', { qty: 4, unit: '', phrase: 'milk' }],
    ['bananas (2)', { qty: 2, unit: '', phrase: 'bananas' }],
    ['eggs 2 dozen', { qty: 2, unit: 'dozen', phrase: 'eggs' }],
    ['3 bags of chips', { qty: 3, unit: 'bag', phrase: 'chips' }],
  ];

  for (const [input, expected] of cases) {
    it(`parses "${input}"`, () => {
      const parsed = parseLine(input);
      expect({ qty: parsed.qty, unit: parsed.unit, phrase: parsed.phrase }).toEqual(expected);
    });
  }

  it('keeps a package size in the phrase instead of reading it as a count', () => {
    expect(parseLine('12 oz sour cream')).toMatchObject({ qty: 1, phrase: '12 oz sour cream' });
    expect(parseLine('bread 12 oz')).toMatchObject({ qty: 1, phrase: 'bread 12 oz' });
  });

  it('does not read a fat percentage as a quantity', () => {
    expect(parseLine('2% milk')).toMatchObject({ qty: 1, phrase: '2% milk' });
  });

  it('keeps customer asides as a note', () => {
    expect(parseLine('apples (ripe, not green)')).toMatchObject({
      phrase: 'apples',
      note: 'ripe, not green',
    });
    expect(parseLine('orange juice - no pulp')).toMatchObject({
      phrase: 'orange juice',
      note: 'no pulp',
    });
  });

  it('never loses the original text', () => {
    expect(parseLine('  - 3 lb Gala apples  ').raw).toBe('- 3 lb Gala apples');
  });
});

describe('splitOrderText', () => {
  it('splits a pasted email order and drops header noise', () => {
    const pasted = [
      'From: john@example.com',
      'Subject: order',
      '',
      '2 milk',
      '  bread  ',
      '---',
      'dozen eggs',
    ].join('\n');
    expect(splitOrderText(pasted)).toEqual(['2 milk', 'bread', 'dozen eggs']);
  });

  it('only splits on commas when asked', () => {
    expect(splitOrderText('milk, bread')).toEqual(['milk, bread']);
    expect(splitOrderText('milk, bread', true)).toEqual(['milk', 'bread']);
  });
});

describe('matchPhrase', () => {
  const index = buildMatchIndex(CATALOG, []);

  it('matches an exact catalog name', () => {
    const result = matchPhrase(index, 'Milk 2% Half Gallon');
    expect(result.itemId).toBe('1042');
    expect(result.source).toBe('exact');
    expect(result.needsReview).toBe(false);
  });

  it('matches ignoring case, plurals and punctuation', () => {
    expect(matchPhrase(index, 'banana').itemId).toBe('2001');
    expect(matchPhrase(index, 'BANANAS').itemId).toBe('2001');
    expect(matchPhrase(index, 'rye bread, sliced').itemId).toBe('3001');
  });

  it('matches ignoring word order', () => {
    expect(matchPhrase(index, 'sliced rye bread').itemId).toBe('3001');
  });

  it('tolerates typos', () => {
    const result = matchPhrase(index, 'banannas');
    expect(result.itemId).toBe('2001');
    expect(result.candidates[0]?.item.id).toBe('2001');
  });

  it('flags a genuinely ambiguous phrase for review with suggestions', () => {
    const result = matchPhrase(index, 'milk');
    expect(result.needsReview).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.candidates.map((candidate) => candidate.item.id)).toContain('1042');
  });

  it('returns no match for something the store does not carry', () => {
    const result = matchPhrase(index, 'motor oil');
    expect(result.itemId).toBeNull();
    expect(result.needsReview).toBe(true);
  });

  it('resolves a bare item id', () => {
    expect(matchPhrase(index, '1042').itemId).toBe('1042');
  });
});

describe('alias priority', () => {
  const customerId = 'cust-john';
  const aliases: Alias[] = [
    alias({ phrase: 'milk', itemId: '1043' }),
    alias({ phrase: 'milk', itemId: '1042', customerId }),
    alias({ phrase: 'pnut butter', itemId: '5001' }),
  ];
  const index = buildMatchIndex(CATALOG, aliases);

  it('prefers the customer alias over the global one', () => {
    const result = matchPhrase(index, 'milk', { customerId });
    expect(result.itemId).toBe('1042');
    expect(result.source).toBe('customer-alias');
    expect(result.needsReview).toBe(false);
  });

  it('falls back to the global alias for everyone else', () => {
    const result = matchPhrase(index, 'milk', { customerId: 'cust-someone-else' });
    expect(result.itemId).toBe('1043');
    expect(result.source).toBe('global-alias');
  });

  it('applies the global alias with no customer at all', () => {
    expect(matchPhrase(index, 'milk').itemId).toBe('1043');
  });

  it('beats fuzzy matching — the alias wins even when spelled oddly', () => {
    expect(matchPhrase(index, 'PNUT BUTTER').itemId).toBe('5001');
  });

  it('ignores an alias whose product was deleted from the catalog', () => {
    const stale = buildMatchIndex(CATALOG, [alias({ phrase: 'milk', itemId: 'gone' })]);
    expect(matchPhrase(stale, 'milk').itemId).not.toBe('gone');
  });
});

describe('end-to-end: a real phoned-in order', () => {
  const customerId = 'cust-john';
  const index = buildMatchIndex(CATALOG, [alias({ phrase: 'milk', itemId: '1042', customerId })]);

  it('parses, matches and sorts into walking order', () => {
    const pasted = ['2 milk', 'dozen eggs', '3 lb apples', 'rye bread', 'sea salt'].join('\n');

    const lines: OrderLine[] = splitOrderText(pasted).map((raw, position) => {
      const parsed = parseLine(raw);
      const match = matchPhrase(index, parsed.phrase, { customerId }, [raw]);
      return {
        id: `line-${position}`,
        orderId: 'order-1',
        position,
        rawText: parsed.raw,
        phrase: parsed.phrase,
        itemId: match.itemId,
        qty: parsed.qty,
        unit: parsed.unit,
        note: parsed.note,
        needsReview: match.needsReview,
        matchSource: match.source,
        matchScore: match.score,
        picked: false,
        outOfStock: false,
        substituteItemId: null,
      };
    });

    // The customer's shorthand resolved without asking anyone.
    expect(lines[0]).toMatchObject({ itemId: '1042', qty: 2, matchSource: 'customer-alias' });
    expect(lines[1]).toMatchObject({ itemId: '4001', qty: 1, unit: 'dozen' });
    expect(lines[2]).toMatchObject({ itemId: '2002', qty: 3, unit: 'lb' });
    expect(lines[3]).toMatchObject({ itemId: '3001' });

    const pickList = buildPickList({
      lines,
      items: new Map(CATALOG.map((entry) => [entry.id, entry])),
      aisles: AISLES,
    });

    expect(pickList.groups.map((group) => group.aisleName)).toEqual([
      'Produce',
      'Bakery',
      'Dairy',
      'Location unknown — fix me',
    ]);
    // Within Dairy, shelf_sequence orders the walk: milk 3.4 before eggs 3.8.
    expect(pickList.groups[2].entries.map((entry) => entry.item?.id)).toEqual(['1042', '4001']);
    expect(pickList.totalItems).toBe(5);
  });
});

describe('buildPickList', () => {
  const items = new Map(CATALOG.map((entry) => [entry.id, entry]));

  function line(partial: Partial<OrderLine> & { id: string; position: number }): OrderLine {
    return {
      orderId: 'o1',
      rawText: '',
      phrase: '',
      itemId: null,
      qty: 1,
      unit: '',
      note: '',
      needsReview: false,
      matchSource: 'exact',
      matchScore: 1,
      picked: false,
      outOfStock: false,
      substituteItemId: null,
      ...partial,
    };
  }

  it('sorts by aisle walking order, then shelf sequence', () => {
    const pickList = buildPickList({
      lines: [
        line({ id: 'a', position: 0, itemId: '4001' }),
        line({ id: 'b', position: 1, itemId: '2001' }),
        line({ id: 'c', position: 2, itemId: '1043' }),
        line({ id: 'd', position: 3, itemId: '3002' }),
      ],
      items,
      aisles: AISLES,
    });

    expect(pickList.groups.map((group) => group.aisleName)).toEqual(['Produce', 'Bakery', 'Dairy']);
    expect(pickList.groups[2].entries.map((entry) => entry.item?.id)).toEqual(['1043', '4001']);
  });

  it('puts located items ahead of unlocated ones and labels the leftovers', () => {
    const pickList = buildPickList({
      lines: [
        line({ id: 'a', position: 0, itemId: '9001' }),
        line({ id: 'b', position: 1, itemId: '2001' }),
      ],
      items,
      aisles: AISLES,
    });
    expect(pickList.groups.at(-1)?.aisleName).toBe('Location unknown — fix me');
    expect(pickList.groups[0].aisleName).toBe('Produce');
  });

  it('separates unmatched and low-confidence lines into needs-attention', () => {
    const pickList = buildPickList({
      lines: [
        line({ id: 'a', position: 0, itemId: null, needsReview: true, rawText: 'motor oil' }),
        line({ id: 'b', position: 1, itemId: '1042', needsReview: true, rawText: 'milk' }),
        line({ id: 'c', position: 2, itemId: '2001' }),
      ],
      items,
      aisles: AISLES,
    });
    expect(pickList.needsAttention.map((entry) => entry.line.id)).toEqual(['a', 'b']);
    expect(pickList.totalItems).toBe(1);
  });

  it('walks to the substitute shelf when an item is out of stock', () => {
    const pickList = buildPickList({
      lines: [
        line({ id: 'a', position: 0, itemId: '1042', outOfStock: true, substituteItemId: '3001' }),
      ],
      items,
      aisles: AISLES,
    });
    expect(pickList.groups[0].aisleName).toBe('Bakery');
  });

  it('totals the estimated price using quantities', () => {
    const pickList = buildPickList({
      lines: [
        line({ id: 'a', position: 0, itemId: '2002', qty: 3 }),
        line({ id: 'b', position: 1, itemId: '1042', qty: 2 }),
      ],
      items,
      aisles: AISLES,
    });
    expect(pickList.estimatedTotal).toBe(3 * 1.99 + 2 * 3.49);
  });

  it('treats a shelf-order sheet with no aisles as a real walk, not a problem', () => {
    // One sheet, every product in the order it sits on the shelf, no aisle
    // column at all: the row order is the whole walking order.
    const shelfOnly: Item[] = [
      item({ id: 's1', name: 'Bananas', shelfSequence: 1 }),
      item({ id: 's2', name: 'Rye Bread', shelfSequence: 2 }),
      item({ id: 's3', name: 'Milk', shelfSequence: 3 }),
      item({ id: 's4', name: 'Toilet Paper', shelfSequence: 4 }),
    ];
    const pickList = buildPickList({
      lines: [
        line({ id: 'a', position: 0, itemId: 's4' }),
        line({ id: 'b', position: 1, itemId: 's1' }),
        line({ id: 'c', position: 2, itemId: 's3' }),
      ],
      items: new Map(shelfOnly.map((entry) => [entry.id, entry])),
      aisles: [],
    });

    expect(pickList.groups).toHaveLength(1);
    expect(pickList.groups[0].aisleName).toBe('In shelf order');
    expect(pickList.groups[0].entries.map((entry) => entry.item?.name)).toEqual([
      'Bananas',
      'Milk',
      'Toilet Paper',
    ]);
    expect(pickList.needsAttention).toEqual([]);
  });

  it('keeps genuinely unlocated items apart from shelf-ordered ones', () => {
    const mixed: Item[] = [
      item({ id: 's1', name: 'Bananas', shelfSequence: 1 }),
      item({ id: 's2', name: 'Mystery Item' }),
    ];
    const pickList = buildPickList({
      lines: [
        line({ id: 'a', position: 0, itemId: 's2' }),
        line({ id: 'b', position: 1, itemId: 's1' }),
      ],
      items: new Map(mixed.map((entry) => [entry.id, entry])),
      aisles: [],
    });
    expect(pickList.groups.map((group) => group.aisleName)).toEqual([
      'In shelf order',
      'Location unknown — fix me',
    ]);
  });

  it('puts named aisles ahead of an un-aisled shelf run', () => {
    const mixed: Item[] = [
      item({ id: 'p1', name: 'Bananas', aisle: '1', shelfSequence: 1 }),
      item({ id: 's1', name: 'Loose Item', shelfSequence: 5 }),
    ];
    const pickList = buildPickList({
      lines: [
        line({ id: 'a', position: 0, itemId: 's1' }),
        line({ id: 'b', position: 1, itemId: 'p1' }),
      ],
      items: new Map(mixed.map((entry) => [entry.id, entry])),
      aisles: [{ id: '1', sequence: 1, name: 'Produce' }],
    });
    expect(pickList.groups.map((group) => group.aisleName)).toEqual(['Produce', 'In shelf order']);
  });

  it('handles an aisle that is missing from the walking order sheet', () => {
    const pickList = buildPickList({
      lines: [line({ id: 'a', position: 0, itemId: '5001' }), line({ id: 'b', position: 1, itemId: '2001' })],
      items,
      aisles: [{ id: '1', sequence: 1, name: 'Produce' }],
    });
    expect(pickList.groups[0].aisleName).toBe('Produce');
    expect(pickList.groups[1].entries[0].item?.id).toBe('5001');
  });
});

describe('aisleLabel', () => {
  it('numbers a numeric aisle and leaves a named one alone', () => {
    expect(aisleLabel('3')).toBe('Aisle 3');
    expect(aisleLabel('12')).toBe('Aisle 12');
    expect(aisleLabel('Household')).toBe('Household');
    expect(aisleLabel('Dairy & Eggs')).toBe('Dairy & Eggs');
  });

  it('always prefers the name the store gave it', () => {
    expect(aisleLabel('3', 'Dairy')).toBe('Dairy');
    expect(aisleLabel('Household', 'Cleaning')).toBe('Cleaning');
  });

  it('is empty for no aisle at all', () => {
    expect(aisleLabel('', '')).toBe('');
  });
});

describe('searchItems', () => {
  const index = buildMatchIndex(CATALOG, []);

  it('powers type-ahead from a partial word', () => {
    const results = searchItems(index, 'ban');
    expect(results[0]?.item.id).toBe('2001');
  });

  it('ranks all milks for a generic query', () => {
    const ids = searchItems(index, 'milk').map((candidate) => candidate.item.id);
    expect(ids).toContain('1042');
    expect(ids).toContain('1043');
    expect(ids).toContain('1044');
  });

  it('returns nothing for an empty query', () => {
    expect(searchItems(index, '   ')).toEqual([]);
  });

  it('finds a product from two typed letters', () => {
    const ids = searchItems(index, 'mi').map((candidate) => candidate.item.id);
    expect(ids).toContain('1042');
    expect(ids).toContain('1043');
  });
});

/**
 * A real store uploaded 9,420 products and searched "milk". Search has to
 * return every one of them: quietly capping the result set is how staff end up
 * believing a product is not in the catalog when it is on the next shelf.
 */
describe('searchItems at catalog scale', () => {
  const BIG: Item[] = [];
  for (let i = 0; i < 9420; i += 1) {
    // Every 9th product is a milk, giving well over a thousand matches — far
    // past any candidate cap the matcher applies when resolving one order line.
    const isMilk = i % 9 === 0;
    BIG.push(
      item({
        id: `sku-${i}`,
        name: isMilk ? `Milk Variety ${i}` : `Bread Variety ${i}`,
        brand: i % 50 === 0 ? 'Milkhouse Creamery' : 'Store Brand',
        size: i % 70 === 0 ? 'Milk Crate 4 pack' : '1 lb',
        aisle: String((i % 20) + 1),
      }),
    );
  }
  const big = buildMatchIndex(BIG, []);
  const expected = BIG.filter((entry) =>
    `${entry.name} ${entry.brand} ${entry.size}`.toLowerCase().includes('milk'),
  ).length;

  it('returns every match, not a truncated sample', () => {
    expect(expected).toBeGreaterThan(1000);
    expect(searchItems(big, 'milk')).toHaveLength(expected);
  });

  it('matches on brand and size, not just the product name', () => {
    const ids = new Set(searchItems(big, 'milk').map((candidate) => candidate.item.id));
    // Named "Bread…", so only its brand or size can have earned the match.
    expect(ids.has('sku-50')).toBe(true);
    expect(ids.has('sku-70')).toBe(true);
  });

  it('trims only the returned rows when a caller asks for a fixed number', () => {
    expect(searchItems(big, 'milk', 10)).toHaveLength(10);
    expect(searchItems(big, 'milk', 500)).toHaveLength(500);
  });

  it('still resolves an order line against the same catalog', () => {
    const result = matchPhrase(big, 'milk variety 27');
    expect(result.itemId).toBe('sku-27');
  });
});
