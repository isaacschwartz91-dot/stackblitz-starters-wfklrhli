import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

import {
  buildAisles,
  buildItems,
  guessAisleMapping,
  guessItemMapping,
  guessSheetRole,
  readWorkbook,
  type SheetTable,
} from './sheet-parse';

function table(headers: string[], rows: string[][], name = 'Sheet1'): SheetTable {
  return { name, headers, rows };
}

describe('column detection', () => {
  it('matches our own column names', () => {
    expect(
      guessItemMapping([
        'item_id',
        'item_name',
        'brand',
        'size',
        'department',
        'aisle',
        'shelf_sequence',
        'unit',
        'price',
        'barcode',
      ]),
    ).toEqual([
      'item_id',
      'item_name',
      'brand',
      'size',
      'department',
      'aisle',
      'shelf_sequence',
      'unit',
      'price',
      'barcode',
    ]);
  });

  it('matches the column names a real store export uses', () => {
    const mapping = guessItemMapping(['SKU', 'Description', 'Manufacturer', 'Pack Size', 'Aisle #', 'Shelf Seq', 'UOM', 'Retail']);
    expect(mapping[0]).toBe('item_id');
    expect(mapping[1]).toBe('item_name');
    expect(mapping[2]).toBe('brand');
    expect(mapping[3]).toBe('size');
    expect(mapping[4]).toBe('aisle');
    expect(mapping[5]).toBe('shelf_sequence');
    expect(mapping[6]).toBe('unit');
    expect(mapping[7]).toBe('price');
  });

  it('never assigns the same field to two columns', () => {
    const mapping = guessItemMapping(['Name', 'Product Name', 'Description']);
    const used = mapping.filter((field) => field !== 'ignore');
    expect(new Set(used).size).toBe(used.length);
  });

  it('reads a walking-order sheet', () => {
    expect(guessAisleMapping(['sequence', 'aisle', 'aisle_name'])).toEqual([
      'sequence',
      'aisle',
      'aisle_name',
    ]);
  });
});

describe('guessSheetRole', () => {
  it('spots the master item list', () => {
    const sheet = table(
      ['item_id', 'item_name', 'aisle', 'shelf_sequence', 'price'],
      [['1', 'Milk', '3', '3.1', '2.99']],
    );
    expect(guessSheetRole(sheet)).toBe('items');
  });

  it('spots the walking order sheet (option 1)', () => {
    const sheet = table(
      ['sequence', 'aisle', 'aisle_name'],
      [
        ['1', '1', 'Produce'],
        ['2', '2', 'Bakery'],
      ],
    );
    expect(guessSheetRole(sheet)).toBe('aisles');
  });

  it('spots a walking order sheet with no sequence column', () => {
    const sheet = table(
      ['Aisle', 'Aisle Name'],
      [
        ['1', 'Produce'],
        ['2', 'Bakery'],
      ],
    );
    expect(guessSheetRole(sheet)).toBe('aisles');
  });

  it('skips a sheet with nothing recognisable', () => {
    expect(guessSheetRole(table(['foo', 'bar'], [['1', '2']]))).toBe('skip');
  });
});

describe('buildItems', () => {
  const headers = ['item_id', 'item_name', 'brand', 'size', 'aisle', 'shelf_sequence', 'price'];
  const mapping = guessItemMapping(headers);

  it('reads rows into catalog items', () => {
    const { items } = buildItems(
      table(headers, [
        ['1042', 'Milk 2% Half Gallon', 'Farmland', '1/2 gal', '3', '3.4', '3.49'],
        ['2001', 'Bananas', '', '', '1', '1.2', '0.59'],
      ]),
      mapping,
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: '1042',
      name: 'Milk 2% Half Gallon',
      brand: 'Farmland',
      aisle: '3',
      shelfSequence: 3.4,
      price: 3.49,
    });
  });

  it('strips currency symbols from prices', () => {
    const { items } = buildItems(
      table(headers, [['1', 'Milk', '', '', '3', '1', '$3.49']]),
      mapping,
    );
    expect(items[0].price).toBe(3.49);
  });

  it('generates a stable id when the sheet has none, so re-import updates', () => {
    const noIdHeaders = ['item_name', 'brand', 'size', 'aisle'];
    const noIdMapping = guessItemMapping(noIdHeaders);
    const rows = [['Milk 2% Half Gallon', 'Farmland', '1/2 gal', '3']];

    const first = buildItems(table(noIdHeaders, rows), noIdMapping);
    const second = buildItems(table(noIdHeaders, rows), noIdMapping);

    expect(first.generatedIds).toBe(1);
    expect(first.items[0].id).toBe(second.items[0].id);
  });

  it('keeps two rows that share an id from overwriting each other', () => {
    const { items } = buildItems(
      table(headers, [
        ['1042', 'Milk 2%', '', '', '3', '1', ''],
        ['1042', 'Milk Whole', '', '', '3', '2', ''],
      ]),
      mapping,
    );
    expect(items).toHaveLength(2);
    expect(items[0].id).not.toBe(items[1].id);
  });

  it('skips rows with no product name', () => {
    const { items, skipped } = buildItems(
      table(headers, [
        ['1', '', '', '', '', '', ''],
        ['2', 'Bread', '', '', '2', '1', ''],
      ]),
      mapping,
    );
    expect(items).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('option 2: row order becomes the walking order', () => {
    const { items, derivedAisles } = buildItems(
      table(
        ['item_name', 'aisle'],
        [
          ['Bananas', 'Produce'],
          ['Apples', 'Produce'],
          ['Rye Bread', 'Bakery'],
          ['Milk', 'Dairy'],
        ],
      ),
      guessItemMapping(['item_name', 'aisle']),
      { rowOrderIsWalkingOrder: true },
    );

    expect(items.map((entry) => entry.shelfSequence)).toEqual([1, 2, 3, 4]);
    expect(derivedAisles).toEqual([
      { id: 'Produce', sequence: 1, name: '' },
      { id: 'Bakery', sequence: 2, name: '' },
      { id: 'Dairy', sequence: 3, name: '' },
    ]);
  });
});

describe('buildAisles', () => {
  it('reads the walking order and renumbers it 1..n', () => {
    const headers = ['sequence', 'aisle', 'aisle_name'];
    const { aisles } = buildAisles(
      table(headers, [
        ['10', '3', 'Dairy'],
        ['5', '1', 'Produce'],
        ['7', '2', 'Bakery'],
      ]),
      guessAisleMapping(headers),
    );
    expect(aisles).toEqual([
      { id: '1', sequence: 1, name: 'Produce' },
      { id: '2', sequence: 2, name: 'Bakery' },
      { id: '3', sequence: 3, name: 'Dairy' },
    ]);
  });

  it('falls back to row order when there is no sequence column', () => {
    const headers = ['Aisle', 'Aisle Name'];
    const { aisles } = buildAisles(
      table(headers, [
        ['3', 'Dairy'],
        ['1', 'Produce'],
      ]),
      guessAisleMapping(headers),
    );
    expect(aisles.map((aisle) => aisle.id)).toEqual(['3', '1']);
  });
});

describe('readWorkbook', () => {
  function workbookFile(sheets: Record<string, unknown[][]>, fileName = 'store.xlsx'): File {
    const book = XLSX.utils.book_new();
    for (const [name, grid] of Object.entries(sheets)) {
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(grid), name);
    }
    const buffer = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    return new File([buffer], fileName);
  }

  it('reads both sheets out of one uploaded workbook', async () => {
    const file = workbookFile({
      Items: [
        ['item_id', 'item_name', 'aisle', 'shelf_sequence'],
        ['1042', 'Milk 2% Half Gallon', '3', 3.4],
      ],
      Walk: [
        ['sequence', 'aisle', 'aisle_name'],
        [1, '1', 'Produce'],
        [2, '3', 'Dairy'],
      ],
    });

    const parsed = await readWorkbook(file);
    expect(parsed.tables.map((entry) => entry.name)).toEqual(['Items', 'Walk']);
    expect(guessSheetRole(parsed.tables[0])).toBe('items');
    expect(guessSheetRole(parsed.tables[1])).toBe('aisles');
    expect(parsed.tables[0].rows[0]).toEqual(['1042', 'Milk 2% Half Gallon', '3', '3.4']);
  });

  it('finds the header row under a title and a blank line', async () => {
    const file = workbookFile({
      Sheet1: [
        ['Green Street Grocery — master list'],
        [],
        ['item_id', 'item_name', 'aisle'],
        ['1', 'Bananas', '1'],
      ],
    });
    const parsed = await readWorkbook(file);
    expect(parsed.tables[0].headers).toEqual(['item_id', 'item_name', 'aisle']);
    expect(parsed.tables[0].rows).toEqual([['1', 'Bananas', '1']]);
  });

  it('reads a CSV the same way', async () => {
    const csv = 'item_id,item_name,aisle,shelf_sequence\n1042,Milk,3,3.4\n2001,Bananas,1,1.2\n';
    const parsed = await readWorkbook(new File([csv], 'items.csv'));
    expect(parsed.tables[0].rows).toHaveLength(2);
    expect(guessSheetRole(parsed.tables[0])).toBe('items');
  });
});
