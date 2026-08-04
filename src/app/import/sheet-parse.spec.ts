import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

import {
  buildAisles,
  buildCustomers,
  buildItems,
  guessAisleMapping,
  guessCustomerMapping,
  guessItemMapping,
  guessSheetRole,
  readWorkbook,
  type SheetTable,
} from './sheet-parse';
import type { Customer } from '../core/models';
import { normalizeSheetUrl } from './sheet-sync.service';

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

  it('spots a customer list by its phone or email column', () => {
    expect(
      guessSheetRole(
        table(['Name', 'Phone', 'Address'], [['John Cohen', '555-1234', '14 Elm St']]),
      ),
    ).toBe('customers');
    expect(
      guessSheetRole(table(['Customer', 'Email'], [['John Cohen', 'j@example.com']])),
    ).toBe('customers');
  });

  it('spots a customer list from the tab name when it has neither', () => {
    expect(
      guessSheetRole(table(['Name', 'Address'], [['John Cohen', '14 Elm St']], 'Customers')),
    ).toBe('customers');
  });

  it('does not mistake a product sheet for a customer list', () => {
    expect(
      guessSheetRole(
        table(
          ['item_id', 'item_name', 'brand', 'aisle', 'price'],
          [['1', 'Milk', 'Farmland', '3', '2.99']],
        ),
      ),
    ).toBe('items');
  });

  it('skips a sheet with nothing recognisable', () => {
    expect(guessSheetRole(table(['foo', 'bar'], [['1', '2']]))).toBe('skip');
  });
});

describe('buildCustomers', () => {
  function existing(partial: Partial<Customer> & { id: string; name: string }): Customer {
    return {
      phone: '',
      email: '',
      address: '',
      notes: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...partial,
    };
  }

  it('reads a customer sheet', () => {
    const headers = ['Name', 'Phone', 'Email', 'Address', 'Notes'];
    const { customers } = buildCustomers(
      table(headers, [
        ['John Cohen', '(555) 214-8890', 'jcohen@example.com', '14 Elm Street', 'Doorman'],
        ['Sarah Klein', '(555) 663-2201', 'sarah@example.com', '882 Oak Avenue', ''],
      ]),
      guessCustomerMapping(headers),
    );
    expect(customers).toHaveLength(2);
    expect(customers[0]).toMatchObject({
      name: 'John Cohen',
      phone: '(555) 214-8890',
      email: 'jcohen@example.com',
      address: '14 Elm Street',
      notes: 'Doorman',
    });
  });

  it('updates a customer already in the app instead of duplicating them', () => {
    const headers = ['Name', 'Phone'];
    const mapping = guessCustomerMapping(headers);
    const known = [existing({ id: 'cust_john', name: 'John Cohen', phone: 'old' })];

    const { customers, matchedExisting } = buildCustomers(
      table(headers, [['John Cohen', '(555) 999-0000']]),
      mapping,
      known,
    );

    // Same id, so their learned shorthand and order history stay attached.
    expect(customers[0].id).toBe('cust_john');
    expect(customers[0].phone).toBe('(555) 999-0000');
    expect(customers[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(matchedExisting).toBe(1);
  });

  it('honours an explicit customer id column', () => {
    const headers = ['Account', 'Name'];
    const { customers } = buildCustomers(
      table(headers, [['C-104', 'John Cohen']]),
      guessCustomerMapping(headers),
    );
    expect(customers[0].id).toBe('C-104');
  });

  it('gives the same id on a second import of an unchanged sheet', () => {
    const headers = ['Name', 'Phone'];
    const mapping = guessCustomerMapping(headers);
    const rows = [['John Cohen', '555']];
    const first = buildCustomers(table(headers, rows), mapping);
    const second = buildCustomers(table(headers, rows), mapping, first.customers);
    expect(second.customers[0].id).toBe(first.customers[0].id);
  });

  it('keeps two people who share a name apart', () => {
    const headers = ['Name'];
    const { customers } = buildCustomers(
      table(headers, [['John Cohen'], ['John Cohen']]),
      guessCustomerMapping(headers),
    );
    expect(customers[0].id).not.toBe(customers[1].id);
  });

  it('skips rows with no name', () => {
    const headers = ['Name', 'Phone'];
    const { customers, skipped } = buildCustomers(
      table(headers, [['', '555'], ['Sarah Klein', '556']]),
      guessCustomerMapping(headers),
    );
    expect(customers).toHaveLength(1);
    expect(skipped).toBe(1);
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

  describe('a plain sheet in shelf order, with nothing else in it', () => {
    it('takes the walking order from the row order, with no options at all', () => {
      const headers = ['item_name'];
      const { items, derivedAisles, usedRowOrder } = buildItems(
        table(headers, [['Bananas'], ['Rye Bread'], ['Milk'], ['Toilet Paper']]),
        guessItemMapping(headers),
      );

      expect(usedRowOrder).toBe(true);
      expect(items.map((entry) => [entry.name, entry.shelfSequence])).toEqual([
        ['Bananas', 1],
        ['Rye Bread', 2],
        ['Milk', 3],
        ['Toilet Paper', 4],
      ]);
      // No aisle column is not a gap to fill in — the walk is already complete.
      expect(derivedAisles).toEqual([]);
    });

    it('derives the aisle walking order too, when the sheet names sections', () => {
      const headers = ['item_name', 'aisle'];
      const { items, derivedAisles } = buildItems(
        table(headers, [
          ['Bananas', 'Produce'],
          ['Apples', 'Produce'],
          ['Rye Bread', 'Bakery'],
          ['Milk', 'Dairy'],
        ]),
        guessItemMapping(headers),
      );

      expect(items.map((entry) => entry.shelfSequence)).toEqual([1, 2, 3, 4]);
      expect(derivedAisles).toEqual([
        { id: 'Produce', sequence: 1, name: '' },
        { id: 'Bakery', sequence: 2, name: '' },
        { id: 'Dairy', sequence: 3, name: '' },
      ]);
    });

    it('orders aisles by code when a sequence column means the rows are unordered', () => {
      // A catalog exported alphabetically: row position says nothing about the
      // walk, so aisle 2 must still come before aisle 10.
      const headers = ['item_name', 'aisle', 'shelf_sequence'];
      const { derivedAisles } = buildItems(
        table(headers, [
          ['Apples', '10', '1'],
          ['Bread', '2', '1'],
          ['Cheese', '1', '1'],
        ]),
        guessItemMapping(headers),
      );
      expect(derivedAisles.map((aisle) => aisle.id)).toEqual(['1', '2', '10']);
    });

    it('still lets an explicit sequence column win when there is one', () => {
      const headers = ['item_name', 'shelf_sequence'];
      const { items, usedRowOrder } = buildItems(
        table(headers, [
          ['Bananas', '30'],
          ['Rye Bread', '10'],
          ['Milk', '20'],
        ]),
        guessItemMapping(headers),
      );
      expect(usedRowOrder).toBe(false);
      expect(items.map((entry) => entry.shelfSequence)).toEqual([30, 10, 20]);
    });

    it('can be told to ignore a sequence column and use the row order instead', () => {
      const headers = ['item_name', 'shelf_sequence'];
      const { items, usedRowOrder } = buildItems(
        table(headers, [
          ['Bananas', '30'],
          ['Rye Bread', '10'],
          ['Milk', '20'],
        ]),
        guessItemMapping(headers),
        { rowOrderIsWalkingOrder: true },
      );
      expect(usedRowOrder).toBe(true);
      expect(items.map((entry) => entry.shelfSequence)).toEqual([1, 2, 3]);
    });

    it('fills the gaps when only some rows carry a sequence', () => {
      const headers = ['item_name', 'shelf_sequence'];
      const { items } = buildItems(
        table(headers, [
          ['Bananas', '5'],
          ['Rye Bread', ''],
          ['Milk', '9'],
        ]),
        guessItemMapping(headers),
      );
      expect(items.map((entry) => entry.shelfSequence)).toEqual([5, 2, 9]);
    });
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

describe('normalizeSheetUrl', () => {
  it('turns a Google Sheets editor address into one that returns data', () => {
    expect(
      normalizeSheetUrl('https://docs.google.com/spreadsheets/d/1AbC-dEf_9/edit#gid=42'),
    ).toBe('https://docs.google.com/spreadsheets/d/1AbC-dEf_9/export?format=csv&gid=42');
  });

  it('defaults to the first tab when the address names none', () => {
    expect(normalizeSheetUrl('https://docs.google.com/spreadsheets/d/1AbC-dEf_9/edit')).toBe(
      'https://docs.google.com/spreadsheets/d/1AbC-dEf_9/export?format=csv&gid=0',
    );
  });

  it('leaves an already-published link alone', () => {
    const published = 'https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pub?output=csv';
    expect(normalizeSheetUrl(published)).toBe(published);
  });

  it('leaves any other host alone', () => {
    expect(normalizeSheetUrl('  https://example.com/shelf.xlsx  ')).toBe(
      'https://example.com/shelf.xlsx',
    );
  });
});
