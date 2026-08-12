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
import { SETTING_KEYS, defaultSettings } from '../src/services/settingsService.js';

let server;
let admin;
let dispatcher;
let driver;
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
  api = apiClient(server.baseUrl, admin.token);
  dispatcherApi = apiClient(server.baseUrl, dispatcher.token);
  driverApi = apiClient(server.baseUrl, driver.token);
});

const anon = () => apiClient(server.baseUrl);

/** Creates an order with everything the visibility toggles can expose. */
async function orderWithDetails() {
  const { body } = await api.post('/api/orders', orderPayload({
    customerName: 'Dana Whitfield',
    customerPhone: '+15551234567',
    addressLine1: '84 Alder Street',
    addressLine2: 'Apt 3B',
    city: 'Springfield',
    postalCode: '62704',
    deliveryNotes: 'Key is under the mat',
  }));
  return body.order;
}

describe('settings api', () => {
  it('everything defaults to hidden', async () => {
    const res = await api.get('/api/settings');
    assert.equal(res.status, 200);

    assert.deepEqual(res.body.settings, defaultSettings());
    for (const key of SETTING_KEYS) {
      assert.equal(res.body.settings[key], false, `${key} should default to false`);
    }
  });

  it('describes each setting so the admin screen can render it', async () => {
    const res = await api.get('/api/settings');
    const definition = res.body.definitions.find(
      (d) => d.key === 'publicTracking.showStreetAddress',
    );

    assert.ok(definition, 'the street address setting should be described');
    assert.equal(definition.type, 'boolean');
    assert.equal(definition.value, false);
    assert.equal(definition.isDefault, true);
    assert.equal(definition.group, 'Public tracking page');
    assert.ok(definition.label.length > 0);
    assert.ok(definition.description.length > 0);
  });

  it('lets an admin change a setting and reports it as non-default', async () => {
    const res = await api.patch('/api/settings', { 'publicTracking.showStreetAddress': true });
    assert.equal(res.status, 200);
    assert.equal(res.body.settings['publicTracking.showStreetAddress'], true);
    // Untouched settings keep their defaults.
    assert.equal(res.body.settings['publicTracking.showCustomerPhone'], false);

    const after = await api.get('/api/settings');
    const definition = after.body.definitions.find(
      (d) => d.key === 'publicTracking.showStreetAddress',
    );
    assert.equal(definition.value, true);
    assert.equal(definition.isDefault, false);
  });

  it('persists a change and allows toggling it back', async () => {
    await api.patch('/api/settings', { 'publicTracking.showDeliveryNotes': true });
    assert.equal(
      (await api.get('/api/settings')).body.settings['publicTracking.showDeliveryNotes'],
      true,
    );

    await api.patch('/api/settings', { 'publicTracking.showDeliveryNotes': false });
    assert.equal(
      (await api.get('/api/settings')).body.settings['publicTracking.showDeliveryNotes'],
      false,
    );
  });

  it('updates several settings at once', async () => {
    const res = await api.patch('/api/settings', {
      'publicTracking.showStreetAddress': true,
      'publicTracking.showCustomerPhone': true,
    });
    assert.equal(res.body.settings['publicTracking.showStreetAddress'], true);
    assert.equal(res.body.settings['publicTracking.showCustomerPhone'], true);
  });

  it('rejects an unknown setting key', async () => {
    const res = await api.patch('/api/settings', { 'publicTracking.showEverything': true });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /Unknown setting/);
  });

  it('rejects a non-boolean value', async () => {
    const res = await api.patch('/api/settings', { 'publicTracking.showStreetAddress': 'yes' });
    assert.equal(res.status, 422);
  });

  it('rejects an empty patch', async () => {
    assert.equal((await api.patch('/api/settings', {})).status, 422);
  });

  it('leaves nothing changed when one key in the patch is invalid', async () => {
    await api.patch('/api/settings', {
      'publicTracking.showStreetAddress': true,
      'publicTracking.nonsense': true,
    });
    const res = await api.get('/api/settings');
    assert.equal(res.body.settings['publicTracking.showStreetAddress'], false);
  });

  it('reports the environment settings that are not runtime-editable', async () => {
    const res = await api.get('/api/settings/environment');
    assert.equal(res.status, 200);
    // Driver self-assignment is on by default.
    assert.equal(res.body.environment.allowDriverSelfAssign, true);
    assert.equal(res.body.notifications.driver, 'log');
  });
});

describe('settings access control', () => {
  it('lets a dispatcher read but not change settings', async () => {
    assert.equal((await dispatcherApi.get('/api/settings')).status, 200);
    const res = await dispatcherApi.patch('/api/settings', {
      'publicTracking.showStreetAddress': true,
    });
    assert.equal(res.status, 403);
  });

  it('hides settings from drivers entirely', async () => {
    assert.equal((await driverApi.get('/api/settings')).status, 403);
    assert.equal((await driverApi.get('/api/settings/environment')).status, 403);
    assert.equal(
      (await driverApi.patch('/api/settings', { 'publicTracking.showStreetAddress': true })).status,
      403,
    );
  });

  it('requires authentication', async () => {
    assert.equal((await anon().get('/api/settings')).status, 401);
    assert.equal(
      (await anon().patch('/api/settings', { 'publicTracking.showStreetAddress': true })).status,
      401,
    );
  });
});

describe('public tracking visibility', () => {
  it('hides the street address, phone and notes by default', async () => {
    const order = await orderWithDetails();
    const res = await anon().get(`/api/track/${order.trackingToken}`);
    const body = JSON.stringify(res.body);

    assert.equal(res.status, 200);
    assert.ok(!body.includes('84 Alder Street'), 'street address should be hidden');
    assert.ok(!body.includes('Apt 3B'), 'address line 2 should be hidden');
    assert.ok(!body.includes('+15551234567'), 'phone should be hidden');
    assert.ok(!body.includes('Key is under the mat'), 'notes should be hidden');

    // The town-level destination is always shown.
    assert.equal(res.body.tracking.destination.city, 'Springfield');
    assert.equal(res.body.tracking.destination.addressLine1, undefined);
    assert.equal(res.body.tracking.customerPhone, undefined);
    assert.equal(res.body.tracking.deliveryNotes, undefined);
  });

  it('shows the street address once an admin turns it on', async () => {
    const order = await orderWithDetails();
    await api.patch('/api/settings', { 'publicTracking.showStreetAddress': true });

    const res = await anon().get(`/api/track/${order.trackingToken}`);
    assert.equal(res.body.tracking.destination.addressLine1, '84 Alder Street');
    assert.equal(res.body.tracking.destination.addressLine2, 'Apt 3B');
    // The other two stay hidden — each toggle is independent.
    assert.equal(res.body.tracking.customerPhone, undefined);
    assert.equal(res.body.tracking.deliveryNotes, undefined);
  });

  it('shows the phone number once an admin turns it on', async () => {
    const order = await orderWithDetails();
    await api.patch('/api/settings', { 'publicTracking.showCustomerPhone': true });

    const res = await anon().get(`/api/track/${order.trackingToken}`);
    assert.equal(res.body.tracking.customerPhone, '+15551234567');
    assert.equal(res.body.tracking.destination.addressLine1, undefined);
  });

  it('shows the delivery notes once an admin turns them on', async () => {
    const order = await orderWithDetails();
    await api.patch('/api/settings', { 'publicTracking.showDeliveryNotes': true });

    const res = await anon().get(`/api/track/${order.trackingToken}`);
    assert.equal(res.body.tracking.deliveryNotes, 'Key is under the mat');
  });

  it('shows everything when all three are on', async () => {
    const order = await orderWithDetails();
    await api.patch('/api/settings', {
      'publicTracking.showStreetAddress': true,
      'publicTracking.showCustomerPhone': true,
      'publicTracking.showDeliveryNotes': true,
    });

    const res = await anon().get(`/api/track/${order.trackingToken}`);
    assert.equal(res.body.tracking.destination.addressLine1, '84 Alder Street');
    assert.equal(res.body.tracking.customerPhone, '+15551234567');
    assert.equal(res.body.tracking.deliveryNotes, 'Key is under the mat');
  });

  it('takes effect immediately, without waiting for a cache to expire', async () => {
    const order = await orderWithDetails();

    // Prime the settings cache by reading the page first.
    const before = await anon().get(`/api/track/${order.trackingToken}`);
    assert.equal(before.body.tracking.customerPhone, undefined);

    await api.patch('/api/settings', { 'publicTracking.showCustomerPhone': true });

    const after = await anon().get(`/api/track/${order.trackingToken}`);
    assert.equal(after.body.tracking.customerPhone, '+15551234567');
  });

  it('omits notes entirely for an order that has none, even when enabled', async () => {
    const { body } = await api.post('/api/orders', orderPayload({ deliveryNotes: undefined }));
    await api.patch('/api/settings', { 'publicTracking.showDeliveryNotes': true });

    const res = await anon().get(`/api/track/${body.order.trackingToken}`);
    assert.equal(res.body.tracking.deliveryNotes, undefined);
  });

  it('never exposes the internal order id or email regardless of settings', async () => {
    const order = await orderWithDetails();
    await api.patch('/api/settings', {
      'publicTracking.showStreetAddress': true,
      'publicTracking.showCustomerPhone': true,
      'publicTracking.showDeliveryNotes': true,
    });

    const res = await anon().get(`/api/track/${order.trackingToken}`);
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes(order.id), 'internal id must never leak');
    assert.ok(!body.includes('@'), 'email must never leak');
  });
});
