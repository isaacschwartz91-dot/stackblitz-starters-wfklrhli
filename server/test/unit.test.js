import './setup.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseOrdersCsv, mapHeaders, normaliseHeader } from '../src/lib/csvImport.js';
import {
  BARCODE_PATTERN,
  generateBarcodeValue,
  generateTrackingToken,
  normaliseBarcodeValue,
  trackingUrl,
} from '../src/lib/identifiers.js';
import {
  assertTransitionAllowed,
  canTransition,
  OPEN_STATUSES,
  TERMINAL_STATUSES,
} from '../src/lib/statusMachine.js';
import { escapeHtml, renderBarcodePng, renderBarcodeSvg, renderQrPng } from '../src/lib/labels.js';
import { normalisePhone } from '../src/schemas/orders.js';

describe('barcode values', () => {
  it('generates values matching the documented pattern', () => {
    for (let i = 0; i < 200; i += 1) {
      assert.match(generateBarcodeValue(), BARCODE_PATTERN);
    }
  });

  it('never emits characters that are easy to misread', () => {
    const forbidden = /[01ILOU]/;
    for (let i = 0; i < 200; i += 1) {
      const body = generateBarcodeValue().slice(4); // strip the DTS- prefix
      assert.ok(!forbidden.test(body), `unexpected character in ${body}`);
    }
  });

  it('generates distinct values', () => {
    const values = new Set(Array.from({ length: 1000 }, generateBarcodeValue));
    assert.equal(values.size, 1000);
  });

  it('normalises scanner and hand-typed input', () => {
    const value = generateBarcodeValue();
    assert.equal(normaliseBarcodeValue(`  ${value}\n`), value);
    assert.equal(normaliseBarcodeValue(value.toLowerCase()), value);
    assert.equal(normaliseBarcodeValue(value.replace(/-/g, '')), value);
    assert.equal(normaliseBarcodeValue(value.replace(/-/g, ' ')), value);
  });

  it('leaves unrecognised input alone rather than inventing a code', () => {
    assert.equal(normaliseBarcodeValue('not-a-code'), 'NOT-A-CODE');
    assert.equal(normaliseBarcodeValue(undefined), '');
  });
});

describe('tracking tokens', () => {
  it('are long, url-safe and unique', () => {
    const tokens = new Set();
    for (let i = 0; i < 500; i += 1) {
      const token = generateTrackingToken();
      assert.match(token, /^[A-Za-z0-9_-]{24}$/);
      tokens.add(token);
    }
    assert.equal(tokens.size, 500);
  });

  it('builds a tracking url without doubling slashes', () => {
    assert.equal(trackingUrl('https://track.example.com/', 'abc'), 'https://track.example.com/track/abc');
  });
});

describe('status machine', () => {
  it('only starts tracking via ready_for_delivery', () => {
    assert.ok(canTransition('created', 'ready_for_delivery'));
    assert.ok(!canTransition('created', 'out_for_delivery'));
    assert.ok(!canTransition('created', 'delivered'));
  });

  it('treats delivered and cancelled as terminal', () => {
    assert.deepEqual([...TERMINAL_STATUSES].sort(), ['cancelled', 'delivered']);
    assert.ok(!OPEN_STATUSES.includes('delivered'));
  });

  it('allows a failed attempt to be redelivered', () => {
    assert.ok(canTransition('out_for_delivery', 'failed_attempt'));
    assert.ok(canTransition('failed_attempt', 'assigned'));
    assert.ok(canTransition('failed_attempt', 'ready_for_delivery'));
  });

  it('rejects transitions out of a terminal status with a 409', () => {
    assert.throws(
      () => assertTransitionAllowed('delivered', 'out_for_delivery'),
      (err) => err.status === 409 && /final status/.test(err.message),
    );
  });

  it('rejects a no-op transition', () => {
    assert.throws(
      () => assertTransitionAllowed('assigned', 'assigned'),
      (err) => err.status === 409,
    );
  });

  it('rejects an unknown status with a 400', () => {
    assert.throws(
      () => assertTransitionAllowed('created', 'teleported'),
      (err) => err.status === 400,
    );
  });
});

describe('phone normalisation', () => {
  it('canonicalises the shapes people actually type', () => {
    assert.equal(normalisePhone('+1 (555) 123-4567'), '+15551234567');
    assert.equal(normalisePhone('555.123.4567'), '5551234567');
    assert.equal(normalisePhone('  '), undefined);
  });

  it('flags numbers that are too short or too long', () => {
    assert.equal(normalisePhone('12345'), null);
    assert.equal(normalisePhone('1234567890123456789'), null);
  });
});

describe('csv import', () => {
  it('accepts header aliases and odd casing', () => {
    assert.equal(normaliseHeader('  Customer Name '), 'customer_name');
    const { mapping } = mapHeaders(['Order ID', 'Recipient', 'Street', 'Zip']);
    assert.equal(mapping.orderRef, 'Order ID');
    assert.equal(mapping.customerName, 'Recipient');
    assert.equal(mapping.addressLine1, 'Street');
    assert.equal(mapping.postalCode, 'Zip');
  });

  it('parses valid rows and normalises values', () => {
    const csv = [
      'order_ref,customer_name,phone,address,city,zone',
      'ORD-1,Dana Whitfield,+1 (555) 123-4567,84 Alder Street,Springfield,NORTH',
      'ORD-2,Marcus Bell,5551234568,19 Kestrel Lane,Springfield,SOUTH',
    ].join('\n');

    const { rows, errors } = parseOrdersCsv(csv);
    assert.equal(errors.length, 0);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].data.customerPhone, '+15551234567');
    assert.equal(rows[0].rowNumber, 2);
    assert.equal(rows[1].data.deliveryZone, 'SOUTH');
  });

  it('reports per-row errors without discarding the good rows', () => {
    const csv = [
      'order_ref,customer_name,phone,address',
      'ORD-1,Dana Whitfield,+15551234567,84 Alder Street',
      'ORD-2,,+15551234568,19 Kestrel Lane',
      'ORD-3,Yuki Tanaka,,450 Copper Row',
    ].join('\n');

    const { rows, errors } = parseOrdersCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].data.orderRef, 'ORD-1');

    const rowNumbers = errors.map((e) => e.rowNumber).sort();
    assert.deepEqual(rowNumbers, [3, 4]);
    // Row 4 has no phone and no email, so it cannot be notified.
    assert.ok(errors.some((e) => e.rowNumber === 4 && /phone number or an email/.test(e.message)));
  });

  it('catches duplicate references inside one file', () => {
    const csv = [
      'order_ref,customer_name,phone,address',
      'ORD-1,Dana Whitfield,+15551234567,84 Alder Street',
      'ord-1,Someone Else,+15551234568,19 Kestrel Lane',
    ].join('\n');

    const { rows, errors } = parseOrdersCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Duplicate order reference/);
  });

  it('ignores blank rows', () => {
    const csv = [
      'order_ref,customer_name,phone,address',
      'ORD-1,Dana Whitfield,+15551234567,84 Alder Street',
      ',,,',
    ].join('\n');
    const { rows, errors } = parseOrdersCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(errors.length, 0);
  });

  it('rejects a file missing required columns', () => {
    assert.throws(
      () => parseOrdersCsv('customer_name,phone\nDana,+15551234567'),
      (err) => err.status === 400 && /missing required column/.test(err.message),
    );
  });

  it('rejects an empty file', () => {
    assert.throws(() => parseOrdersCsv('   '), (err) => err.status === 400);
  });

  it('enforces the row limit', () => {
    const rows = Array.from({ length: 5 }, (_, i) => `ORD-${i},Name,+15551234567,Street`);
    assert.throws(
      () => parseOrdersCsv(['order_ref,customer_name,phone,address', ...rows].join('\n'), { maxRows: 3 }),
      (err) => err.status === 400 && /exceeds the 3-row limit/.test(err.message),
    );
  });
});

describe('label rendering', () => {
  it('renders a Code 128 PNG', async () => {
    const png = await renderBarcodePng('DTS-AB23-CD45');
    // PNG magic number.
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.ok(png.length > 200);
  });

  it('renders a Code 128 SVG containing the value', async () => {
    const svg = await renderBarcodeSvg('DTS-AB23-CD45');
    assert.match(svg, /<svg/);
  });

  it('renders a QR PNG', async () => {
    const png = await renderQrPng('DTS-AB23-CD45');
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  it('rejects an empty value instead of rendering a blank label', async () => {
    await assert.rejects(() => renderBarcodePng(''), (err) => err.status === 400);
  });

  it('escapes html so a customer name cannot inject markup into a label', () => {
    assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(escapeHtml(null), '');
  });
});
