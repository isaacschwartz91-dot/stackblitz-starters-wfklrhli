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
import { detectImageType, resetStorage } from '../src/storage/index.js';

let server;
let admin;
let driver;
let otherDriver;
let api;
let driverApi;

/** A real PNG, so the magic-byte check sees genuine image data. */
let samplePng;

before(async () => {
  server = await startTestServer();
  samplePng = await renderQrPng('sample-proof-image');
});

after(async () => {
  await server.close();
  await teardown();
});

beforeEach(async () => {
  await resetDatabase();
  resetStorage();
  admin = await createTestUser({ role: 'admin' });
  driver = await createTestUser({ role: 'driver' });
  otherDriver = await createTestUser({ role: 'driver' });
  api = apiClient(server.baseUrl, admin.token);
  driverApi = apiClient(server.baseUrl, driver.token);
});

/** Creates an order and walks it to out_for_delivery with `driver` holding it. */
async function outForDelivery() {
  const { body } = await api.post('/api/orders', orderPayload());
  const order = body.order;
  await api.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'label_activation' });
  await api.post(`/api/orders/${order.id}/assign`, { driverId: driver.id });
  await driverApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });
  return order;
}

function proofForm({ photo, signature, signatureDataUrl, ...fields } = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.set(key, value);
  }
  if (signatureDataUrl) form.set('signatureDataUrl', signatureDataUrl);
  if (photo) form.set('photo', new Blob([photo], { type: 'image/png' }), 'photo.png');
  if (signature) form.set('signature', new Blob([signature], { type: 'image/png' }), 'signature.png');
  return form;
}

describe('capturing proof at drop-off', () => {
  it('completes the delivery and stores photo and signature together', async () => {
    const order = await outForDelivery();

    const res = await driverApi.post(`/api/orders/${order.id}/proof`, proofForm({
      outcome: 'delivered',
      recipientName: 'Dana Whitfield',
      notes: 'Handed over at the door',
      photo: samplePng,
      signature: samplePng,
    }));

    assert.equal(res.status, 201);
    assert.equal(res.body.order.status, 'delivered');
    assert.ok(res.body.order.deliveredAt);
    assert.equal(res.body.proof.outcome, 'delivered');
    assert.equal(res.body.proof.recipientName, 'Dana Whitfield');
    assert.equal(res.body.proof.notes, 'Handed over at the door');
    assert.equal(res.body.proof.attemptNumber, 1);
    assert.equal(res.body.proof.hasPhoto, true);
    assert.equal(res.body.proof.hasSignature, true);
    assert.ok(res.body.proof.photoUrl);
    // Storage keys must not leak to clients.
    assert.equal(res.body.proof.photoKey, undefined);
  });

  it('accepts a signature drawn on a canvas as a data url', async () => {
    const order = await outForDelivery();
    const dataUrl = `data:image/png;base64,${samplePng.toString('base64')}`;

    const res = await driverApi.post(`/api/orders/${order.id}/proof`, proofForm({
      outcome: 'delivered',
      signatureDataUrl: dataUrl,
    }));

    assert.equal(res.status, 201);
    assert.equal(res.body.proof.hasSignature, true);
    assert.equal(res.body.proof.hasPhoto, false);
  });

  it('records a failed attempt with a reason', async () => {
    const order = await outForDelivery();

    const res = await driverApi.post(`/api/orders/${order.id}/proof`, proofForm({
      outcome: 'failed',
      failureReason: 'Nobody home, no safe place to leave it',
      photo: samplePng,
    }));

    assert.equal(res.status, 201);
    assert.equal(res.body.order.status, 'failed_attempt');
    assert.equal(res.body.proof.outcome, 'failed');
    assert.equal(res.body.proof.failureReason, 'Nobody home, no safe place to leave it');
  });

  it('requires a reason when the attempt failed', async () => {
    const order = await outForDelivery();
    const res = await driverApi.post(`/api/orders/${order.id}/proof`, proofForm({ outcome: 'failed' }));
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /needs a reason/);
  });

  it('allows proof with no images at all', async () => {
    const order = await outForDelivery();
    const res = await driverApi.post(`/api/orders/${order.id}/proof`, proofForm({
      outcome: 'delivered',
      recipientName: 'Dana Whitfield',
    }));
    assert.equal(res.status, 201);
    assert.equal(res.body.proof.hasPhoto, false);
    assert.equal(res.body.proof.hasSignature, false);
  });
});

describe('attaching proof after a drop-off scan', () => {
  it('attaches images to the attempt the scan already closed', async () => {
    const order = await outForDelivery();
    const scan = await driverApi.post('/api/scans', {
      barcodeValue: order.barcodeValue,
      scanType: 'dropoff',
      outcome: 'delivered',
      recipientName: 'Dana Whitfield',
    });

    assert.equal(scan.body.order.status, 'delivered');
    assert.equal(scan.body.proof.attemptNumber, 1);
    assert.equal(scan.body.proof.photoKey, null);

    const res = await driverApi.post(`/api/orders/${order.id}/proof`, proofForm({
      photo: samplePng,
      signature: samplePng,
    }));

    assert.equal(res.status, 201);
    assert.equal(res.body.proof.hasPhoto, true);
    assert.equal(res.body.proof.attemptNumber, 1);
    assert.equal(res.body.proof.recipientName, 'Dana Whitfield');

    // Still exactly one proof row for this attempt.
    const list = await api.get(`/api/orders/${order.id}/proof`);
    assert.equal(list.body.proof.length, 1);
  });

  it('keeps evidence from each attempt separately', async () => {
    const order = await outForDelivery();

    await driverApi.post(`/api/orders/${order.id}/proof`, proofForm({
      outcome: 'failed',
      failureReason: 'Nobody home',
      photo: samplePng,
    }));

    await api.post(`/api/orders/${order.id}/assign`, { driverId: driver.id });
    await driverApi.post('/api/scans', { barcodeValue: order.barcodeValue, scanType: 'pickup' });
    await driverApi.post(`/api/orders/${order.id}/proof`, proofForm({
      outcome: 'delivered',
      recipientName: 'Dana Whitfield',
      photo: samplePng,
    }));

    const res = await api.get(`/api/orders/${order.id}/proof`);
    assert.equal(res.body.proof.length, 2);
    assert.deepEqual(res.body.proof.map((p) => [p.attemptNumber, p.outcome]), [[1, 'failed'], [2, 'delivered']]);
    assert.equal(res.body.proof[0].failureReason, 'Nobody home');
    // Both attempts kept their own image.
    assert.notEqual(res.body.proof[0].photoUrl, res.body.proof[1].photoUrl);
  });
});

describe('proof access control', () => {
  it('refuses a driver who is not holding the parcel', async () => {
    const order = await outForDelivery();
    const otherApi = apiClient(server.baseUrl, otherDriver.token);

    const res = await otherApi.post(`/api/orders/${order.id}/proof`, proofForm({ outcome: 'delivered' }));
    assert.equal(res.status, 403);
    assert.equal((await otherApi.get(`/api/orders/${order.id}/proof`)).status, 403);
  });

  it('refuses proof for a parcel that is not out for delivery', async () => {
    const { body } = await api.post('/api/orders', orderPayload());
    const res = await api.post(`/api/orders/${body.order.id}/proof`, proofForm({ outcome: 'delivered' }));
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /only be captured at drop-off/);
  });

  it('lets an admin capture proof on a driver behalf', async () => {
    const order = await outForDelivery();
    const res = await api.post(`/api/orders/${order.id}/proof`, proofForm({
      outcome: 'delivered', recipientName: 'Front desk',
    }));
    assert.equal(res.status, 201);
  });
});

describe('proof image validation', () => {
  it('rejects a file that is not an image', async () => {
    const order = await outForDelivery();
    const form = new FormData();
    form.set('outcome', 'delivered');
    form.set('photo', new Blob([Buffer.from('#!/bin/sh\nrm -rf /')], { type: 'image/png' }), 'evil.png');

    const res = await driverApi.post(`/api/orders/${order.id}/proof`, form);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /must be a JPEG, PNG or WebP/);
  });

  it('rejects a malformed signature data url', async () => {
    const order = await outForDelivery();
    const res = await driverApi.post(`/api/orders/${order.id}/proof`, proofForm({
      outcome: 'delivered',
      signatureDataUrl: 'data:text/html;base64,PGgxPmhpPC9oMT4=',
    }));
    assert.equal(res.status, 400);
  });

  it('does not change the order when the image is rejected', async () => {
    const order = await outForDelivery();
    const form = new FormData();
    form.set('outcome', 'delivered');
    form.set('photo', new Blob([Buffer.from('not an image')], { type: 'image/png' }), 'x.png');
    await driverApi.post(`/api/orders/${order.id}/proof`, form);

    const detail = await api.get(`/api/orders/${order.id}`);
    assert.equal(detail.body.order.status, 'out_for_delivery');
  });

  it('detects png, jpeg and webp', () => {
    assert.equal(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).ext, 'png');
    assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).ext, 'jpg');
    const webp = Buffer.concat([
      Buffer.from([0x52, 0x49, 0x46, 0x46]),
      Buffer.alloc(4),
      Buffer.from([0x57, 0x45, 0x42, 0x50]),
    ]);
    assert.equal(detectImageType(webp).ext, 'webp');
    assert.equal(detectImageType(Buffer.from('plain text')), null);
  });
});

describe('signed proof image urls', () => {
  it('serves the image to anyone holding the signed link', async () => {
    const order = await outForDelivery();
    const captured = await driverApi.post(`/api/orders/${order.id}/proof`, proofForm({
      outcome: 'delivered',
      photo: samplePng,
    }));

    const url = captured.body.proof.photoUrl;
    // No Authorization header: the customer opens this from an SMS.
    const response = await fetch(url.replace('http://localhost:4000', server.baseUrl));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');

    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  it('refuses a tampered signature', async () => {
    const order = await outForDelivery();
    const captured = await driverApi.post(`/api/orders/${order.id}/proof`, proofForm({
      outcome: 'delivered', photo: samplePng,
    }));

    const url = new URL(captured.body.proof.photoUrl.replace('http://localhost:4000', server.baseUrl));
    url.searchParams.set('sig', 'x'.repeat(43));
    assert.equal((await fetch(url)).status, 403);
  });

  it('refuses an expired link', async () => {
    const order = await outForDelivery();
    const captured = await driverApi.post(`/api/orders/${order.id}/proof`, proofForm({
      outcome: 'delivered', photo: samplePng,
    }));

    const url = new URL(captured.body.proof.photoUrl.replace('http://localhost:4000', server.baseUrl));
    url.searchParams.set('expires', '1');
    assert.equal((await fetch(url)).status, 403);
  });

  it('refuses a path traversal attempt', async () => {
    const res = await fetch(`${server.baseUrl}/api/files/../../etc/passwd?expires=99999999999&sig=abc`);
    assert.ok([400, 403, 404].includes(res.status), `unexpected status ${res.status}`);
  });
});
