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
import { renderQrPng } from '../src/lib/labels.js';
import { renderMessage, isRepeatable, templateKeyFor } from '../src/notifications/templates.js';
import { resetStorage } from '../src/storage/index.js';

let server;
let admin;
let driver;
let api;
let driverApi;
let samplePng;

before(async () => {
  server = await startTestServer();
  samplePng = await renderQrPng('proof');
});

after(async () => {
  await server.close();
  await teardown();
});

beforeEach(async () => {
  await resetDatabase();
  resetStorage();
  admin = await createTestUser({ role: 'admin' });
  driver = await createTestUser({ role: 'driver', fullName: 'Sam Okafor' });
  api = apiClient(server.baseUrl, admin.token);
  driverApi = apiClient(server.baseUrl, driver.token);
});

async function newOrder(overrides) {
  const { body } = await api.post('/api/orders', orderPayload(overrides));
  return body.order;
}

async function activate(order) {
  return api.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'label_activation' });
}

/** The feed is newest-first; tests read better oldest-first. */
async function notificationsFor(orderId) {
  const res = await api.get('/api/notifications?limit=200');
  return res.body.notifications
    .filter((n) => n.orderId === orderId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

describe('message templates', () => {
  const order = { orderRef: 'ORD-1001', customerName: 'Dana Whitfield' };
  const context = { order, trackingUrl: 'https://track.test/track/abc', driverName: 'Sam Okafor' };

  it('renders an sms for each notifiable status', () => {
    for (const status of ['ready_for_delivery', 'out_for_delivery', 'delivered', 'failed_attempt']) {
      const message = renderMessage({ templateKey: templateKeyFor(status), channel: 'sms', context });
      assert.ok(message.body.includes('ORD-1001'), `${status} sms should name the order`);
      assert.ok(message.body.length < 320, `${status} sms should stay short`);
    }
  });

  it('includes the tracking link and driver first name', () => {
    const message = renderMessage({
      templateKey: 'out_for_delivery', channel: 'sms', context,
    });
    assert.match(message.body, /https:\/\/track\.test\/track\/abc/);
    assert.match(message.body, /Sam/);
    assert.ok(!message.body.includes('Okafor'), 'surname should not be shared with the customer');
  });

  it('prefers the photo link over the tracking link once delivered', () => {
    const withPhoto = renderMessage({
      templateKey: 'delivered',
      channel: 'sms',
      context: { ...context, proofUrl: 'https://files.test/photo.png' },
    });
    assert.match(withPhoto.body, /files\.test\/photo\.png/);
  });

  it('gives email a subject and a body', () => {
    const message = renderMessage({ templateKey: 'delivered', channel: 'email', context });
    assert.match(message.subject, /ORD-1001/);
    assert.match(message.body, /Dana Whitfield/);
  });

  it('marks only the repeatable templates as repeatable', () => {
    assert.equal(isRepeatable('out_for_delivery'), true);
    assert.equal(isRepeatable('failed_attempt'), true);
    assert.equal(isRepeatable('order_dispatched'), false);
    assert.equal(isRepeatable('delivered'), false);
  });
});

describe('dispatching notifications', () => {
  it('notifies the customer when the label is scanned', async () => {
    const order = await newOrder({ customerPhone: '+15551234567', customerEmail: 'dana@example.com' });
    await activate(order);

    const sent = await notificationsFor(order.id);
    assert.equal(sent.length, 2, 'one sms and one email');
    assert.deepEqual(sent.map((n) => n.channel).sort(), ['email', 'sms']);
    assert.ok(sent.every((n) => n.status === 'sent'));
    assert.ok(sent.every((n) => n.templateKey === 'order_dispatched'));
    assert.match(sent.find((n) => n.channel === 'sms').payload.body, /dispatched/i);
  });

  it('only uses the channels the customer actually has', async () => {
    const phoneOnly = await newOrder({ customerPhone: '+15551234567', customerEmail: undefined });
    await activate(phoneOnly);
    const sent = await notificationsFor(phoneOnly.id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, 'sms');
  });

  it('notifies at each step of the journey', async () => {
    const order = await newOrder({ customerPhone: '+15551234567', customerEmail: undefined });
    await activate(order);
    await api.post(`/api/orders/${order.id}/assign`, { driverId: driver.id });
    await driverApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });
    await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue, scanType: 'dropoff', outcome: 'delivered',
    });

    const sent = await notificationsFor(order.id);
    assert.deepEqual(
      sent.map((n) => n.templateKey),
      ['order_dispatched', 'out_for_delivery', 'delivered'],
    );
  });

  it('does not announce dispatch twice when an order is re-queued', async () => {
    const order = await newOrder({ customerPhone: '+15551234567', customerEmail: undefined });
    await activate(order);
    await api.post(`/api/orders/${order.id}/assign`, { driverId: driver.id });
    // Dispatcher changes their mind: back to the queue, then out again.
    await api.post(`/api/orders/${order.id}/assign`, { driverId: null });
    await api.post(`/api/orders/${order.id}/assign`, { driverId: driver.id });

    const sent = await notificationsFor(order.id);
    assert.equal(sent.filter((n) => n.templateKey === 'order_dispatched').length, 1);
  });

  it('does tell the customer again when a redelivery goes out', async () => {
    const order = await newOrder({ customerPhone: '+15551234567', customerEmail: undefined });
    await activate(order);
    await api.post(`/api/orders/${order.id}/assign`, { driverId: driver.id });
    await driverApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });
    await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'dropoff',
      outcome: 'failed',
      failureReason: 'Nobody home',
    });
    await api.post(`/api/orders/${order.id}/assign`, { driverId: driver.id });
    await driverApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });

    const sent = await notificationsFor(order.id);
    assert.equal(sent.filter((n) => n.templateKey === 'out_for_delivery').length, 2);
    assert.equal(sent.filter((n) => n.templateKey === 'failed_attempt').length, 1);
  });

  it('includes the proof-of-delivery photo link in the delivered message', async () => {
    const order = await newOrder({ customerPhone: '+15551234567', customerEmail: undefined });
    await activate(order);
    await api.post(`/api/orders/${order.id}/assign`, { driverId: driver.id });
    await driverApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });

    const form = new FormData();
    form.set('outcome', 'delivered');
    form.set('photo', new Blob([samplePng], { type: 'image/png' }), 'photo.png');
    await driverApi.post(`/api/orders/${order.id}/proof`, form);

    const sent = await notificationsFor(order.id);
    const delivered = sent.find((n) => n.templateKey === 'delivered');
    assert.ok(delivered, 'a delivered notification should exist');
    assert.match(delivered.payload.body, /\/api\/files\/proof\//);
  });

  it('says nothing about statuses that are not customer-facing', async () => {
    const order = await newOrder({ customerPhone: '+15551234567', customerEmail: undefined });
    await api.patch(`/api/orders/${order.id}/status`, { status: 'cancelled' });
    assert.equal((await notificationsFor(order.id)).length, 0);
  });

  it('reports which providers are configured', async () => {
    const res = await api.get('/api/notifications/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.notifications.driver, 'log');
    assert.equal(res.body.notifications.sms.provider, 'twilio');
    assert.equal(res.body.notifications.email.provider, 'sendgrid');
    // Placeholder credentials must not read as configured.
    assert.equal(res.body.notifications.sms.configured, false);
  });

  it('does not expose the notification feed to drivers', async () => {
    assert.equal((await driverApi.get('/api/notifications')).status, 403);
  });
});

describe('public tracking page', () => {
  /** Unauthenticated client — the customer has no account. */
  const anon = () => apiClient(server.baseUrl);

  it('is readable with no login', async () => {
    const order = await newOrder();
    const res = await anon().get(`/api/track/${order.trackingToken}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.tracking.orderRef, order.orderRef);
    assert.equal(res.body.tracking.status.code, 'preparing');
  });

  it('never exposes contact details or the street address', async () => {
    const order = await newOrder({
      customerName: 'Dana Whitfield',
      customerPhone: '+15551234567',
      customerEmail: 'dana@example.com',
      addressLine1: '84 Alder Street',
      deliveryNotes: 'Key is under the mat',
    });

    const res = await anon().get(`/api/track/${order.trackingToken}`);
    const serialised = JSON.stringify(res.body);

    assert.ok(!serialised.includes('84 Alder Street'), 'street address must not leak');
    assert.ok(!serialised.includes('+15551234567'), 'phone must not leak');
    assert.ok(!serialised.includes('dana@example.com'), 'email must not leak');
    assert.ok(!serialised.includes('Key is under the mat'), 'delivery notes must not leak');
    assert.ok(!serialised.includes(order.id), 'internal id must not leak');
    // But enough to recognise the delivery.
    assert.equal(res.body.tracking.customerName, 'Dana W.');
    assert.equal(res.body.tracking.destination.city, 'Springfield');
  });

  it('shows the milestones the customer cares about', async () => {
    const order = await newOrder();
    await activate(order);
    await api.post(`/api/orders/${order.id}/assign`, { driverId: driver.id });
    await driverApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });

    const res = await anon().get(`/api/track/${order.trackingToken}`);
    assert.equal(res.body.tracking.status.code, 'out_for_delivery');
    // Assignment is internal noise and is collapsed into 'dispatched'.
    assert.deepEqual(
      res.body.tracking.milestones.map((m) => m.code),
      ['dispatched', 'out_for_delivery'],
    );
    assert.ok(res.body.tracking.milestones.every((m) => m.at));
  });

  it('shares only the driver first name, and only while out for delivery', async () => {
    const order = await newOrder();
    await activate(order);
    await api.post(`/api/orders/${order.id}/assign`, { driverId: driver.id });

    let res = await anon().get(`/api/track/${order.trackingToken}`);
    assert.equal(res.body.tracking.driverFirstName, null);

    await driverApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });
    res = await anon().get(`/api/track/${order.trackingToken}`);
    assert.equal(res.body.tracking.driverFirstName, 'Sam');
  });

  it('shows proof of delivery once delivered', async () => {
    const order = await newOrder();
    await activate(order);
    await api.post(`/api/orders/${order.id}/assign`, { driverId: driver.id });
    await driverApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });

    const form = new FormData();
    form.set('outcome', 'delivered');
    form.set('recipientName', 'Dana Whitfield');
    form.set('photo', new Blob([samplePng], { type: 'image/png' }), 'photo.png');
    await driverApi.post(`/api/orders/${order.id}/proof`, form);

    const res = await anon().get(`/api/track/${order.trackingToken}`);
    assert.equal(res.body.tracking.status.code, 'delivered');
    assert.ok(res.body.tracking.deliveredAt);
    assert.equal(res.body.tracking.proofOfDelivery.recipientName, 'Dana Whitfield');
    assert.ok(res.body.tracking.proofOfDelivery.photoUrl);

    // The photo opens without a login too.
    const photo = await fetch(
      res.body.tracking.proofOfDelivery.photoUrl.replace('http://localhost:4000', server.baseUrl),
    );
    assert.equal(photo.status, 200);
  });

  it('reports a failed attempt honestly', async () => {
    const order = await newOrder();
    await activate(order);
    await api.post(`/api/orders/${order.id}/assign`, { driverId: driver.id });
    await driverApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });
    await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'dropoff',
      outcome: 'failed',
      failureReason: 'Nobody home',
    });

    const res = await anon().get(`/api/track/${order.trackingToken}`);
    assert.equal(res.body.tracking.status.code, 'attempted');
    assert.equal(res.body.tracking.attemptCount, 1);
  });

  it('404s on an unknown or guessed token', async () => {
    assert.equal((await anon().get('/api/track/not-a-real-token')).status, 404);
  });

  it('is not cacheable by shared proxies', async () => {
    const order = await newOrder();
    const res = await anon().get(`/api/track/${order.trackingToken}`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});
