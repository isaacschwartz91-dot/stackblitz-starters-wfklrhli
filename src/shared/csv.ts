/**
 * CSV parsing, catalog import/export (FR-5) and record export (FR-34).
 *
 * The import is deliberately strict and loud: every rejected row is reported
 * with its line number and the reason, because a silently dropped row in a
 * price list becomes a wrong price on a reimbursement claim.
 */

import type { DietaryTag, Item, ShelfLifeClass } from './types';
import { DIETARY_TAGS, SHELF_LIFE_CLASSES } from './types';
import { centsToPlain, parseMoneyToCents, parseServingsToUnits, unitsToServings } from './units';
import { newId } from './ids';

// --- parsing --------------------------------------------------------------

/** RFC 4180-ish parser: handles quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  // Strip a UTF-8 BOM, which Excel writes and which otherwise corrupts the
  // first header name and breaks column mapping.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  while (i < input.length) {
    const char = input[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (char === '\r') {
      i++;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += char;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Quote a field only when it needs it. */
export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map((cell) => csvEscape(cell ?? '')).join(',')).join('\r\n');
}

// --- catalog import (FR-5) -----------------------------------------------

/** The catalog fields an import can populate. */
export const IMPORT_FIELDS = [
  'name',
  'nameEs',
  'packageSize',
  'categoryKey',
  'price',
  'servingsPerPackage',
  'sku',
  'upc',
  'tags',
  'shelfLifeClass',
  'active',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Which fields must be mapped for an import to be possible at all. */
export const REQUIRED_IMPORT_FIELDS: ImportField[] = [
  'name',
  'categoryKey',
  'price',
  'servingsPerPackage',
];

/** field -> column index in the CSV. -1 means "not mapped". */
export type ColumnMapping = Record<ImportField, number>;

/** Header names we recognise automatically, to pre-fill the mapping UI. */
const HEADER_ALIASES: Record<ImportField, string[]> = {
  name: ['name', 'item', 'item name', 'description', 'product'],
  nameEs: ['namees', 'name_es', 'spanish name', 'nombre'],
  packageSize: ['packagesize', 'package size', 'package', 'size', 'pack size'],
  categoryKey: ['categorykey', 'category', 'cat'],
  price: ['price', 'unit price', 'cost', 'retail'],
  servingsPerPackage: [
    'servingsperpackage',
    'servings per package',
    'servings',
    'creditable servings',
    'servings/package',
  ],
  sku: ['sku', 'item number', 'item #'],
  upc: ['upc', 'barcode', 'gtin'],
  tags: ['tags', 'attributes', 'labels'],
  shelfLifeClass: ['shelflifeclass', 'shelf life', 'shelf life class', 'storage'],
  active: ['active', 'enabled', 'in stock'],
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

/** Best-effort automatic mapping from a header row. */
export function inferColumnMapping(header: readonly string[]): ColumnMapping {
  const mapping = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, -1])) as ColumnMapping;
  const normalized = header.map(normalizeHeader);

  for (const field of IMPORT_FIELDS) {
    const aliases = HEADER_ALIASES[field].map(normalizeHeader);
    const index = normalized.findIndex((h) => aliases.includes(h) || h === normalizeHeader(field));
    mapping[field] = index;
  }
  return mapping;
}

export interface ImportRejection {
  /** 1-based line number in the file, counting the header. */
  line: number;
  reason: string;
  raw: string;
}

export interface ImportResult {
  /** Items ready to write. Existing items are matched and updated by SKU/UPC. */
  items: Item[];
  created: number;
  updated: number;
  rejected: ImportRejection[];
  /** Column mapping problems that stop the import before any row is read. */
  fatal: string | null;
}

export interface ImportOptions {
  rows: string[][];
  mapping: ColumnMapping;
  /** Whether the first row is a header and should be skipped. */
  hasHeader: boolean;
  existingItems: readonly Item[];
  validCategoryKeys: readonly string[];
}

/**
 * FR-5: validate and convert CSV rows into catalog items.
 * Nothing is written here — the caller decides what to do with the result
 * after showing the validation report.
 */
export function importCatalogRows(options: ImportOptions): ImportResult {
  const { rows, mapping, hasHeader, existingItems, validCategoryKeys } = options;
  const rejected: ImportRejection[] = [];
  const items: Item[] = [];
  let created = 0;
  let updated = 0;

  const missing = REQUIRED_IMPORT_FIELDS.filter((f) => mapping[f] < 0);
  if (missing.length > 0) {
    return {
      items: [],
      created: 0,
      updated: 0,
      rejected: [],
      fatal: `These required columns are not mapped: ${missing.join(', ')}.`,
    };
  }

  const bySku = new Map(existingItems.filter((i) => i.sku).map((i) => [i.sku.toLowerCase(), i]));
  const byUpc = new Map(existingItems.filter((i) => i.upc).map((i) => [i.upc, i]));
  const seenKeys = new Set<string>();
  const now = new Date().toISOString();

  const startIndex = hasHeader ? 1 : 0;
  for (let r = startIndex; r < rows.length; r++) {
    const row = rows[r]!;
    const line = r + 1;
    const raw = row.join(',');

    // Skip genuinely blank lines rather than reporting them as errors.
    if (row.every((cell) => cell.trim() === '')) continue;

    const cell = (field: ImportField): string => {
      const index = mapping[field];
      if (index < 0) return '';
      return (row[index] ?? '').trim();
    };

    const name = cell('name');
    if (!name) {
      rejected.push({ line, reason: 'Name is empty.', raw });
      continue;
    }

    const categoryKey = cell('categoryKey');
    if (!categoryKey) {
      rejected.push({ line, reason: 'Category is empty.', raw });
      continue;
    }
    if (!validCategoryKeys.includes(categoryKey)) {
      rejected.push({
        line,
        reason: `Unknown category "${categoryKey}". Valid categories: ${validCategoryKeys.join(', ')}.`,
        raw,
      });
      continue;
    }

    const priceCents = parseMoneyToCents(cell('price'));
    if (priceCents === null) {
      rejected.push({ line, reason: `Price "${cell('price')}" is not a valid amount.`, raw });
      continue;
    }
    if (priceCents < 0) {
      rejected.push({ line, reason: 'Price cannot be negative.', raw });
      continue;
    }

    const servingsUnits = parseServingsToUnits(cell('servingsPerPackage'));
    if (servingsUnits === null) {
      rejected.push({
        line,
        reason: `Servings per package "${cell('servingsPerPackage')}" is not a valid number.`,
        raw,
      });
      continue;
    }
    if (servingsUnits < 0) {
      rejected.push({ line, reason: 'Servings per package cannot be negative.', raw });
      continue;
    }

    const rawTags = cell('tags');
    const tags: DietaryTag[] = [];
    let badTag: string | null = null;
    if (rawTags) {
      for (const part of rawTags.split(/[;|]/).flatMap((p) => p.split(','))) {
        const normalized = part.trim().toLowerCase().replace(/[\s-]+/g, '_');
        if (!normalized) continue;
        if ((DIETARY_TAGS as readonly string[]).includes(normalized)) {
          tags.push(normalized as DietaryTag);
        } else {
          badTag = part.trim();
          break;
        }
      }
    }
    if (badTag) {
      rejected.push({
        line,
        reason: `Unknown tag "${badTag}". Valid tags: ${DIETARY_TAGS.join(', ')}.`,
        raw,
      });
      continue;
    }

    const rawShelf = cell('shelfLifeClass').trim().toLowerCase().replace(/[\s-]+/g, '_');
    let shelfLifeClass: ShelfLifeClass = 'shelf_stable';
    if (rawShelf) {
      if (!(SHELF_LIFE_CLASSES as readonly string[]).includes(rawShelf)) {
        rejected.push({
          line,
          reason: `Unknown shelf life class "${cell('shelfLifeClass')}". Valid values: ${SHELF_LIFE_CLASSES.join(', ')}.`,
          raw,
        });
        continue;
      }
      shelfLifeClass = rawShelf as ShelfLifeClass;
    }

    const rawActive = cell('active').trim().toLowerCase();
    const active = rawActive === '' ? true : !['false', 'no', '0', 'n'].includes(rawActive);

    const sku = cell('sku');
    const upc = cell('upc');

    // Catch a file that lists the same product twice, which would otherwise
    // silently apply whichever row happened to come last.
    const dedupeKey = (sku || upc || name).toLowerCase();
    if (seenKeys.has(dedupeKey)) {
      rejected.push({ line, reason: `Duplicate of an earlier row in this file ("${dedupeKey}").`, raw });
      continue;
    }
    seenKeys.add(dedupeKey);

    // FR-7: match an existing item so an import updates rather than
    // duplicating, which would orphan the completed orders that reference it.
    const existing =
      (sku ? bySku.get(sku.toLowerCase()) : undefined) ?? (upc ? byUpc.get(upc) : undefined);

    if (existing) {
      updated++;
      items.push({
        ...existing,
        name,
        nameEs: cell('nameEs') || existing.nameEs,
        packageSize: cell('packageSize') || existing.packageSize,
        categoryKey,
        priceCents,
        servingsPerPackageUnits: servingsUnits,
        sku: sku || existing.sku,
        upc: upc || existing.upc,
        tags: rawTags ? tags : existing.tags,
        shelfLifeClass: rawShelf ? shelfLifeClass : existing.shelfLifeClass,
        active,
        updatedAt: now,
      });
    } else {
      created++;
      items.push({
        id: newId('item'),
        name,
        nameEs: cell('nameEs'),
        packageSize: cell('packageSize'),
        categoryKey,
        priceCents,
        servingsPerPackageUnits: servingsUnits,
        sku,
        upc,
        tags,
        shelfLifeClass,
        active,
        updatedAt: now,
      });
    }
  }

  return { items, created, updated, rejected, fatal: null };
}

/** FR-5: export the catalog in exactly the shape the importer accepts. */
export function exportCatalogCsv(items: readonly Item[]): string {
  const header = [
    'name',
    'nameEs',
    'packageSize',
    'categoryKey',
    'price',
    'servingsPerPackage',
    'sku',
    'upc',
    'tags',
    'shelfLifeClass',
    'active',
  ];
  const rows = items.map((item) => [
    item.name,
    item.nameEs,
    item.packageSize,
    item.categoryKey,
    centsToPlain(item.priceCents),
    String(unitsToServings(item.servingsPerPackageUnits)),
    item.sku,
    item.upc,
    item.tags.join(';'),
    item.shelfLifeClass,
    item.active ? 'true' : 'false',
  ]);
  return toCsv([header, ...rows]);
}

/** Trigger a browser download without any third-party dependency. */
export function downloadCsv(filename: string, csv: string): void {
  // The BOM makes Excel open UTF-8 correctly instead of mangling accents.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
