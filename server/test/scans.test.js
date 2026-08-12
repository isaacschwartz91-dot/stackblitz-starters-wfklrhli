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

let server;
let admin;
let dispatcher;
let driver;
let otherDriver;
let api;
let dispatcherApi;
let driverApi;

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
  otherDriver = await createTestUser({ role: 'driver' });
  api = apiClient(server.baseUrl, admin.token);
  dispatcherApi = apiClient(server.baseUrl, dispatcher.token);
  driverApi = apiClient(server.baseUrl, driver.token);
});

async function newOrder(overrides) {
  const res = await api.post('/api/orders', orderPayload(overrides));
  return res.body.order;
}

async function assign(orderId, driverId) {
  return api.post(`/api/orders/${orderId}/assign`, { driverId });
}

/** Walks an order to the given status using the scan API. */
async function activate(order) {
  return dispatcherApi.post('/api/scans', {
    barcodeValue: order.barcodeValue,
    scanType: 'label_activation',
  });
}

describe('label activation scan', () => {
  it('starts tracking and stamps readyAt', async () => {
    const order = await newOrder();
    const res = await activate(order);

    assert.equal(res.status, 201);
    assert.equal(res.body.order.status, 'ready_for_delivery');
    assert.ok(res.body.order.readyAt);
    assert.equal(res.body.scanEvent.accepted, true);
    assert.equal(res.body.scanEvent.scanType, 'label_activation');
    assert.equal(res.body.statusEvent.source, 'scan');
    assert.equal(res.body.statusEvent.scanEventId, res.body.scanEvent.id);
  });

  it('accepts a scan that arrives with whitespace or in lower case', async () => {
    const order = await newOrder();
    const res = await dispatcherApi.post('/api/scans', {
      barcodeValue: `  ${order.barcodeValue.toLowerCase()}\n`,
      scanType: 'label_activation',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.order.status, 'ready_for_delivery');
  });

  it('accepts a hand-typed code with the hyphens left out', async () => {
    const order = await newOrder();
    const res = await dispatcherApi.post('/api/scans', {
      barcodeValue: order.barcodeValue.replace(/-/g, ''),
      scanType: 'label_activation',
    });
    assert.equal(res.status, 201);
  });

  it('rejects an unknown barcode and records the attempt', async () => {
    const res = await dispatcherApi.post('/api/scans', {
      barcodeValue: 'DTS-ZZZZ-ZZZZ',
      scanType: 'label_activation',
    });

    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'unknown_barcode');

    const recent = await api.get('/api/scans/recent');
    assert.equal(recent.body.scans.length, 1);
    assert.equal(recent.body.scans[0].accepted, false);
    assert.equal(recent.body.scans[0].rejectionReason, 'unknown_barcode');
    assert.equal(recent.body.scans[0].orderId, null);
    assert.equal(recent.body.scans[0].scannedValue, 'DTS-ZZZZ-ZZZZ');
  });

  it('rejects a second activation scan of the same label', async () => {
    const order = await newOrder();
    await activate(order);
    const res = await activate(order);

    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /already ready_for_delivery/);

    const scans = await api.get(`/api/orders/${order.id}/scans`);
    assert.equal(scans.body.scans.length, 2);
    assert.equal(scans.body.scans[1].accepted, false);
    assert.match(scans.body.scans[1].rejectionReason, /invalid_transition/);
  });

  it('does not let a driver activate a label', async () => {
    const order = await newOrder();
    const res = await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'label_activation',
    });
    assert.equal(res.status, 403);

    const scans = await api.get(`/api/orders/${order.id}/scans`);
    assert.equal(scans.body.scans[0].rejectionReason, 'role_not_permitted');
  });

  it('stores scan geolocation and device when supplied', async () => {
    const order = await newOrder();
    await dispatcherApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'label_activation',
      latitude: 39.7817,
      longitude: -89.6501,
      deviceLabel: 'Depot iPad',
    });

    const scans = await api.get(`/api/orders/${order.id}/scans`);
    assert.equal(scans.body.scans[0].latitude, 39.7817);
    assert.equal(scans.body.scans[0].longitude, -89.6501);
    assert.equal(scans.body.scans[0].deviceLabel, 'Depot iPad');
  });
});

describe('pickup scan', () => {
  it('moves an assigned order out for delivery', async () => {
    const order = await newOrder();
    await activate(order);
    await assign(order.id, driver.id);

    const res = await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'pickup',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.order.status, 'out_for_delivery');
    assert.ok(res.body.order.pickedUpAt);
  });

  it('lets an unassigned parcel be self-assigned at pickup', async () => {
    const order = await newOrder();
    await activate(order);

    const res = await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'pickup',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.order.status, 'out_for_delivery');
    assert.equal(res.body.order.assignedDriverId, driver.id);

    // The implicit 'assigned' hop must appear in the history, not be skipped.
    const detail = await api.get(`/api/orders/${order.id}`);
    assert.deepEqual(
      detail.body.order.history.map((e) => e.toStatus),
      ['created', 'ready_for_delivery', 'assigned', 'out_for_delivery'],
    );
  });

  it('refuses a parcel assigned to a different driver', async () => {
    const order = await newOrder();
    await activate(order);
    await assign(order.id, otherDriver.id);

    const res = await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'pickup',
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'assigned_to_another_driver');

    const scans = await api.get(`/api/orders/${order.id}/scans`);
    assert.equal(scans.body.scans.at(-1).rejectionReason, 'assigned_to_another_driver');
  });

  it('refuses a pickup before the label has been activated', async () => {
    const order = await newOrder();
    const res = await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'pickup',
    });
    assert.equal(res.status, 409);
  });

  it('refuses a duplicate pickup scan', async () => {
    const order = await newOrder();
    await activate(order);
    await assign(order.id, driver.id);
    await driverApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });

    const res = await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'pickup',
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /already out_for_delivery/);
  });
});

describe('drop-off scan', () => {
  async function outForDelivery() {
    const order = await newOrder();
    await activate(order);
    await assign(order.id, driver.id);
    await driverApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });
    return order;
  }

  it('completes the delivery and stamps deliveredAt', async () => {
    const order = await outForDelivery();
    const res = await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'dropoff',
      outcome: 'delivered',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.order.status, 'delivered');
    assert.ok(res.body.order.deliveredAt);
    assert.equal(res.body.order.attemptCount, 1);
  });

  it('records a failed attempt with its reason', async () => {
    const order = await outForDelivery();
    const res = await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'dropoff',
      outcome: 'failed',
      failureReason: 'Nobody home',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.order.status, 'failed_attempt');
    assert.equal(res.body.order.attemptCount, 1);
    assert.equal(res.body.order.deliveredAt, null);
    assert.equal(res.body.statusEvent.notes, 'Nobody home');
  });

  it('requires a reason for a failed attempt', async () => {
    const order = await outForDelivery();
    const res = await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'dropoff',
      outcome: 'failed',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /needs a reason/);
  });

  it('supports redelivery after a failed attempt', async () => {
    const order = await outForDelivery();
    await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'dropoff',
      outcome: 'failed',
      failureReason: 'Nobody home',
    });

    // Dispatcher re-queues it to the same driver, who delivers on attempt two.
    await assign(order.id, driver.id);
    await driverApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });
    const res = await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'dropoff',
      outcome: 'delivered',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.order.status, 'delivered');
    assert.equal(res.body.order.attemptCount, 2);
  });

  it('keeps the original readyAt across a redelivery so the clock is honest', async () => {
    const order = await outForDelivery();
    const before = await api.get(`/api/orders/${order.id}`);
    const originalReadyAt = before.body.order.readyAt;

    await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'dropoff',
      outcome: 'failed',
      failureReason: 'Nobody home',
    });
    await assign(order.id, driver.id);

    const after = await api.get(`/api/orders/${order.id}`);
    assert.equal(after.body.order.readyAt, originalReadyAt);
  });

  it('refuses a drop-off before pickup', async () => {
    const order = await newOrder();
    await activate(order);
    await assign(order.id, driver.id);

    const res = await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'dropoff',
      outcome: 'delivered',
    });
    assert.equal(res.status, 409);
  });

  it('refuses to touch an order that is already delivered', async () => {
    const order = await outForDelivery();
    await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue, scanType: 'dropoff', outcome: 'delivered',
    });
    const res = await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue, scanType: 'dropoff', outcome: 'delivered',
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /already delivered/);
  });
});

describe('scan lookup', () => {
  it('previews the order and the next action without changing anything', async () => {
    const order = await newOrder();
    const res = await dispatcherApi.get(`/api/scans/lookup?value=${order.barcodeValue}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.order.orderRef, order.orderRef);
    assert.equal(res.body.suggestedScan.scanType, 'label_activation');

    // Nothing was written.
    const detail = await api.get(`/api/orders/${order.id}`);
    assert.equal(detail.body.order.status, 'created');
    const scans = await api.get(`/api/orders/${order.id}/scans`);
    assert.equal(scans.body.scans.length, 0);
  });

  it('suggests the drop-off scan once a parcel is out for delivery', async () => {
    const order = await newOrder();
    await activate(order);
    await assign(order.id, driver.id);
    await driverApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });

    const res = await driverApi.get(`/api/scans/lookup?value=${order.barcodeValue}`);
    assert.equal(res.body.suggestedScan.scanType, 'dropoff');
  });

  it('hides a parcel belonging to another driver', async () => {
    const order = await newOrder();
    await activate(order);
    await assign(order.id, otherDriver.id);

    const res = await driverApi.get(`/api/scans/lookup?value=${order.barcodeValue}`);
    assert.equal(res.status, 403);
  });

  it('404s on an unknown code', async () => {
    const res = await dispatcherApi.get('/api/scans/lookup?value=DTS-ZZZZ-ZZZZ');
    assert.equal(res.status, 404);
  });
});

describe('scan audit trail', () => {
  it('keeps accepted and rejected scans for an order in order', async () => {
    const order = await newOrder();
    await activate(order);
    await activate(order); // rejected duplicate
    await assign(order.id, driver.id);
    await driverApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });

    const res = await api.get(`/api/orders/${order.id}/scans`);
    assert.deepEqual(
      res.body.scans.map((s) => [s.scanType, s.accepted]),
      [['label_activation', true], ['label_activation', false], ['pickup', true]],
    );
  });

  it('does not expose the scan feed to drivers', async () => {
    assert.equal((await driverApi.get('/api/scans/recent')).status, 403);
  });
});
