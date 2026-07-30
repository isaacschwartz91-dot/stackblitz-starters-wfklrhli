/**
 * Over-the-wire tests.
 *
 * AC-10 asks for the cross-customer refusal to be proven "directly against
 * the server, not just through the interface". These drive a real socket with
 * real cookies, so nothing about the browser client is involved at all.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { openDatabase } from './db';
import { bootstrap } from './bootstrap';
import { createApiServer, SESSION_COOKIE } from './http';
import type { ApiContext } from './api';
import * as repo from './repo';

const ADMIN_EMAIL = 'admin@store.test';
const ADMIN_PASSWORD = 'bootstrap-admin-pw';
const CUSTOMER_PASSWORD = 'customer-password-1';

let server: Server;
let base: string;
let ctx: ApiContext;

interface Call {
  status: number;
  json: Record<string, any>;
  text: string;
  headers: Headers;
  cookie: string | null;
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string | null } = {},
): Promise<Call> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie) headers['cookie'] = `${SESSION_COOKIE}=${options.cookie}`;

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  });

  const text = await response.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON — the CSV export and static files land here */
  }

  const setCookie = response.headers.get('set-cookie');
  const cookie = setCookie ? (setCookie.split(';')[0]?.split('=')[1] ?? null) : null;
  return { status: response.status, json: parsed, text, headers: response.headers, cookie };
}

async function signIn(identifier: string, password: string): Promise<string> {
  const response = await call('POST', '/api/auth/sign-in', { body: { identifier, password } });
  assert.equal(response.status, 200, `sign-in failed for ${identifier}: ${response.text}`);
  assert.ok(response.cookie, 'a session cookie must be set');
  return decodeURIComponent(response.cookie!);
}

async function createCustomer(adminCookie: string, email: string) {
  const created = await call('POST', '/api/staff/accounts', {
    cookie: adminCookie,
    body: {
      role: 'customer',
      email,
      password: CUSTOMER_PASSWORD,
      displayName: email,
      memberCount: 3,
      profileId: 'profile-default-v1',
      periodStart: '2026-08-03',
      referralId: `REF-${email}`,
    },
  });
  assert.equal(created.status, 201, created.text);
  return { accountId: created.json['account'].id as string, cookie: await signIn(email, CUSTOMER_PASSWORD) };
}

before(async () => {
  const db = openDatabase(':memory:');
  await bootstrap(db, { adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD });
  ctx = { db, now: () => Date.now(), deliverCode: () => {} };
  server = createApiServer({ ctx, staticDir: null, secureCookies: false });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('acceptance criterion 10, over a real socket', () => {
  let alice: { accountId: string; cookie: string };
  let bob: { accountId: string; cookie: string };
  let bobOrderId: string;
  let bobHouseholdId: string;

  before(async () => {
    const adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    alice = await createCustomer(adminCookie, 'alice-http@example.test');
    bob = await createCustomer(adminCookie, 'bob-http@example.test');

    const start = await call('POST', '/api/orders', { cookie: bob.cookie });
    bobOrderId = start.json['order'].id;
    bobHouseholdId = start.json['order'].householdId;

    const items = repo.listItems(ctx.db, true);
    await call('PUT', `/api/orders/${bobOrderId}/lines`, {
      cookie: bob.cookie,
      body: { lines: [{ itemId: items[0]!.id, qty: 3 }] },
    });
  });

  test("every route touching Bob's order refuses Alice", async () => {
    const attempts: [string, string, unknown?][] = [
      ['GET', `/api/orders/${bobOrderId}`],
      ['GET', `/api/orders/${bobOrderId}/compliance`],
      ['GET', `/api/orders/${bobOrderId}/plan`],
      ['PUT', `/api/orders/${bobOrderId}/lines`, { lines: [] }],
      ['POST', `/api/orders/${bobOrderId}/finalize`, { staffInitials: 'AA' }],
      ['POST', `/api/orders/${bobOrderId}/plan`, { seed: 1 }],
    ];

    for (const [method, path, body] of attempts) {
      const response = await call(method, path, { cookie: alice.cookie, body });
      assert.equal(response.status, 404, `${method} ${path} must be refused`);
      assert.equal(
        response.text.includes(bobOrderId),
        false,
        'the response must not echo the order id back',
      );
    }
  });

  test('URL-encoded and path-traversal variants of the id fare no better', async () => {
    for (const variant of [
      encodeURIComponent(bobOrderId),
      `${bobOrderId}%00`,
      `../orders/${bobOrderId}`,
      `${bobOrderId}/../${bobOrderId}`,
    ]) {
      const response = await call('GET', `/api/orders/${variant}`, { cookie: alice.cookie });
      assert.ok(
        response.status === 404 || response.status === 400,
        `variant "${variant}" must not succeed (got ${response.status})`,
      );
      assert.equal(response.json['order'], undefined);
    }
  });

  test("Bob's data is untouched after all of that", async () => {
    const stored = repo.findOrder(ctx.db, bobOrderId)!;
    assert.equal(stored.status, 'draft');
    assert.equal(stored.lines.length, 1);
    assert.equal(stored.lines[0]!.qty, 3);
  });

  test('an unauthenticated socket gets nothing', async () => {
    for (const path of [
      `/api/orders/${bobOrderId}`,
      '/api/me/orders',
      '/api/me/household',
      '/api/items',
      '/api/staff/records',
      '/api/admin/audit',
    ]) {
      const response = await call('GET', path);
      assert.equal(response.status, 401, `${path} must require a session`);
    }
  });

  test('a stolen-looking cookie value does not authenticate', async () => {
    for (const cookie of ['x', bob.accountId, bobHouseholdId, bob.cookie.slice(0, -3) + 'zzz']) {
      const response = await call('GET', '/api/me/orders', { cookie });
      assert.equal(response.status, 401);
    }
  });
});

describe('transport hardening', () => {
  test('the session cookie is HttpOnly and SameSite=Strict', async () => {
    const response = await call('POST', '/api/auth/sign-in', {
      body: { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const setCookie = response.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /HttpOnly/i, 'script must not be able to read the session');
    assert.match(setCookie, /SameSite=Strict/i, 'blocks cross-site request forgery');
    assert.match(setCookie, /Path=\//);
  });

  test('signing out clears the cookie', async () => {
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    const response = await call('POST', '/api/auth/sign-out', { cookie });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/);
  });

  test('security headers are set, and no third-party origin is allowed (NFR-8)', async () => {
    const response = await call('GET', '/api/items');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');

    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(csp.includes('http://'), false, 'no external origin may be permitted');
    assert.equal(/script-src[^;]*\*/.test(csp), false, 'no wildcard script source');
  });

  test('a malformed JSON body is refused cleanly', async () => {
    const response = await fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.equal(text.includes('SyntaxError'), false, 'no internal error detail may leak');
  });

  test('an unknown API route is a plain 404', async () => {
    const response = await call('GET', '/api/there-is-no-such-thing');
    assert.equal(response.status, 401, 'unauthenticated first');
    const authed = await call('GET', '/api/there-is-no-such-thing', {
      cookie: await signIn(ADMIN_EMAIL, ADMIN_PASSWORD),
    });
    assert.equal(authed.status, 404);
  });

  test('an oversized body is rejected rather than buffered', async () => {
    const response = await fetch(`${base}/api/admin/items/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ csv: 'x'.repeat(3 * 1024 * 1024) }),
    }).catch(() => null);
    // Either the server refuses it, or the socket is torn down mid-upload.
    if (response) assert.ok(response.status === 413 || response.status === 401);
  });
});

describe('acceptance criterion 9, over a real socket', () => {
  test('a customer signs in with a cookie and finalizes unaided', async () => {
    const adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    const customer = await createCustomer(adminCookie, 'solo-http@example.test');

    const start = await call('POST', '/api/orders', { cookie: customer.cookie });
    const order = start.json['order'];
    const items = repo.listItems(ctx.db, true);

    const option = items.find((item) => item.servingsPerPackageUnits > 0)!;
    const lines = [{ itemId: option.id, qty: 1 }];

    const put = await call('PUT', `/api/orders/${order.id}/lines`, {
      cookie: customer.cookie,
      body: { lines },
    });
    assert.equal(put.status, 200);
    assert.equal(put.json['compliance'].canFinalize, true);

    const finalize = await call('POST', `/api/orders/${order.id}/finalize`, {
      cookie: customer.cookie,
      body: { staffInitials: '' },
    });
    assert.equal(finalize.status, 200, finalize.text);

    const history = await call('GET', '/api/me/orders', { cookie: customer.cookie });
    assert.ok(history.json['orders'].some((o: { id: string }) => o.id === order.id));
  });
});
