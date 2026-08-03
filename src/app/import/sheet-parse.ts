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
import type { Aisle, Item } from '../core/models';

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

export type SheetField = ItemField | AisleField | 'ignore';

export interface SheetTable {
  name: string;
  headers: string[];
  /** Data rows, aligned to `headers`. */
  rows: string[][];
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
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true, raw: false });

  const tables: SheetTable[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (sheet === undefined) continue;
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: '',
    });
    if (grid.length === 0) continue;

    const headerRow = findHeaderRow(grid);
    const headers = (grid[headerRow] ?? []).map(cellText);
    const width = headers.length;
    const rows = grid
      .slice(headerRow + 1)
      .map((row) => {
        const cells: string[] = [];
        for (let column = 0; column < width; column += 1) cells.push(cellText(row[column]));
        return cells;
      })
      .filter((row) => row.some((cell) => cell !== ''));

    tables.push({ name, headers, rows });
  }

  return { fileName: file.name, tables };
}

/** Best-guess mapping from a sheet's headers to item fields. */
export function guessItemMapping(headers: string[]): SheetField[] {
  const taken = new Set<SheetField>();
  const mapping: SheetField[] = headers.map(() => 'ignore');

  // Two passes so an exact synonym hit always beats a looser one.
  for (const pass of [0, 1]) {
    headers.forEach((header, column) => {
      if (mapping[column] !== 'ignore') return;
      const key = headerKey(header);
      if (key === '') return;
      for (const [field, synonyms] of Object.entries(ITEM_HEADER_SYNONYMS) as [
        ItemField,
        string[],
      ][]) {
        if (taken.has(field)) continue;
        const hit =
          pass === 0
            ? synonyms.includes(key)
            : synonyms.some((synonym) => key.includes(synonym) || synonym.includes(key));
        if (hit) {
          mapping[column] = field;
          taken.add(field);
          return;
        }
      }
    });
  }
  return mapping;
}

export function guessAisleMapping(headers: string[]): SheetField[] {
  const taken = new Set<SheetField>();
  const mapping: SheetField[] = headers.map(() => 'ignore');
  for (const pass of [0, 1]) {
    headers.forEach((header, column) => {
      if (mapping[column] !== 'ignore') return;
      const key = headerKey(header);
      if (key === '') return;
      for (const [field, synonyms] of Object.entries(AISLE_HEADER_SYNONYMS) as [
        AisleField,
        string[],
      ][]) {
        if (taken.has(field)) continue;
        const hit =
          pass === 0
            ? synonyms.includes(key)
            : synonyms.some((synonym) => key.includes(synonym) || synonym.includes(key));
        if (hit) {
          mapping[column] = field;
          taken.add(field);
          return;
        }
      }
    });
  }
  return mapping;
}

export type SheetRole = 'items' | 'aisles' | 'skip';

/**
 * Guess what a sheet is for.
 *
 * A sheet with product names is the master item list; a short sheet whose
 * columns are only aisle-ish is the walking order (Sheet B, Option 1).
 */
export function guessSheetRole(table: SheetTable): SheetRole {
  if (table.rows.length === 0) return 'skip';
  const itemMapping = guessItemMapping(table.headers);
  const aisleMapping = guessAisleMapping(table.headers);
  const aisleFields = new Set(aisleMapping.filter((field) => field !== 'ignore'));

  // "Aisle name" is a name column, but not a *product* name column.
  const hasProductName = table.headers.some(
    (header, column) => itemMapping[column] === 'item_name' && !headerKey(header).includes('aisle'),
  );

  if (!aisleFields.has('aisle')) return hasProductName ? 'items' : 'skip';
  if (!hasProductName) return 'aisles';

  // Both readings fit. A short sheet with few rows is a walking order, not a
  // catalog — and the import screen lets a human overrule this either way.
  const columns = table.headers.filter((header) => header.trim() !== '').length;
  const compact = columns <= 3 && table.rows.length <= 60 && aisleFields.has('sequence');
  return compact ? 'aisles' : 'items';
}

function toNumber(value: string): number | null {
  const cleaned = value.replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface ItemImportOptions {
  /**
   * Sheet B Option 2: the rows are already in exact walking order, so the row
   * number becomes the shelf sequence and first appearance sets aisle order.
   */
  rowOrderIsWalkingOrder: boolean;
}

export interface ItemImportResult {
  items: Item[];
  /** Aisle order derived from the sheet, when Option 2 was used. */
  derivedAisles: Aisle[];
  skipped: number;
  generatedIds: number;
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

  const items: Item[] = [];
  const seen = new Set<string>();
  const aisleFirstSeen = new Map<string, number>();
  let skipped = 0;
  let generatedIds = 0;

  table.rows.forEach((row, rowIndex) => {
    const cell = (column: number): string => (column < 0 ? '' : (row[column] ?? '').trim());
    const name = cell(nameColumn);
    if (name === '') {
      skipped += 1;
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

    const explicitSequence = toNumber(cell(sequenceColumn));
    const shelfSequence = options.rowOrderIsWalkingOrder
      ? rowIndex + 1
      : explicitSequence;

    if (aisle !== '' && !aisleFirstSeen.has(aisle)) aisleFirstSeen.set(aisle, rowIndex);

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

  const derivedAisles: Aisle[] = options.rowOrderIsWalkingOrder
    ? [...aisleFirstSeen.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([aisle], position) => ({ id: aisle, sequence: position + 1, name: '' }))
    : [];

  return { items, derivedAisles, skipped, generatedIds };
}

export interface AisleImportResult {
  aisles: Aisle[];
  skipped: number;
}

export function buildAisles(table: SheetTable, mapping: SheetField[]): AisleImportResult {
  const columnOf = (field: SheetField): number => mapping.indexOf(field);
  const aisleColumn = columnOf('aisle');
  const sequenceColumn = columnOf('sequence');
  const nameColumn = columnOf('aisle_name');

  const aisles: Aisle[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  table.rows.forEach((row, rowIndex) => {
    const cell = (column: number): string => (column < 0 ? '' : (row[column] ?? '').trim());
    const id = cell(aisleColumn);
    if (id === '' || seen.has(id)) {
      skipped += 1;
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
    skipped,
  };
}

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
