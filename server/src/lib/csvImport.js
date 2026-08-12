/**
 * CSV order import.
 *
 * Parses a staff-uploaded CSV into validated order payloads. Rows are validated
 * individually so one bad row reports its own error instead of failing the
 * upload — a 400-row file with three typos should still create 397 orders.
 */
import { parse } from 'csv-parse/sync';

import { badRequest } from './errors.js';
import { createOrderSchema } from '../schemas/orders.js';

/**
 * Header aliases. Staff export from a dozen different systems, so accept the
 * common spellings rather than demanding an exact template.
 */
const HEADER_ALIASES = {
  orderRef: ['order_ref', 'order_id', 'order', 'order_number', 'reference', 'ref'],
  customerName: ['customer_name', 'customer', 'name', 'recipient', 'recipient_name'],
  customerPhone: ['customer_phone', 'phone', 'phone_number', 'mobile', 'telephone', 'tel'],
  customerEmail: ['customer_email', 'email', 'email_address'],
  addressLine1: ['address_line1', 'address1', 'address', 'street', 'address_1', 'street_address'],
  addressLine2: ['address_line2', 'address2', 'address_2', 'unit', 'apartment', 'apt'],
  city: ['city', 'town', 'suburb', 'locality'],
  region: ['region', 'state', 'province', 'county'],
  postalCode: ['postal_code', 'postcode', 'zip', 'zip_code', 'zipcode'],
  country: ['country', 'country_code'],
  deliveryZone: ['delivery_zone', 'zone', 'route', 'area'],
  deliveryNotes: ['delivery_notes', 'notes', 'note', 'instructions', 'delivery_instructions'],
};

const FIELD_BY_ALIAS = new Map();
for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
  for (const alias of aliases) FIELD_BY_ALIAS.set(alias, field);
}

/** "Customer Name", "customer-name", "CUSTOMER_NAME" all normalise the same. */
export function normaliseHeader(header) {
  return String(header ?? '')
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

export function mapHeaders(headers) {
  const mapping = {};
  const unknown = [];
  for (const header of headers) {
    const key = normaliseHeader(header);
    const field = FIELD_BY_ALIAS.get(key);
    if (field && !(field in mapping)) {
      mapping[field] = header;
    } else if (!field) {
      unknown.push(header);
    }
  }
  return { mapping, unknown };
}

export const REQUIRED_FIELDS = ['orderRef', 'customerName', 'addressLine1'];

export const CSV_TEMPLATE_HEADERS = [
  'order_ref',
  'customer_name',
  'customer_phone',
  'customer_email',
  'address_line1',
  'address_line2',
  'city',
  'region',
  'postal_code',
  'country',
  'delivery_zone',
  'delivery_notes',
];

/**
 * @returns {{rows: Array<{rowNumber:number,data:object}>, errors: Array<{rowNumber:number,message:string,field?:string}>, mapping: object, unknownHeaders: string[]}}
 */
export function parseOrdersCsv(content, { maxRows = 5000 } = {}) {
  const text = typeof content === 'string' ? content : content.toString('utf8');
  if (text.trim() === '') throw badRequest('The uploaded CSV is empty');

  let records;
  try {
    records = parse(text, {
      columns: false,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
    });
  } catch (err) {
    throw badRequest(`Could not parse CSV: ${err.message}`);
  }

  if (records.length === 0) throw badRequest('The uploaded CSV is empty');

  const [headerRow, ...dataRows] = records;
  const { mapping, unknown } = mapHeaders(headerRow);

  const missing = REQUIRED_FIELDS.filter((field) => !(field in mapping));
  if (missing.length > 0) {
    throw badRequest(
      `CSV is missing required column(s): ${missing.join(', ')}`,
      { required: REQUIRED_FIELDS, template: CSV_TEMPLATE_HEADERS, foundHeaders: headerRow },
    );
  }

  if (dataRows.length > maxRows) {
    throw badRequest(
      `CSV contains ${dataRows.length} rows, which exceeds the ${maxRows}-row limit. Split the file and upload again.`,
    );
  }

  // Column index per mapped field, resolved once.
  const indexByField = {};
  for (const [field, header] of Object.entries(mapping)) {
    indexByField[field] = headerRow.indexOf(header);
  }

  const rows = [];
  const errors = [];
  const seenRefs = new Map();

  dataRows.forEach((columns, index) => {
    const rowNumber = index + 2; // 1-based, and row 1 is the header.

    // Skip rows that are entirely blank rather than reporting 3 errors for them.
    if (columns.every((cell) => String(cell ?? '').trim() === '')) return;

    const raw = {};
    for (const [field, columnIndex] of Object.entries(indexByField)) {
      const value = columns[columnIndex];
      if (value !== undefined && String(value).trim() !== '') raw[field] = String(value);
    }

    const parsed = createOrderSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({
          rowNumber,
          field: issue.path[0] ? String(issue.path[0]) : undefined,
          message: issue.message,
        });
      }
      return;
    }

    // Catch duplicates inside the file itself; the DB unique index catches
    // duplicates against orders that already exist.
    const refKey = parsed.data.orderRef.toLowerCase();
    if (seenRefs.has(refKey)) {
      errors.push({
        rowNumber,
        field: 'orderRef',
        message: `Duplicate order reference "${parsed.data.orderRef}" (also on row ${seenRefs.get(refKey)})`,
      });
      return;
    }
    seenRefs.set(refKey, rowNumber);

    rows.push({ rowNumber, data: parsed.data });
  });

  return { rows, errors, mapping, unknownHeaders: unknown };
}

export function buildCsvTemplate() {
  const example = [
    'ORD-1001',
    'Dana Whitfield',
    '+15551234567',
    'dana@example.com',
    '84 Alder Street',
    'Apt 3B',
    'Springfield',
    'IL',
    '62704',
    'US',
    'NORTH',
    'Leave with the doorman',
  ];
  return `${CSV_TEMPLATE_HEADERS.join(',')}\n${example.map((v) => (v.includes(',') ? `"${v}"` : v)).join(',')}\n`;
}
