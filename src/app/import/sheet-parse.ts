/**
 * Reads an uploaded .xlsx / .xls / .csv into rows, works out which columns are
 * which, and turns them into catalog items or an aisle walking order.
 *
 * The store's real sheets will not use our column names, so headers are
 * detected from a synonym list and every guess is shown in the import preview
 * for a human to correct before anything is written.
 */

import * as XLSX from 'xlsx';

import { stableId } from '../core/ids';
import type { Aisle, Customer, Item } from '../core/models';

export type ItemField =
  | 'item_id'
  | 'item_name'
  | 'brand'
  | 'size'
  | 'department'
  | 'aisle'
  | 'shelf_sequence'
  | 'unit'
  | 'price'
  | 'barcode';

export type AisleField = 'sequence' | 'aisle' | 'aisle_name';

export type CustomerField =
  | 'customer_id'
  | 'customer_name'
  | 'phone'
  | 'email'
  | 'address'
  | 'customer_notes';

export type SheetField = ItemField | AisleField | CustomerField | 'ignore';

export interface SheetTable {
  name: string;
  headers: string[];
  /** Data rows, aligned to `headers`. */
  rows: string[][];
  /**
   * The spreadsheet row each entry in `rows` came from, numbered the way Excel
   * numbers them. Blank rows are dropped before import, so without this a
   * report saying "row 42" would point at the wrong line in the file.
   *
   * Optional so a table can still be built by hand; parsing always fills it.
   */
  rowNumbers?: number[];
}

/**
 * A row that did not become a record, and why.
 *
 * The count on its own is useless: nobody can fix a spreadsheet from the fact
 * that 3,489 rows went missing. The row number has to match the file, the
 * reason has to be specific, and the contents have to be visible, or there is
 * nothing to act on.
 */
export interface SkippedRow {
  sheet: string;
  /** 1-based, as shown in Excel's row gutter. */
  rowNumber: number;
  reason: string;
  /** Non-empty cells, labelled with their headers. */
  cells: { header: string; value: string }[];
}

export interface ParsedWorkbook {
  fileName: string;
  tables: SheetTable[];
}

/** Header synonyms, in priority order. Compared after normalising to a-z0-9. */
const ITEM_HEADER_SYNONYMS: Record<ItemField, string[]> = {
  item_id: ['itemid', 'id', 'sku', 'itemcode', 'code', 'productid', 'plu', 'itemnumber', 'item'],
  item_name: [
    'itemname',
    'name',
    'productname',
    'product',
    'description',
    'itemdescription',
    'title',
  ],
  brand: ['brand', 'manufacturer', 'vendor', 'label'],
  size: ['size', 'pack', 'packsize', 'weight', 'volume', 'packaging'],
  department: ['department', 'dept', 'category', 'section', 'class'],
  aisle: ['aisle', 'aisleno', 'ailse', 'aislenumber', 'aisle', 'location', 'row'],
  shelf_sequence: [
    'shelfsequence',
    'shelfseq',
    'sequence',
    'seq',
    'shelforder',
    'pickorder',
    'walkorder',
    'sortorder',
    'order',
    'position',
    'shelf',
    'bay',
  ],
  unit: ['unit', 'uom', 'unitofmeasure', 'sellby'],
  price: ['price', 'retail', 'retailprice', 'unitprice', 'cost'],
  barcode: ['barcode', 'upc', 'ean', 'gtin', 'scancode'],
};

const CUSTOMER_HEADER_SYNONYMS: Record<CustomerField, string[]> = {
  customer_id: ['customerid', 'id', 'accountnumber', 'account', 'accountno', 'customerno', 'code'],
  customer_name: [
    'customername',
    'name',
    'customer',
    'client',
    'clientname',
    'contact',
    'contactname',
    'fullname',
    'household',
    'business',
  ],
  phone: ['phone', 'phonenumber', 'telephone', 'tel', 'mobile', 'cell', 'cellphone', 'contactnumber'],
  email: ['email', 'emailaddress', 'mail', 'emailid'],
  address: [
    'address',
    'deliveryaddress',
    'streetaddress',
    'street',
    'addr',
    'shipto',
    'addressline1',
  ],
  customer_notes: [
    'notes',
    'note',
    'comment',
    'comments',
    'remarks',
    'instructions',
    'deliverynotes',
    'deliveryinstructions',
    'specialinstructions',
  ],
};

const AISLE_HEADER_SYNONYMS: Record<AisleField, string[]> = {
  sequence: ['sequence', 'seq', 'order', 'walkorder', 'position', 'step', 'sortorder', 'no'],
  aisle: ['aisle', 'aisleno', 'aislenumber', 'ailse', 'number', 'code', 'id'],
  aisle_name: ['aislename', 'name', 'description', 'label', 'section', 'department'],
};

function headerKey(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

/**
 * Find the header row.
 *
 * Sheets exported from a POS often carry a title and a blank line above the
 * real headers, so the first ten rows are scored and the best one wins.
 */
function findHeaderRow(rows: unknown[][]): number {
  const known = new Set([
    ...Object.values(ITEM_HEADER_SYNONYMS).flat(),
    ...Object.values(AISLE_HEADER_SYNONYMS).flat(),
  ]);

  let bestRow = 0;
  let bestScore = -1;
  const limit = Math.min(rows.length, 10);
  for (let index = 0; index < limit; index += 1) {
    const cells = (rows[index] ?? []).map(cellText).filter((cell) => cell !== '');
    if (cells.length < 2) continue;
    const hits = cells.filter((cell) => known.has(headerKey(cell))).length;
    // Prefer rows that look like labels rather than data.
    const wordiness = cells.filter((cell) => /[a-z]/i.test(cell)).length / cells.length;
    const score = hits * 2 + wordiness + cells.length * 0.05;
    if (score > bestScore) {
      bestScore = score;
      bestRow = index;
    }
  }
  return bestRow;
}

export async function readWorkbook(file: File): Promise<ParsedWorkbook> {
  return readWorkbookBuffer(await file.arrayBuffer(), file.name);
}

/** Same reader, for bytes that did not come from a file input — a URL, say. */
export function readWorkbookBuffer(buffer: ArrayBuffer, fileName: string): ParsedWorkbook {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true, raw: false });

  const tables: SheetTable[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (sheet === undefined) continue;
    // Blank rows are kept at this stage purely so a row's position in the grid
    // still equals its row number in the file; they are dropped just below.
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: true,
      defval: '',
    });
    if (grid.length === 0) continue;

    const headerRow = findHeaderRow(grid);
    const headers = (grid[headerRow] ?? []).map(cellText);
    const width = headers.length;

    const rows: string[][] = [];
    const rowNumbers: number[] = [];
    for (let index = headerRow + 1; index < grid.length; index += 1) {
      const cells: string[] = [];
      for (let column = 0; column < width; column += 1) cells.push(cellText(grid[index]?.[column]));
      // A wholly empty line is spacing, not a failed record. Reporting those
      // as skipped would bury the rows that actually needed attention.
      if (!cells.some((cell) => cell !== '')) continue;
      rows.push(cells);
      rowNumbers.push(index + 1);
    }

    tables.push({ name, headers, rows, rowNumbers });
  }

  return { fileName, tables };
}

/**
 * Map a sheet's headers onto a set of fields.
 *
 * Two passes: an exact synonym hit is taken everywhere it can be, and only
 * then are looser substring matches considered, so "Item Name" can never be
 * claimed by the `id` synonym list before `item_name` gets a look at it.
 */
function guessMapping(headers: string[], synonymsByField: Record<string, string[]>): SheetField[] {
  const taken = new Set<string>();
  const mapping: SheetField[] = headers.map(() => 'ignore');
  const fields = Object.entries(synonymsByField);

  for (const pass of [0, 1]) {
    headers.forEach((header, column) => {
      if (mapping[column] !== 'ignore') return;
      const key = headerKey(header);
      if (key === '') return;
      for (const [field, synonyms] of fields) {
        if (taken.has(field)) continue;
        const hit =
          pass === 0
            ? synonyms.includes(key)
            : synonyms.some((synonym) => key.includes(synonym) || synonym.includes(key));
        if (hit) {
          mapping[column] = field as SheetField;
          taken.add(field);
          return;
        }
      }
    });
  }
  return mapping;
}

/** Best-guess mapping from a sheet's headers to item fields. */
export function guessItemMapping(headers: string[]): SheetField[] {
  return guessMapping(headers, ITEM_HEADER_SYNONYMS);
}

export function guessAisleMapping(headers: string[]): SheetField[] {
  return guessMapping(headers, AISLE_HEADER_SYNONYMS);
}

export function guessCustomerMapping(headers: string[]): SheetField[] {
  return guessMapping(headers, CUSTOMER_HEADER_SYNONYMS);
}

export type SheetRole = 'items' | 'aisles' | 'customers' | 'skip';

/**
 * Guess what a sheet is for.
 *
 * A sheet with product names is the master item list; a short sheet whose
 * columns are only aisle-ish is the walking order (Sheet B, Option 1).
 */
export function guessSheetRole(table: SheetTable): SheetRole {
  if (table.rows.length === 0) return 'skip';

  // A phone or email column is only ever a customer list, and a tab actually
  // named "Customers" settles it outright.
  const customerMapping = guessCustomerMapping(table.headers);
  const customerFields = new Set(customerMapping.filter((field) => field !== 'ignore'));
  const namedForCustomers = /customer|client|account/i.test(table.name);
  if (
    customerFields.has('customer_name') &&
    (customerFields.has('phone') || customerFields.has('email') || namedForCustomers)
  ) {
    return 'customers';
  }

  const itemMapping = guessItemMapping(table.headers);
  const aisleMapping = guessAisleMapping(table.headers);
  const aisleFields = new Set(aisleMapping.filter((field) => field !== 'ignore'));

  // "Aisle name" is a name column, but not a *product* name column.
  const hasProductName = table.headers.some(
    (header, column) => itemMapping[column] === 'item_name' && !headerKey(header).includes('aisle'),
  );

  if (!aisleFields.has('aisle')) return hasProductName ? 'items' : 'skip';
  if (!hasProductName) return 'aisles';

  // Both readings fit — the sheet has an aisle column and something that could
  // be a name. What settles it is the aisle column itself: a walking order
  // lists each aisle once, while a catalog puts many products in the same
  // aisle. Brands, sizes, prices and codes only ever belong to a catalog.
  if (/aisle|walk|shelf|section|layout|route/i.test(table.name)) return 'aisles';

  const catalogOnly: ItemField[] = ['brand', 'size', 'price', 'barcode', 'unit', 'item_id'];
  if (catalogOnly.some((field) => itemMapping.includes(field))) return 'items';

  const columns = table.headers.filter((header) => header.trim() !== '').length;
  if (columns > 4) return 'items';

  const aisleColumn = aisleMapping.indexOf('aisle');
  const values = table.rows
    .map((row) => (row[aisleColumn] ?? '').trim())
    .filter((value) => value !== '');
  // An aisle column with nothing in it is a broken walking order, not a
  // product list. Reading it as one would quietly file aisle names in the
  // catalog; calling it a walking order surfaces the real problem instead.
  if (values.length === 0) return 'aisles';

  return new Set(values).size === values.length ? 'aisles' : 'items';
}

function toNumber(value: string): number | null {
  const cleaned = value.replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface ItemImportOptions {
  /**
   * Force the row order to be the shelf order even when the sheet also has a
   * sequence column. Off by default, because an explicit column is a
   * deliberate statement and should win.
   *
   * It is not needed for the ordinary case: a sheet with no sequence column
   * always takes its shelf order from the row order.
   */
  rowOrderIsWalkingOrder: boolean;
}

export interface ItemImportResult {
  items: Item[];
  /** The aisle walking order this sheet implies, in the order it implies it. */
  derivedAisles: Aisle[];
  skipped: number;
  /** Every skipped row, with the reason and its contents. */
  skippedRows: SkippedRow[];
  generatedIds: number;
  /** True when the row order supplied the shelf positions. */
  usedRowOrder: boolean;
  /** Which column was read as the product name — the usual suspect when rows go missing. */
  nameHeader: string;
}

/** Describe a row so someone can recognise it in their own spreadsheet. */
function describeRow(table: SheetTable, rowIndex: number, reason: string): SkippedRow {
  const row = table.rows[rowIndex] ?? [];
  return {
    sheet: table.name,
    // Falling back to "header is row 1, data starts at row 2", which is what a
    // table assembled without row numbers means.
    rowNumber: table.rowNumbers?.[rowIndex] ?? rowIndex + 2,
    reason,
    cells: row
      .map((value, column) => ({ header: table.headers[column] ?? `Column ${column + 1}`, value }))
      .filter((cell) => cell.value.trim() !== ''),
  };
}

export function buildItems(
  table: SheetTable,
  mapping: SheetField[],
  options: ItemImportOptions = { rowOrderIsWalkingOrder: false },
): ItemImportResult {
  const columnOf = (field: SheetField): number => mapping.indexOf(field);
  const nameColumn = columnOf('item_name');
  const idColumn = columnOf('item_id');
  const aisleColumn = columnOf('aisle');
  const sequenceColumn = columnOf('shelf_sequence');

  // No sequence column means the rows themselves carry the shelf order.
  const useRowOrder = options.rowOrderIsWalkingOrder || sequenceColumn < 0;

  const items: Item[] = [];
  const seen = new Set<string>();
  const aisleFirstSeen = new Map<string, number>();
  const skippedRows: SkippedRow[] = [];
  let generatedIds = 0;

  const nameHeader = nameColumn < 0 ? '' : (table.headers[nameColumn] ?? '');

  table.rows.forEach((row, rowIndex) => {
    const cell = (column: number): string => (column < 0 ? '' : (row[column] ?? '').trim());
    const name = cell(nameColumn);
    if (name === '') {
      // The only way a product row is refused. Missing ids are generated,
      // repeated ids are re-derived and an unreadable price becomes blank, so
      // if a row is gone, this is why.
      skippedRows.push(
        describeRow(
          table,
          rowIndex,
          nameColumn < 0
            ? 'No product name column was found on this sheet.'
            : `No product name — the “${nameHeader}” cell is empty.`,
        ),
      );
      return;
    }

    const brand = cell(columnOf('brand'));
    const size = cell(columnOf('size'));
    const aisle = cell(aisleColumn);

    let id = cell(idColumn);
    if (id === '') {
      id = stableId(name, brand, size);
      generatedIds += 1;
    }
    // A duplicate id inside one sheet would silently drop a product, so the
    // later row gets its own derived id instead.
    if (seen.has(id)) id = stableId(id, name, brand, size, String(rowIndex));
    seen.add(id);

    // The sheet's own order is the store's order. An explicit sequence column
    // overrides it; without one, row 1 is simply the first thing on the walk.
    const explicitSequence = toNumber(cell(sequenceColumn));
    const shelfSequence = useRowOrder ? rowIndex + 1 : (explicitSequence ?? rowIndex + 1);

    if (aisle !== '' && !aisleFirstSeen.has(aisle)) {
      aisleFirstSeen.set(aisle, useRowOrder ? rowIndex : (explicitSequence ?? rowIndex));
    }

    items.push({
      id,
      name,
      brand,
      size,
      department: cell(columnOf('department')),
      aisle,
      shelfSequence,
      unit: cell(columnOf('unit')),
      price: toNumber(cell(columnOf('price'))),
      barcode: cell(columnOf('barcode')),
      active: true,
      updatedAt: new Date().toISOString(),
    });
  });

  // Where each aisle sits in the walk.
  //
  // When the rows carry the order, first appearance is the answer. When a
  // sequence column carries it instead, the row order means nothing — a sheet
  // sorted alphabetically would produce a nonsense walk — so aisles fall back
  // to their own codes, read naturally so "2" comes before "10".
  const derivedAisles: Aisle[] = (
    useRowOrder
      ? [...aisleFirstSeen.entries()].sort((a, b) => a[1] - b[1]).map(([aisle]) => aisle)
      : [...aisleFirstSeen.keys()].sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
        )
  ).map((aisle, position) => ({ id: aisle, sequence: position + 1, name: '' }));

  return {
    items,
    derivedAisles,
    skipped: skippedRows.length,
    skippedRows,
    generatedIds,
    usedRowOrder: useRowOrder,
    nameHeader,
  };
}

export interface AisleImportResult {
  aisles: Aisle[];
  skipped: number;
  skippedRows: SkippedRow[];
}

export function buildAisles(table: SheetTable, mapping: SheetField[]): AisleImportResult {
  const columnOf = (field: SheetField): number => mapping.indexOf(field);
  const aisleColumn = columnOf('aisle');
  const sequenceColumn = columnOf('sequence');
  const nameColumn = columnOf('aisle_name');

  const aisles: Aisle[] = [];
  const seen = new Set<string>();
  const skippedRows: SkippedRow[] = [];
  const aisleHeader = aisleColumn < 0 ? '' : (table.headers[aisleColumn] ?? '');

  table.rows.forEach((row, rowIndex) => {
    const cell = (column: number): string => (column < 0 ? '' : (row[column] ?? '').trim());
    const id = cell(aisleColumn);
    // Two different problems, and telling them apart is the whole point: a
    // blank cell is a gap in the sheet, a repeat is the same aisle listed twice.
    if (id === '') {
      skippedRows.push(
        describeRow(
          table,
          rowIndex,
          aisleColumn < 0
            ? 'No aisle column was found on this sheet.'
            : `No aisle code — the “${aisleHeader}” cell is empty.`,
        ),
      );
      return;
    }
    if (seen.has(id)) {
      skippedRows.push(
        describeRow(table, rowIndex, `Aisle “${id}” is already listed higher up this sheet.`),
      );
      return;
    }
    seen.add(id);
    // No sequence column? The row order *is* the walking order.
    const sequence = toNumber(cell(sequenceColumn)) ?? rowIndex + 1;
    aisles.push({ id, sequence, name: cell(nameColumn) });
  });

  return {
    aisles: aisles
      .sort((a, b) => a.sequence - b.sequence)
      .map((aisle, position) => ({ ...aisle, sequence: position + 1 })),
    skipped: skippedRows.length,
    skippedRows,
  };
}

export interface CustomerImportResult {
  customers: Customer[];
  skipped: number;
  skippedRows: SkippedRow[];
  /** How many rows matched a customer the store already had. */
  matchedExisting: number;
}

/**
 * Read a customer list.
 *
 * Ids matter here: a customer's learned shorthand and their order history hang
 * off theirs. So a row is tied to an existing customer by its id column when
 * there is one, and otherwise by name — which is what "update John Cohen's
 * phone number" means to the person editing the sheet.
 */
export function buildCustomers(
  table: SheetTable,
  mapping: SheetField[],
  existing: Customer[] = [],
): CustomerImportResult {
  const columnOf = (field: SheetField): number => mapping.indexOf(field);
  const nameColumn = columnOf('customer_name');
  const idColumn = columnOf('customer_id');

  const idByName = new Map<string, string>();
  for (const customer of existing) {
    const key = customer.name.trim().toLowerCase();
    if (key !== '' && !idByName.has(key)) idByName.set(key, customer.id);
  }
  const byId = new Map(existing.map((customer) => [customer.id, customer]));

  const customers: Customer[] = [];
  const seen = new Set<string>();
  const skippedRows: SkippedRow[] = [];
  const nameHeader = nameColumn < 0 ? '' : (table.headers[nameColumn] ?? '');
  let matchedExisting = 0;

  table.rows.forEach((row, rowIndex) => {
    const cell = (column: number): string => (column < 0 ? '' : (row[column] ?? '').trim());
    const name = cell(nameColumn);
    if (name === '') {
      skippedRows.push(
        describeRow(
          table,
          rowIndex,
          nameColumn < 0
            ? 'No customer name column was found on this sheet.'
            : `No customer name — the “${nameHeader}” cell is empty.`,
        ),
      );
      return;
    }

    const explicitId = cell(idColumn);
    const knownId = idByName.get(name.toLowerCase());
    let id = explicitId !== '' ? explicitId : (knownId ?? stableId('customer', name));
    if (explicitId !== '' || knownId !== undefined) matchedExisting += 1;
    if (seen.has(id)) id = stableId('customer', name, String(rowIndex));
    seen.add(id);

    customers.push({
      id,
      name,
      phone: cell(columnOf('phone')),
      email: cell(columnOf('email')),
      address: cell(columnOf('address')),
      notes: cell(columnOf('customer_notes')),
      createdAt: byId.get(id)?.createdAt ?? new Date().toISOString(),
    });
  });

  return { customers, skipped: skippedRows.length, skippedRows, matchedExisting };
}

export const CUSTOMER_FIELD_LABELS: Record<CustomerField | 'ignore', string> = {
  customer_id: 'Customer ID',
  customer_name: 'Customer name',
  phone: 'Phone',
  email: 'Email',
  address: 'Delivery address',
  customer_notes: 'Notes',
  ignore: "Don't import",
};

export const ITEM_FIELD_LABELS: Record<ItemField | 'ignore', string> = {
  item_id: 'Item ID',
  item_name: 'Item name',
  brand: 'Brand',
  size: 'Size',
  department: 'Department',
  aisle: 'Aisle',
  shelf_sequence: 'Shelf sequence',
  unit: 'Unit',
  price: 'Price',
  barcode: 'Barcode',
  ignore: "Don't import",
};

export const AISLE_FIELD_LABELS: Record<AisleField | 'ignore', string> = {
  sequence: 'Walking order',
  aisle: 'Aisle code',
  aisle_name: 'Aisle name',
  ignore: "Don't import",
};
