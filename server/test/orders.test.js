import './setup.js';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  apiClient,
  createTestUser,
  orderPayload,
  resetDatabase,
  startTestServer,
  teardown,
} from './helpers.js';
import { BARCODE_PATTERN } from '../src/lib/identifiers.js';

let server;
let admin;
let dispatcher;
let driver;
let api;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
  await teardown();
});

beforeEach(async () => {
  await resetDatabase();
  admin = await createTestUser({ role: 'admin' });
  dispatcher = await createTestUser({ role: 'dispatcher' });
  driver = await createTestUser({ role: 'driver' });
  api = apiClient(server.baseUrl, admin.token);
});

describe('auth', () => {
  it('issues a token for valid credentials', async () => {
    const user = await createTestUser({ role: 'admin', password: 'supersecret1' });
    const res = await api.post('/api/auth/login', { email: user.email, password: 'supersecret1' });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(res.body.user.email, user.email);
    assert.equal(res.body.user.passwordHash, undefined);
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const user = await createTestUser({ role: 'admin', password: 'supersecret1' });
    const wrongPassword = await api.post('/api/auth/login', { email: user.email, password: 'nope' });
    const noSuchUser = await api.post('/api/auth/login', { email: 'ghost@test.local', password: 'nope' });

    assert.equal(wrongPassword.status, 401);
    assert.equal(noSuchUser.status, 401);
    assert.equal(wrongPassword.body.error.message, noSuchUser.body.error.message);
  });

  it('refuses an inactive account', async () => {
    const user = await createTestUser({ role: 'driver', password: 'supersecret1' });
    await api.patch(`/api/auth/users/${user.id}`, { isActive: false });
    const res = await api.post('/api/auth/login', { email: user.email, password: 'supersecret1' });
    assert.equal(res.status, 401);
  });

  it('requires a token on protected routes', async () => {
    const anon = apiClient(server.baseUrl);
    assert.equal((await anon.get('/api/orders')).status, 401);
    assert.equal((await anon.get('/api/orders', { token: 'garbage' })).status, 401);
  });
});

describe('order creation', () => {
  it('creates an order with a generated barcode and tracking token', async () => {
    const res = await api.post('/api/orders', orderPayload({ orderRef: 'ORD-1' }));

    assert.equal(res.status, 201);
    const { order } = res.body;
    assert.equal(order.orderRef, 'ORD-1');
    assert.equal(order.status, 'created');
    assert.match(order.barcodeValue, BARCODE_PATTERN);
    assert.match(order.trackingToken, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(order.trackingUrl, `http://localhost:5173/track/${order.trackingToken}`);
    assert.equal(order.attemptCount, 0);
    assert.equal(order.readyAt, null);
  });

  it('gives every order a distinct barcode', async () => {
    const created = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        api.post('/api/orders', orderPayload({ orderRef: `BULK-${i}` })),
      ),
    );
    const barcodes = new Set(created.map((res) => res.body.order.barcodeValue));
    assert.equal(barcodes.size, 25);
  });

  it('records an initial status event', async () => {
    const { body } = await api.post('/api/orders', orderPayload());
    const res = await api.get(`/api/orders/${body.order.id}`);

    assert.equal(res.body.order.history.length, 1);
    assert.equal(res.body.order.history[0].fromStatus, null);
    assert.equal(res.body.order.history[0].toStatus, 'created');
    assert.equal(res.body.order.history[0].source, 'manual');
    assert.equal(res.body.order.history[0].actorId, admin.id);
  });

  it('rejects a duplicate order reference', async () => {
    await api.post('/api/orders', orderPayload({ orderRef: 'ORD-DUP' }));
    const res = await api.post('/api/orders', orderPayload({ orderRef: 'ORD-DUP' }));
    assert.equal(res.status, 409);
    assert.equal(res.body.error.details.field, 'orderRef');
  });

  it('requires a phone number or an email address', async () => {
    const res = await api.post('/api/orders', {
      orderRef: 'ORD-NOCONTACT',
      customerName: 'Dana Whitfield',
      addressLine1: '84 Alder Street',
    });
    assert.equal(res.status, 422);
    assert.match(JSON.stringify(res.body.error.details), /phone number or an email/);
  });

  it('normalises phone numbers and emails on the way in', async () => {
    const res = await api.post('/api/orders', orderPayload({
      customerPhone: '+1 (555) 123-4567',
      customerEmail: '  Dana@Example.COM ',
    }));
    assert.equal(res.body.order.customerPhone, '+15551234567');
    assert.equal(res.body.order.customerEmail, 'dana@example.com');
  });

  it('rejects unknown fields instead of silently dropping them', async () => {
    const res = await api.post('/api/orders', orderPayload({ totalPrice: 42 }));
    assert.equal(res.status, 422);
  });

  it('does not let a driver create orders', async () => {
    const driverApi = apiClient(server.baseUrl, driver.token);
    const res = await driverApi.post('/api/orders', orderPayload());
    assert.equal(res.status, 403);
  });

  it('lets a dispatcher create orders', async () => {
    const dispatcherApi = apiClient(server.baseUrl, dispatcher.token);
    assert.equal((await dispatcherApi.post('/api/orders', orderPayload())).status, 201);
  });
});

describe('order listing', () => {
  beforeEach(async () => {
    await api.post('/api/orders', orderPayload({ orderRef: 'AAA-1', customerName: 'Dana Whitfield', deliveryZone: 'NORTH' }));
    await api.post('/api/orders', orderPayload({ orderRef: 'BBB-2', customerName: 'Marcus Bell', deliveryZone: 'SOUTH' }));
    await api.post('/api/orders', orderPayload({ orderRef: 'CCC-3', customerName: 'Yuki Tanaka', deliveryZone: 'NORTH' }));
  });

  it('returns orders with pagination metadata', async () => {
    const res = await api.get('/api/orders?limit=2');
    assert.equal(res.status, 200);
    assert.equal(res.body.orders.length, 2);
    assert.equal(res.body.pagination.total, 3);
    assert.equal(res.body.pagination.hasMore, true);
  });

  it('filters by zone and status', async () => {
    const byZone = await api.get('/api/orders?zone=north');
    assert.equal(byZone.body.orders.length, 2);

    const byStatus = await api.get('/api/orders?status=created');
    assert.equal(byStatus.body.orders.length, 3);

    const delivered = await api.get('/api/orders?status=delivered');
    assert.equal(delivered.body.orders.length, 0);
  });

  it('searches across reference, customer and barcode', async () => {
    const byName = await api.get('/api/orders?q=Yuki');
    assert.equal(byName.body.orders.length, 1);
    assert.equal(byName.body.orders[0].orderRef, 'CCC-3');

    const byRef = await api.get('/api/orders?q=BBB');
    assert.equal(byRef.body.orders.length, 1);

    const { body } = await api.get('/api/orders?q=AAA-1');
    const byBarcode = await api.get(`/api/orders?q=${body.orders[0].barcodeValue}`);
    assert.equal(byBarcode.body.orders.length, 1);
  });

  it('treats a search term containing wildcards literally', async () => {
    const res = await api.get('/api/orders?q=%25');
    assert.equal(res.body.orders.length, 0);
  });

  it('rejects an unknown status filter', async () => {
    assert.equal((await api.get('/api/orders?status=not_a_status')).status, 422);
  });

  it('sorts by the requested column', async () => {
    const res = await api.get('/api/orders?sort=order_ref&direction=asc');
    assert.deepEqual(res.body.orders.map((o) => o.orderRef), ['AAA-1', 'BBB-2', 'CCC-3']);
  });

  it('scopes a driver to their own orders only', async () => {
    const driverApi = apiClient(server.baseUrl, driver.token);
    const res = await driverApi.get('/api/orders');
    assert.equal(res.status, 200);
    assert.equal(res.body.orders.length, 0);
  });
});

describe('order updates', () => {
  let order;

  beforeEach(async () => {
    const res = await api.post('/api/orders', orderPayload());
    order = res.body.order;
  });

  it('updates editable fields', async () => {
    const res = await api.patch(`/api/orders/${order.id}`, {
      customerName: 'Dana W. Whitfield',
      deliveryNotes: 'Ring the side bell',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.order.customerName, 'Dana W. Whitfield');
    assert.equal(res.body.order.deliveryNotes, 'Ring the side bell');
  });

  it('refuses to change the reference or barcode printed on the label', async () => {
    assert.equal((await api.patch(`/api/orders/${order.id}`, { orderRef: 'NEW' })).status, 422);
    assert.equal((await api.patch(`/api/orders/${order.id}`, { barcodeValue: 'DTS-AAAA-BBBB' })).status, 422);
  });

  it('returns 404 for an unknown order', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    assert.equal((await api.get(`/api/orders/${missing}`)).status, 404);
    assert.equal((await api.patch(`/api/orders/${missing}`, { city: 'Nowhere' })).status, 404);
  });

  it('returns 400 for a malformed id rather than a 500', async () => {
    assert.equal((await api.get('/api/orders/not-a-uuid')).status, 400);
  });
});

describe('status transitions', () => {
  let order;

  beforeEach(async () => {
    const res = await api.post('/api/orders', orderPayload());
    order = res.body.order;
  });

  it('starts the delivery clock when the label is activated', async () => {
    const res = await api.patch(`/api/orders/${order.id}/status`, {
      status: 'ready_for_delivery',
      notes: 'Label scanned at the depot',
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.order.status, 'ready_for_delivery');
    assert.ok(res.body.order.readyAt, 'readyAt should be set');
    assert.equal(res.body.statusEvent.fromStatus, 'created');
    assert.equal(res.body.statusEvent.toStatus, 'ready_for_delivery');
    assert.equal(res.body.statusEvent.notes, 'Label scanned at the depot');
  });

  it('refuses to skip the label activation step', async () => {
    const res = await api.patch(`/api/orders/${order.id}/status`, { status: 'out_for_delivery' });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.error.details.allowedTransitions, ['ready_for_delivery', 'cancelled']);
  });

  it('refuses a no-op transition', async () => {
    const res = await api.patch(`/api/orders/${order.id}/status`, { status: 'created' });
    assert.equal(res.status, 409);
  });

  it('refuses to move an order out of a terminal status', async () => {
    await api.patch(`/api/orders/${order.id}/status`, { status: 'cancelled' });
    const res = await api.patch(`/api/orders/${order.id}/status`, { status: 'ready_for_delivery' });
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /final status/);
  });

  it('requires a driver before moving to assigned', async () => {
    await api.patch(`/api/orders/${order.id}/status`, { status: 'ready_for_delivery' });
    const res = await api.patch(`/api/orders/${order.id}/status`, { status: 'assigned' });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /Assign a driver/);
  });

  it('appends every transition to the history in order', async () => {
    await api.patch(`/api/orders/${order.id}/status`, { status: 'ready_for_delivery' });
    await api.patch(`/api/orders/${order.id}/status`, { status: 'cancelled' });

    const res = await api.get(`/api/orders/${order.id}`);
    assert.deepEqual(
      res.body.order.history.map((e) => e.toStatus),
      ['created', 'ready_for_delivery', 'cancelled'],
    );
    assert.equal(res.body.order.history[2].actorName, admin.fullName);
  });

  it('does not let a driver change status through the staff endpoint', async () => {
    const driverApi = apiClient(server.baseUrl, driver.token);
    const res = await driverApi.patch(`/api/orders/${order.id}/status`, { status: 'ready_for_delivery' });
    assert.equal(res.status, 403);
  });
});

describe('order deletion', () => {
  it('deletes an order that has never been scanned', async () => {
    const { body } = await api.post('/api/orders', orderPayload());
    assert.equal((await api.del(`/api/orders/${body.order.id}`)).status, 200);
    assert.equal((await api.get(`/api/orders/${body.order.id}`)).status, 404);
  });

  it('refuses to delete an order once tracking has started', async () => {
    const { body } = await api.post('/api/orders', orderPayload());
    await api.patch(`/api/orders/${body.order.id}/status`, { status: 'ready_for_delivery' });

    const res = await api.del(`/api/orders/${body.order.id}`);
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /cancel it instead/);
  });

  it('only allows admins to delete', async () => {
    const { body } = await api.post('/api/orders', orderPayload());
    const dispatcherApi = apiClient(server.baseUrl, dispatcher.token);
    assert.equal((await dispatcherApi.del(`/api/orders/${body.order.id}`)).status, 403);
  });
});

describe('labels and barcodes', () => {
  let order;

  beforeEach(async () => {
    const res = await api.post('/api/orders', orderPayload({ customerName: 'Dana <script> Whitfield' }));
    order = res.body.order;
  });

  it('renders a printable label containing the order details', async () => {
    const res = await api.get(`/api/orders/${order.id}/label`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.body, /data:image\/png;base64,/);
    assert.ok(res.body.includes(order.orderRef));
    assert.ok(res.body.includes(order.trackingToken));
  });

  it('escapes customer-supplied text in the label', async () => {
    const res = await api.get(`/api/orders/${order.id}/label`);
    assert.ok(!res.body.includes('<script>'));
    assert.ok(res.body.includes('&lt;script&gt;'));
  });

  it('serves barcode and qr images', async () => {
    for (const path of ['barcode.png', 'qr.png']) {
      const { status, response } = await api.get(`/api/orders/${order.id}/${path}`, { raw: true });
      assert.equal(status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    }
  });

  it('serves svg variants', async () => {
    const res = await api.get(`/api/orders/${order.id}/barcode.svg`);
    assert.equal(res.status, 200);
    assert.match(res.body, /<svg/);
  });

  it('can encode the customer tracking url instead of the barcode value', async () => {
    const res = await api.get(`/api/orders/${order.id}/qr.svg?content=tracking`);
    assert.equal(res.status, 200);
    assert.match(res.body, /<svg/);
  });
});

describe('csv import', () => {
  function csvUpload(content, filename = 'orders.csv') {
    const form = new FormData();
    form.set('file', new Blob([content], { type: 'text/csv' }), filename);
    return form;
  }

  it('creates orders from a valid csv', async () => {
    const csv = [
      'order_ref,customer_name,phone,address,city,zone',
      'CSV-1,Dana Whitfield,+15551234567,84 Alder Street,Springfield,NORTH',
      'CSV-2,Marcus Bell,+15551234568,19 Kestrel Lane,Springfield,SOUTH',
    ].join('\n');

    const res = await api.post('/api/orders/import', csvUpload(csv));
    assert.equal(res.status, 201);
    assert.equal(res.body.createdCount, 2);
    assert.equal(res.body.failedCount, 0);
    assert.equal(res.body.batch.createdCount, 2);

    const barcodes = new Set(res.body.orders.map((o) => o.barcodeValue));
    assert.equal(barcodes.size, 2);

    const list = await api.get('/api/orders');
    assert.equal(list.body.pagination.total, 2);
  });

  it('imports the good rows and reports the bad ones', async () => {
    const csv = [
      'order_ref,customer_name,phone,address',
      'CSV-1,Dana Whitfield,+15551234567,84 Alder Street',
      'CSV-2,,+15551234568,19 Kestrel Lane',
      'CSV-3,Yuki Tanaka,+15551234569,450 Copper Row',
    ].join('\n');

    const res = await api.post('/api/orders/import', csvUpload(csv));
    assert.equal(res.status, 207, 'partial success should be a 207');
    assert.equal(res.body.createdCount, 2);
    assert.equal(res.body.failedCount, 1);
    assert.equal(res.body.errors[0].rowNumber, 3);

    const list = await api.get('/api/orders');
    assert.equal(list.body.pagination.total, 2);
  });

  it('reports rows that collide with an existing order', async () => {
    await api.post('/api/orders', orderPayload({ orderRef: 'CSV-1' }));

    const csv = [
      'order_ref,customer_name,phone,address',
      'CSV-1,Dana Whitfield,+15551234567,84 Alder Street',
      'CSV-2,Marcus Bell,+15551234568,19 Kestrel Lane',
    ].join('\n');

    const res = await api.post('/api/orders/import', csvUpload(csv));
    assert.equal(res.status, 207);
    assert.equal(res.body.createdCount, 1);
    assert.equal(res.body.errors[0].field, 'orderRef');
    assert.match(res.body.errors[0].message, /already exists/);

    // The successful row must survive the failed one.
    const list = await api.get('/api/orders?q=CSV-2');
    assert.equal(list.body.orders.length, 1);
  });

  it('records the import batch for later review', async () => {
    const csv = 'order_ref,customer_name,phone,address\nCSV-1,Dana,+15551234567,84 Alder Street';
    const res = await api.post('/api/orders/import', csvUpload(csv));

    const batch = await api.get(`/api/orders/import/batches/${res.body.batch.id}`);
    assert.equal(batch.status, 200);
    assert.equal(batch.body.batch.filename, 'orders.csv');
    assert.equal(batch.body.batch.createdCount, 1);
    assert.equal(batch.body.batch.uploadedByName, admin.fullName);
  });

  it('rejects a csv missing required columns', async () => {
    const res = await api.post('/api/orders/import', csvUpload('name,phone\nDana,+15551234567'));
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /missing required column/);
  });

  it('rejects a non-csv upload', async () => {
    const form = new FormData();
    form.set('file', new Blob(['not a csv'], { type: 'image/png' }), 'photo.png');
    const res = await api.post('/api/orders/import', form);
    assert.equal(res.status, 400);
  });

  it('serves a template with the expected headers', async () => {
    const res = await api.get('/api/orders/import/template');
    assert.equal(res.status, 200);
    assert.match(res.body, /^order_ref,customer_name/);
  });

  it('does not let a driver import orders', async () => {
    const driverApi = apiClient(server.baseUrl, driver.token);
    const csv = 'order_ref,customer_name,phone,address\nCSV-1,Dana,+15551234567,84 Alder Street';
    assert.equal((await driverApi.post('/api/orders/import', csvUpload(csv))).status, 403);
  });
});
