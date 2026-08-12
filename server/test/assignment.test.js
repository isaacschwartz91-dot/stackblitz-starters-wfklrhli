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
let driverA;
let driverB;
let api;
let dispatcherApi;
let driverAApi;

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
  driverA = await createTestUser({ role: 'driver', fullName: 'Sam Okafor' });
  driverB = await createTestUser({ role: 'driver', fullName: 'Priya Raman' });
  api = apiClient(server.baseUrl, admin.token);
  dispatcherApi = apiClient(server.baseUrl, dispatcher.token);
  driverAApi = apiClient(server.baseUrl, driverA.token);
});

/** Creates an order and scans its label so it is ready to assign. */
async function readyOrder(overrides) {
  const { body } = await api.post('/api/orders', orderPayload(overrides));
  await api.post('/api/scans', {
    barcodeValue: body.order.barcodeValue,
    scanType: 'label_activation',
  });
  return body.order;
}

describe('manual assignment', () => {
  it('assigns a ready order to a driver', async () => {
    const order = await readyOrder();
    const res = await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: driverA.id });

    assert.equal(res.status, 200);
    assert.equal(res.body.order.status, 'assigned');
    assert.equal(res.body.order.assignedDriverId, driverA.id);
    assert.equal(res.body.order.assignedDriverName, 'Sam Okafor');
    assert.ok(res.body.order.assignedAt);
  });

  it('records the assignment in the order history', async () => {
    const order = await readyOrder();
    await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: driverA.id });

    const detail = await api.get(`/api/orders/${order.id}`);
    assert.deepEqual(
      detail.body.order.history.map((e) => e.toStatus),
      ['created', 'ready_for_delivery', 'assigned'],
    );

    const audit = await api.get(`/api/orders/${order.id}/assignments`);
    assert.equal(audit.body.assignments.length, 1);
    assert.equal(audit.body.assignments[0].toDriverName, 'Sam Okafor');
    assert.equal(audit.body.assignments[0].assignedByName, dispatcher.fullName);
    assert.equal(audit.body.assignments[0].method, 'manual');
  });

  it('reassigns to a different driver without changing the status', async () => {
    const order = await readyOrder();
    await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: driverA.id });
    const res = await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: driverB.id });

    assert.equal(res.status, 200);
    assert.equal(res.body.order.status, 'assigned');
    assert.equal(res.body.order.assignedDriverId, driverB.id);

    const audit = await api.get(`/api/orders/${order.id}/assignments`);
    assert.equal(audit.body.assignments.length, 2);
    assert.equal(audit.body.assignments[1].fromDriverName, 'Sam Okafor');
    assert.equal(audit.body.assignments[1].toDriverName, 'Priya Raman');

    // The lifecycle stage did not change, so no extra status row.
    const detail = await api.get(`/api/orders/${order.id}`);
    assert.equal(detail.body.order.history.filter((e) => e.toStatus === 'assigned').length, 1);
  });

  it('returns an order to the queue when unassigned', async () => {
    const order = await readyOrder();
    await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: driverA.id });
    const res = await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: null });

    assert.equal(res.status, 200);
    assert.equal(res.body.order.status, 'ready_for_delivery');
    assert.equal(res.body.order.assignedDriverId, null);
    assert.equal(res.body.order.assignedAt, null);
  });

  it('refuses to assign an order whose label was never scanned', async () => {
    const { body } = await api.post('/api/orders', orderPayload());
    const res = await dispatcherApi.post(`/api/orders/${body.order.id}/assign`, { driverId: driverA.id });

    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /Scan the label before assigning/);
  });

  it('refuses a no-op reassignment to the same driver', async () => {
    const order = await readyOrder();
    await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: driverA.id });
    const res = await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: driverA.id });

    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /already assigned to Sam Okafor/);
  });

  it('refuses to assign work to someone who is not a driver', async () => {
    const order = await readyOrder();
    const res = await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: dispatcher.id });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /is not a driver/);
  });

  it('refuses to assign work to a deactivated driver', async () => {
    const order = await readyOrder();
    await api.patch(`/api/auth/users/${driverA.id}`, { isActive: false });
    const res = await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: driverA.id });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /inactive/);
  });

  it('does not let a driver assign work to themselves through the api', async () => {
    const order = await readyOrder();
    const res = await driverAApi.post(`/api/orders/${order.id}/assign`, { driverId: driverA.id });
    assert.equal(res.status, 403);
  });

  it('re-queues a failed attempt to the same driver', async () => {
    const order = await readyOrder();
    await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: driverA.id });
    await driverAApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });
    await driverAApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'dropoff',
      outcome: 'failed',
      failureReason: 'Nobody home',
    });

    const res = await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: driverA.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.order.status, 'assigned');
  });
});

describe('auto-batch by zone', () => {
  beforeEach(async () => {
    for (let i = 0; i < 4; i += 1) await readyOrder({ orderRef: `N-${i}`, deliveryZone: 'NORTH' });
    for (let i = 0; i < 2; i += 1) await readyOrder({ orderRef: `S-${i}`, deliveryZone: 'SOUTH' });
  });

  it('assigns every waiting order in a zone to one driver', async () => {
    const res = await dispatcherApi.post('/api/queues/auto-batch', {
      zone: 'NORTH',
      driverIds: [driverA.id],
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.assignedCount, 4);
    assert.equal(res.body.perDriver[0].count, 4);
    assert.ok(res.body.orders.every((o) => o.assignedDriverId === driverA.id));

    // The other zone is untouched.
    const south = await api.get('/api/orders?zone=SOUTH&status=ready_for_delivery');
    assert.equal(south.body.orders.length, 2);
  });

  it('splits a zone evenly across several drivers', async () => {
    const res = await dispatcherApi.post('/api/queues/auto-batch', {
      zone: 'NORTH',
      driverIds: [driverA.id, driverB.id],
    });

    assert.equal(res.body.assignedCount, 4);
    assert.deepEqual(res.body.perDriver.map((d) => d.count), [2, 2]);
  });

  it('honours a limit', async () => {
    const res = await dispatcherApi.post('/api/queues/auto-batch', {
      zone: 'NORTH',
      driverIds: [driverA.id],
      limit: 3,
    });
    assert.equal(res.body.assignedCount, 3);
  });

  it('batches every zone when none is named', async () => {
    const res = await dispatcherApi.post('/api/queues/auto-batch', { driverIds: [driverA.id] });
    assert.equal(res.body.assignedCount, 6);
  });

  it('assigns the longest-waiting parcels first', async () => {
    const res = await dispatcherApi.post('/api/queues/auto-batch', {
      zone: 'NORTH', driverIds: [driverA.id], limit: 1,
    });
    assert.equal(res.body.orders[0].orderRef, 'N-0');
  });

  it('skips orders that are already assigned', async () => {
    const list = await api.get('/api/orders?zone=NORTH');
    await dispatcherApi.post(`/api/orders/${list.body.orders[0].id}/assign`, { driverId: driverB.id });

    const res = await dispatcherApi.post('/api/queues/auto-batch', {
      zone: 'NORTH', driverIds: [driverA.id],
    });
    assert.equal(res.body.assignedCount, 3);
  });

  it('returns nothing when the zone is empty', async () => {
    const res = await dispatcherApi.post('/api/queues/auto-batch', {
      zone: 'NOWHERE', driverIds: [driverA.id],
    });
    assert.equal(res.body.assignedCount, 0);
    assert.deepEqual(res.body.orders, []);
  });

  it('requires at least one driver', async () => {
    const res = await dispatcherApi.post('/api/queues/auto-batch', { zone: 'NORTH', driverIds: [] });
    assert.equal(res.status, 422);
  });

  it('is not available to drivers', async () => {
    const res = await driverAApi.post('/api/queues/auto-batch', {
      zone: 'NORTH', driverIds: [driverA.id],
    });
    assert.equal(res.status, 403);
  });
});

describe('queues', () => {
  it('shows the dispatcher what is waiting per zone', async () => {
    await readyOrder({ orderRef: 'N-1', deliveryZone: 'NORTH' });
    await readyOrder({ orderRef: 'N-2', deliveryZone: 'NORTH' });
    await readyOrder({ orderRef: 'S-1', deliveryZone: 'SOUTH' });
    await readyOrder({ orderRef: 'U-1', deliveryZone: undefined });

    const res = await dispatcherApi.get('/api/queues/dispatch');
    assert.equal(res.status, 200);

    const byZone = Object.fromEntries(res.body.zones.map((z) => [z.zone, z.waiting]));
    assert.equal(byZone.NORTH, 2);
    assert.equal(byZone.SOUTH, 1);
    assert.equal(byZone.UNZONED, 1);
  });

  it('drops a zone out of the queue once its work is assigned', async () => {
    await readyOrder({ orderRef: 'N-1', deliveryZone: 'NORTH' });
    await dispatcherApi.post('/api/queues/auto-batch', { zone: 'NORTH', driverIds: [driverA.id] });

    const res = await dispatcherApi.get('/api/queues/dispatch');
    assert.equal(res.body.zones.length, 0);
  });

  it('gives a driver their own queue with counts', async () => {
    const first = await readyOrder({ orderRef: 'Q-1' });
    const second = await readyOrder({ orderRef: 'Q-2' });
    await readyOrder({ orderRef: 'Q-3' }); // left unassigned

    await dispatcherApi.post(`/api/orders/${first.id}/assign`, { driverId: driverA.id });
    await dispatcherApi.post(`/api/orders/${second.id}/assign`, { driverId: driverA.id });
    await driverAApi.post('/api/scans', { barcodeValue: first.barcodeValue, scanType: 'pickup' });

    const res = await driverAApi.get('/api/queues/mine');
    assert.equal(res.status, 200);
    assert.equal(res.body.orders.length, 2);
    assert.equal(res.body.counts.assigned, 1);
    assert.equal(res.body.counts.outForDelivery, 1);
  });

  it('excludes delivered work from the driver queue', async () => {
    const order = await readyOrder();
    await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: driverA.id });
    await driverAApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });
    await driverAApi.post('/api/scans', {
      barcodeValue: order.barcodeValue, scanType: 'dropoff', outcome: 'delivered',
    });

    const res = await driverAApi.get('/api/queues/mine');
    assert.equal(res.body.orders.length, 0);
  });

  it('keeps a failed attempt in the driver queue until it is re-queued', async () => {
    const order = await readyOrder();
    await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: driverA.id });
    await driverAApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });
    await driverAApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'dropoff',
      outcome: 'failed',
      failureReason: 'Nobody home',
    });

    const res = await driverAApi.get('/api/queues/mine');
    assert.equal(res.body.counts.failed, 1);
  });

  it('does not give staff a personal queue', async () => {
    assert.equal((await dispatcherApi.get('/api/queues/mine')).status, 403);
  });

  it('lets a dispatcher inspect a specific driver queue', async () => {
    const order = await readyOrder();
    await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: driverA.id });

    const res = await dispatcherApi.get(`/api/queues/driver/${driverA.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.orders.length, 1);
  });

  it('reports driver workload for the assignment screen', async () => {
    const order = await readyOrder();
    await dispatcherApi.post(`/api/orders/${order.id}/assign`, { driverId: driverA.id });

    const res = await dispatcherApi.get('/api/auth/drivers');
    const sam = res.body.drivers.find((d) => d.id === driverA.id);
    assert.equal(sam.openOrders, 1);
    assert.equal(sam.deliveredToday, 0);
  });
});
