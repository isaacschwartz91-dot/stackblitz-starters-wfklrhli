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
import { pool } from '../src/db/pool.js';
import { toCsv } from '../src/services/reportService.js';

let server;
let admin;
let driverA;
let driverB;
let api;
let driverAApi;
let driverBApi;

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
  driverA = await createTestUser({ role: 'driver', fullName: 'Sam Okafor' });
  driverB = await createTestUser({ role: 'driver', fullName: 'Priya Raman' });
  api = apiClient(server.baseUrl, admin.token);
  driverAApi = apiClient(server.baseUrl, driverA.token);
  driverBApi = apiClient(server.baseUrl, driverB.token);
});

/** Runs an order all the way to delivered (or a failed attempt) via the real API. */
async function runDelivery({ driver, driverToken, outcome = 'delivered', zone = 'NORTH', ref }) {
  const { body } = await api.post('/api/orders', orderPayload({ orderRef: ref, deliveryZone: zone }));
  const order = body.order;
  const dApi = apiClient(server.baseUrl, driverToken);

  await api.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'label_activation' });
  await api.post(`/api/orders/${order.id}/assign`, { driverId: driver.id });
  await dApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });
  await dApi.post('/api/scans', {
    barcodeValue: order.barcodeValue,
    scanType: 'dropoff',
    outcome,
    ...(outcome === 'failed' ? { failureReason: 'Nobody home' } : {}),
  });

  return order;
}

/**
 * Backdates the delivery clock so duration maths has something real to measure.
 * Reaching into the DB directly is the only way to fake elapsed time here.
 */
async function backdate(orderId, { readyMinutesAgo, deliveredMinutesAgo }) {
  await pool.query(
    `UPDATE orders
        SET ready_at     = now() - ($2 || ' minutes')::interval,
            delivered_at = CASE WHEN delivered_at IS NULL THEN NULL
                           ELSE now() - ($3 || ' minutes')::interval END
      WHERE id = $1`,
    [orderId, String(readyMinutesAgo), String(deliveredMinutesAgo)],
  );
}

describe('summary report', () => {
  it('counts orders by where they are in the pipeline', async () => {
    await api.post('/api/orders', orderPayload({ orderRef: 'NEW-1' }));

    const ready = (await api.post('/api/orders', orderPayload({ orderRef: 'READY-1' }))).body.order;
    await api.post('/api/scans', { barcodeValue: ready.barcodeValue, scanType: 'label_activation' });

    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'DONE-1' });
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'FAIL-1', outcome: 'failed' });

    const res = await api.get('/api/reports/summary');
    assert.equal(res.status, 200);
    assert.equal(res.body.orders.created, 4);
    assert.equal(res.body.orders.delivered, 1);
    assert.equal(res.body.orders.notYetScanned, 1);
    assert.equal(res.body.orders.awaitingAssignment, 1);
    assert.equal(res.body.orders.failedOpen, 1);
  });

  it('defaults to the last 30 days', async () => {
    const res = await api.get('/api/reports/summary');
    const from = new Date(res.body.range.from);
    const to = new Date(res.body.range.to);
    const days = Math.round((to - from) / 86_400_000);
    assert.equal(days, 30);
  });

  it('rejects a backwards date range', async () => {
    const res = await api.get('/api/reports/summary?from=2026-06-01&to=2026-01-01');
    assert.equal(res.status, 422);
  });
});

describe('scan-to-delivery time', () => {
  it('measures from the label scan to the drop-off scan', async () => {
    const first = await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'T-1' });
    const second = await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'T-2' });
    const third = await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'T-3' });

    // 60, 120 and 180 minutes end to end.
    await backdate(first.id, { readyMinutesAgo: 100, deliveredMinutesAgo: 40 });
    await backdate(second.id, { readyMinutesAgo: 200, deliveredMinutesAgo: 80 });
    await backdate(third.id, { readyMinutesAgo: 300, deliveredMinutesAgo: 120 });

    const res = await api.get('/api/reports/scan-to-delivery');
    assert.equal(res.body.timing.deliveredCount, 3);
    assert.equal(Math.round(res.body.timing.avgSeconds), 120 * 60);
    assert.equal(Math.round(res.body.timing.medianSeconds), 120 * 60);
    assert.equal(Math.round(res.body.timing.fastestSeconds), 60 * 60);
    assert.equal(Math.round(res.body.timing.slowestSeconds), 180 * 60);
  });

  it('reports a p90 so one stuck parcel is visible', async () => {
    for (let i = 0; i < 9; i += 1) {
      const order = await runDelivery({ driver: driverA, driverToken: driverA.token, ref: `P-${i}` });
      await backdate(order.id, { readyMinutesAgo: 70, deliveredMinutesAgo: 10 });
    }
    const slow = await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'P-SLOW' });
    await backdate(slow.id, { readyMinutesAgo: 6000, deliveredMinutesAgo: 10 });

    const res = await api.get('/api/reports/scan-to-delivery');
    assert.equal(res.body.timing.deliveredCount, 10);
    assert.ok(
      res.body.timing.p90Seconds > res.body.timing.medianSeconds * 2,
      'p90 should expose the outlier the median hides',
    );
  });

  it('ignores orders that were never delivered', async () => {
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'F-1', outcome: 'failed' });
    const res = await api.get('/api/reports/scan-to-delivery');
    assert.equal(res.body.timing.deliveredCount, 0);
    assert.equal(res.body.timing.avgSeconds, null);
  });

  it('filters by zone', async () => {
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'N-1', zone: 'NORTH' });
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'S-1', zone: 'SOUTH' });

    const res = await api.get('/api/reports/scan-to-delivery?zone=NORTH');
    assert.equal(res.body.timing.deliveredCount, 1);
  });
});

describe('deliveries per driver', () => {
  it('counts deliveries per driver per day', async () => {
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'A-1' });
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'A-2' });
    await runDelivery({ driver: driverB, driverToken: driverB.token, ref: 'B-1' });

    const res = await api.get('/api/reports/drivers');
    assert.equal(res.status, 200);

    const sam = res.body.perDay.find((r) => r.driverName === 'Sam Okafor');
    const priya = res.body.perDay.find((r) => r.driverName === 'Priya Raman');
    assert.equal(sam.delivered, 2);
    assert.equal(priya.delivered, 1);
  });

  it('reports totals and a success rate', async () => {
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'A-1' });
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'A-2' });
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'A-3', outcome: 'failed' });

    const res = await api.get('/api/reports/drivers');
    const sam = res.body.totals.find((t) => t.driverName === 'Sam Okafor');
    assert.equal(sam.delivered, 2);
    assert.equal(sam.failedAttempts, 1);
    assert.ok(Math.abs(sam.successRate - 2 / 3) < 0.001);
  });

  it('does not claim a 0% success rate for a driver who did no work', async () => {
    const res = await api.get('/api/reports/drivers');
    const priya = res.body.totals.find((t) => t.driverName === 'Priya Raman');
    assert.equal(priya.delivered, 0);
    assert.equal(priya.successRate, null);
  });

  it('can be filtered to one driver', async () => {
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'A-1' });
    await runDelivery({ driver: driverB, driverToken: driverB.token, ref: 'B-1' });

    const res = await api.get(`/api/reports/drivers?driverId=${driverA.id}`);
    assert.equal(res.body.perDay.length, 1);
    assert.equal(res.body.perDay[0].driverName, 'Sam Okafor');
  });
});

describe('failed and reattempted deliveries', () => {
  it('lists orders that failed, with the reason', async () => {
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'F-1', outcome: 'failed' });

    const res = await api.get('/api/reports/failures');
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.ordersWithFailures, 1);
    assert.equal(res.body.summary.totalFailedAttempts, 1);
    assert.equal(res.body.summary.stillOpen, 1);
    assert.equal(res.body.orders[0].orderRef, 'F-1');
    assert.equal(res.body.orders[0].lastFailureReason, 'Nobody home');
    assert.equal(res.body.orders[0].driverName, 'Sam Okafor');
  });

  it('separates reattempted-and-delivered from still-open', async () => {
    const recovered = await runDelivery({
      driver: driverA, driverToken: driverA.token, ref: 'R-1', outcome: 'failed',
    });
    await api.post(`/api/orders/${recovered.id}/assign`, { driverId: driverA.id });
    await driverAApi.post('/api/scans', { barcodeValue: recovered.barcodeValue, scanType: 'pickup' });
    await driverAApi.post('/api/scans', {
      barcodeValue: recovered.barcodeValue, scanType: 'dropoff', outcome: 'delivered',
    });

    await runDelivery({ driver: driverB, driverToken: driverB.token, ref: 'S-1', outcome: 'failed' });

    const res = await api.get('/api/reports/failures');
    assert.equal(res.body.summary.ordersWithFailures, 2);
    assert.equal(res.body.summary.reattemptedAndDelivered, 1);
    assert.equal(res.body.summary.stillOpen, 1);
  });

  it('counts repeated failures on one order', async () => {
    const order = await runDelivery({
      driver: driverA, driverToken: driverA.token, ref: 'M-1', outcome: 'failed',
    });
    await api.post(`/api/orders/${order.id}/assign`, { driverId: driverA.id });
    await driverAApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });
    await driverAApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'dropoff',
      outcome: 'failed',
      failureReason: 'Still nobody home',
    });

    const res = await api.get('/api/reports/failures');
    assert.equal(res.body.orders[0].failureCount, 2);
    assert.equal(res.body.orders[0].attemptCount, 2);
    assert.equal(res.body.orders[0].lastFailureReason, 'Still nobody home');
  });

  it('is empty when nothing has failed', async () => {
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'OK-1' });
    const res = await api.get('/api/reports/failures');
    assert.equal(res.body.summary.ordersWithFailures, 0);
  });
});

describe('daily volume', () => {
  it('returns one row per day in the range, including empty days', async () => {
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'V-1' });

    const res = await api.get('/api/reports/daily-volume?from=2026-08-01&to=2026-08-07');
    assert.equal(res.status, 200);
    assert.equal(res.body.days.length, 7);
    assert.ok(res.body.days.every((d) => typeof d.created === 'number'));
  });

  it('counts each series independently rather than multiplying them', async () => {
    // 3 created, 2 delivered, 1 failed on the same day. Joining the three
    // sources in one pass would report 6 of each.
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'M-1' });
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'M-2' });
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'M-3', outcome: 'failed' });

    const today = new Date().toISOString().slice(0, 10);
    const res = await api.get(`/api/reports/daily-volume?from=${today}&to=${today}T23:59:59.999Z`);

    const [day] = res.body.days;
    assert.equal(day.created, 3);
    assert.equal(day.delivered, 2);
    assert.equal(day.failed, 1);
  });
});

describe('csv export', () => {
  it('quotes fields containing commas and quotes', () => {
    const csv = toCsv(
      [{ label: 'Name', value: (r) => r.name }, { label: 'Note', value: (r) => r.note }],
      [{ name: 'Whitfield, Dana', note: 'Said "leave it"' }],
    );
    assert.match(csv, /"Whitfield, Dana"/);
    assert.match(csv, /"Said ""leave it"""/);
  });

  it('exports deliveries with the timing column', async () => {
    const order = await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'CSV-1' });
    await backdate(order.id, { readyMinutesAgo: 150, deliveredMinutesAgo: 30 });

    const res = await api.get('/api/reports/export/deliveries');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename=".*deliveries.*\.csv"/);

    const [header, firstRow] = res.body.trim().split('\r\n');
    assert.match(header, /^Order reference,Status,Zone/);
    assert.match(firstRow, /CSV-1/);
    assert.match(firstRow, /Sam Okafor/);
    assert.match(firstRow, /2h 00m/);
  });

  it('exports the per-driver report', async () => {
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'D-1' });
    const res = await api.get('/api/reports/export/drivers');
    assert.equal(res.status, 200);
    assert.match(res.body, /Day,Driver,Delivered/);
    assert.match(res.body, /Sam Okafor,1/);
  });

  it('exports the failures report', async () => {
    await runDelivery({ driver: driverA, driverToken: driverA.token, ref: 'X-1', outcome: 'failed' });
    const res = await api.get('/api/reports/export/failures');
    assert.equal(res.status, 200);
    assert.match(res.body, /Nobody home/);
  });

  it('404s on an unknown report name', async () => {
    const res = await api.get('/api/reports/export/nonsense');
    assert.equal(res.status, 404);
    assert.match(res.body.error.message, /Available: deliveries, drivers, failures/);
  });
});

describe('report access control', () => {
  it('is not available to drivers', async () => {
    assert.equal((await driverAApi.get('/api/reports/summary')).status, 403);
    assert.equal((await driverBApi.get('/api/reports/export/deliveries')).status, 403);
  });

  it('is available to dispatchers', async () => {
    const dispatcher = await createTestUser({ role: 'dispatcher' });
    const dispatcherApi = apiClient(server.baseUrl, dispatcher.token);
    assert.equal((await dispatcherApi.get('/api/reports/summary')).status, 200);
  });
});
