import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase, type Db } from './db';
import { bootstrap } from './bootstrap';
import { handle, type ApiContext } from './api';
import * as repo from './repo';
import { hashPassword, verifyPassword, MAX_FAILED_ATTEMPTS } from './security';
import { servingsToUnits } from '../src/shared/units';
import type { Item } from '../src/shared/types';

const ADMIN_EMAIL = 'admin@store.test';
const ADMIN_PASSWORD = 'bootstrap-admin-pw';
const CUSTOMER_PASSWORD = 'customer-password-1';

interface Harness {
  ctx: ApiContext;
  db: Db;
  codes: { code: string; purpose: string; to: string | null }[];
}

async function makeHarness(): Promise<Harness> {
  const db = openDatabase(':memory:');
  const codes: Harness['codes'] = [];
  const ctx: ApiContext = {
    db,
    now: () => Date.now(),
    deliverCode: (to, code, purpose) => codes.push({ code, purpose, to: to.email ?? to.phone }),
  };
  await bootstrap(db, { adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD });
  return { ctx, db, codes };
}

interface ReqOptions {
  body?: unknown;
  token?: string | null;
  query?: Record<string, string>;
  ip?: string;
}

function req(h: Harness, method: string, path: string, options: ReqOptions = {}) {
  return handle(h.ctx, {
    method,
    path,
    query: new URLSearchParams(options.query ?? {}),
    body: options.body ?? null,
    token: options.token ?? null,
    ip: options.ip ?? '10.0.0.1',
  });
}

const bodyOf = (response: { body: unknown }) => response.body as Record<string, any>;

async function signIn(h: Harness, identifier: string, password: string): Promise<string> {
  const response = await req(h, 'POST', '/api/auth/sign-in', { body: { identifier, password } });
  assert.equal(response.status, 200, `sign-in failed for ${identifier}`);
  assert.ok(response.sessionToken, 'a session token must be issued');
  return response.sessionToken!;
}

/** Staff-created customer account plus its household (FR-A1, FR-A2). */
async function createCustomer(
  h: Harness,
  adminToken: string,
  email: string,
  overrides: Record<string, unknown> = {},
): Promise<{ accountId: string; token: string }> {
  const response = await req(h, 'POST', '/api/staff/accounts', {
    token: adminToken,
    body: {
      role: 'customer',
      email,
      password: CUSTOMER_PASSWORD,
      displayName: email,
      memberCount: 3,
      profileId: 'profile-default-v1',
      periodStart: '2026-08-03',
      referralId: `REF-${email}`,
      ...overrides,
    },
  });
  assert.equal(response.status, 201, `account creation failed: ${JSON.stringify(response.body)}`);
  const accountId = bodyOf(response)['account'].id as string;
  const token = await signIn(h, email, CUSTOMER_PASSWORD);
  return { accountId, token };
}

/** Fill an order so it satisfies every category within the cap. */
async function buildCompliantOrder(h: Harness, token: string): Promise<string> {
  const start = await req(h, 'POST', '/api/orders', { token });
  assert.ok(start.status === 201 || start.status === 200, 'order should start');
  const order = bodyOf(start)['order'];
  const orderId = order.id as string;
  const snapshot = order.rulesSnapshot;

  const items = repo.listItems(h.ctx.db, true);
  const lines: { itemId: string; qty: number }[] = [];
  for (const cat of snapshot.categories) {
    const required = snapshot.requiredUnitsByCategory[cat.key] as number;
    const option = items.find(
      (i: Item) => i.categoryKey === cat.key && i.servingsPerPackageUnits > 0,
    )!;
    lines.push({ itemId: option.id, qty: Math.ceil(required / option.servingsPerPackageUnits) });
  }

  const put = await req(h, 'PUT', `/api/orders/${orderId}/lines`, { token, body: { lines } });
  assert.equal(put.status, 200, `setting lines failed: ${JSON.stringify(put.body)}`);
  return orderId;
}

// =========================================================================

describe('NFR-2: password storage', () => {
  test('a stored password is a slow scrypt hash, not the password or a bare digest', async () => {
    const hash = await hashPassword('a-real-password');
    assert.ok(hash.startsWith('scrypt$'), 'must record the algorithm and its parameters');
    assert.equal(hash.includes('a-real-password'), false, 'the password itself must not appear');
    // A bare SHA-256 hex digest is 64 chars; this must be materially different.
    assert.ok(hash.length > 100, 'must carry salt and parameters, not just a digest');

    assert.equal(await verifyPassword('a-real-password', hash), true);
    assert.equal(await verifyPassword('a-real-passwore', hash), false);

    // Salted: the same password hashes differently every time.
    assert.notEqual(await hashPassword('a-real-password'), hash);
  });

  test('a malformed or empty stored hash never verifies', async () => {
    for (const stored of [null, '', 'not-a-hash', 'scrypt$1$2$3', 'scrypt$x$y$z$aa$']) {
      assert.equal(await verifyPassword('anything', stored), false, `must reject "${stored}"`);
    }
  });
});

describe('NFR-6: audit integrity', () => {
  test('new audit events form a tamper-evident HMAC chain', async () => {
    const h = await makeHarness();
    await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const rows = h.ctx.db
      .prepare('SELECT prev_hash, integrity_hash FROM audit_events ORDER BY rowid ASC')
      .all() as { prev_hash: string | null; integrity_hash: string | null }[];
    assert.ok(rows.length > 0);
    for (let index = 0; index < rows.length; index++) {
      assert.match(rows[index]!.integrity_hash ?? '', /^[a-f0-9]{64}$/);
      assert.equal(rows[index]!.prev_hash, index === 0 ? null : rows[index - 1]!.integrity_hash);
    }
  });
});

describe('FR-A1: accounts are created by staff, never by self-registration', () => {
  let h: Harness;
  before(async () => {
    h = await makeHarness();
  });

  test('there is no open signup route', async () => {
    for (const path of ['/api/accounts', '/api/signup', '/api/register', '/api/auth/register']) {
      const response = await req(h, 'POST', path, {
        body: { email: 'walkin@example.test', password: 'trying-to-register' },
      });
      assert.ok(
        response.status === 404 || response.status === 401,
        `${path} must not create an account (got ${response.status})`,
      );
    }
    assert.equal(repo.findAccountByIdentifier(h.ctx.db, 'walkin@example.test'), null);
  });

  test('an unauthenticated caller cannot reach the staff account route', async () => {
    const response = await req(h, 'POST', '/api/staff/accounts', {
      body: { role: 'customer', email: 'x@example.test' },
    });
    assert.equal(response.status, 401);
  });

  test('a customer cannot create accounts, including staff accounts', async () => {
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const customer = await createCustomer(h, adminToken, 'c-noescalate@example.test');

    const asCustomer = await req(h, 'POST', '/api/staff/accounts', {
      token: customer.token,
      body: { role: 'admin', email: 'escalated@example.test', password: 'escalation-attempt' },
    });
    assert.equal(asCustomer.status, 403);
    assert.equal(repo.findAccountByIdentifier(h.ctx.db, 'escalated@example.test'), null);
  });

  test('staff cannot mint an admin account; only an admin can', async () => {
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const staffCreate = await req(h, 'POST', '/api/staff/accounts', {
      token: adminToken,
      body: { role: 'staff', email: 'staff-1@store.test', password: 'staff-password-1', displayName: 'Sam' },
    });
    assert.equal(staffCreate.status, 201);
    const staffToken = await signIn(h, 'staff-1@store.test', 'staff-password-1');

    const attempt = await req(h, 'POST', '/api/staff/accounts', {
      token: staffToken,
      body: { role: 'admin', email: 'admin-2@store.test', password: 'another-admin-pw' },
    });
    assert.equal(attempt.status, 403, 'staff must not be able to create an admin');
  });

  test('staff cannot reset, suspend, or revoke an administrator', async () => {
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const created = await req(h, 'POST', '/api/staff/accounts', {
      token: adminToken,
      body: { role: 'staff', email: 'least-privilege@store.test', password: 'staff-password-1' },
    });
    assert.equal(created.status, 201);
    const staffToken = await signIn(h, 'least-privilege@store.test', 'staff-password-1');
    const admin = repo.findAccountByIdentifier(h.ctx.db, ADMIN_EMAIL)!;

    for (const action of ['reset-password', 'suspend', 'revoke-sessions']) {
      const response = await req(h, 'POST', `/api/staff/accounts/${admin.id}/${action}`, {
        token: staffToken,
        body: action === 'reset-password' ? { password: 'attacker-chosen-password' } : {},
      });
      assert.equal(response.status, 403, `staff must not ${action} an administrator`);
    }
    assert.equal((await req(h, 'POST', '/api/auth/sign-in', {
      body: { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })).status, 200, 'the administrator password must be unchanged');
  });

  test('a suspended staff member loses privileged access immediately', async () => {
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const created = await req(h, 'POST', '/api/staff/accounts', {
      token: adminToken,
      body: { role: 'staff', email: 'suspended-staff@store.test', password: 'staff-password-1' },
    });
    const staffId = bodyOf(created)['account'].id as string;
    const staffToken = await signIn(h, 'suspended-staff@store.test', 'staff-password-1');
    assert.equal((await req(h, 'POST', `/api/staff/accounts/${staffId}/suspend`, { token: adminToken })).status, 200);
    assert.equal((await req(h, 'GET', '/api/staff/accounts', { token: staffToken })).status, 403);
    assert.equal((await req(h, 'POST', '/api/auth/sign-in', {
      body: { identifier: 'suspended-staff@store.test', password: 'staff-password-1' },
    })).status, 403);
  });
});

describe('acceptance criterion 9: a customer completes an order unaided', () => {
  test('sign in, build, finalize, and see it in their own history', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const customer = await createCustomer(h, adminToken, 'c-solo@example.test');

    // No staff action from here on — only the customer's own token is used.
    const orderId = await buildCompliantOrder(h, customer.token);

    const compliance = await req(h, 'GET', `/api/orders/${orderId}/compliance`, {
      token: customer.token,
    });
    assert.equal(compliance.status, 200);
    assert.equal(bodyOf(compliance)['compliance'].canFinalize, true, 'the order should qualify');

    const finalize = await req(h, 'POST', `/api/orders/${orderId}/finalize`, {
      token: customer.token,
      body: { staffInitials: '' },
    });
    assert.equal(finalize.status, 200, JSON.stringify(finalize.body));
    assert.equal(bodyOf(finalize)['order'].status, 'final');
    assert.equal(bodyOf(finalize)['order'].override, null, 'a qualifying order needs no override');

    const history = await req(h, 'GET', '/api/me/orders', { token: customer.token });
    assert.equal(history.status, 200);
    const ids = bodyOf(history)['orders'].map((o: { id: string }) => o.id);
    assert.ok(ids.includes(orderId), 'the finalized order must appear in their own history');

    // FR-A8: and they can reprint their own plan.
    const plan = await req(h, 'POST', `/api/orders/${orderId}/plan`, {
      token: customer.token,
      body: { seed: 4242 },
    });
    assert.equal(plan.status, 201);
    assert.equal(bodyOf(plan)['plan'].days.length, 7);
  });
});

describe('acceptance criterion 10: customer A cannot reach customer B', () => {
  let h: Harness;
  let alice: { accountId: string; token: string };
  let bob: { accountId: string; token: string };
  let bobOrderId: string;
  let bobHouseholdId: string;

  before(async () => {
    h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    alice = await createCustomer(h, adminToken, 'alice@example.test');
    bob = await createCustomer(h, adminToken, 'bob@example.test');
    bobOrderId = await buildCompliantOrder(h, bob.token);
    bobHouseholdId = repo.findHouseholdByAccount(h.ctx.db, bob.accountId)!.id;
  });

  test("Alice cannot fetch Bob's order by its real ID", async () => {
    const response = await req(h, 'GET', `/api/orders/${bobOrderId}`, { token: alice.token });
    assert.equal(response.status, 404, "must refuse, and must not confirm the order exists");
    assert.equal(bodyOf(response)['order'], undefined);
    assert.equal(JSON.stringify(response.body).includes(bobOrderId), false);
  });

  test("Alice cannot read Bob's compliance result or meal plan", async () => {
    for (const suffix of ['/compliance', '/plan']) {
      const response = await req(h, 'GET', `/api/orders/${bobOrderId}${suffix}`, {
        token: alice.token,
      });
      assert.equal(response.status, 404, `${suffix} must be refused`);
    }
  });

  test("Alice cannot write to Bob's order", async () => {
    const items = repo.listItems(h.ctx.db, true);
    const write = await req(h, 'PUT', `/api/orders/${bobOrderId}/lines`, {
      token: alice.token,
      body: { lines: [{ itemId: items[0]!.id, qty: 99 }] },
    });
    assert.equal(write.status, 404);

    const finalize = await req(h, 'POST', `/api/orders/${bobOrderId}/finalize`, {
      token: alice.token,
      body: { staffInitials: 'AA' },
    });
    assert.equal(finalize.status, 404);

    const generate = await req(h, 'POST', `/api/orders/${bobOrderId}/plan`, {
      token: alice.token,
      body: { seed: 1 },
    });
    assert.equal(generate.status, 404);

    // And Bob's order is untouched.
    const stored = repo.findOrder(h.ctx.db, bobOrderId)!;
    assert.equal(stored.status, 'draft');
    assert.equal(stored.lines.some((l) => l.qty === 99), false);
  });

  test('the refusal is indistinguishable from a nonexistent ID', async () => {
    const real = await req(h, 'GET', `/api/orders/${bobOrderId}`, { token: alice.token });
    const fake = await req(h, 'GET', '/api/orders/order_does_not_exist', { token: alice.token });
    assert.equal(real.status, fake.status, 'status must not reveal existence');
    assert.deepEqual(real.body, fake.body, 'body must not reveal existence either');
  });

  test("Alice's household and order lists contain only her own", async () => {
    const household = await req(h, 'GET', '/api/me/household', { token: alice.token });
    assert.equal(bodyOf(household)['household'].accountId, alice.accountId);
    assert.notEqual(bodyOf(household)['household'].id, bobHouseholdId);

    const orders = await req(h, 'GET', '/api/me/orders', { token: alice.token });
    for (const order of bodyOf(orders)['orders']) {
      assert.notEqual(order.id, bobOrderId, "Bob's order must never appear in Alice's list");
    }
  });

  test('a forged account id in the request body changes nothing', async () => {
    // Ownership is read from the database, so a payload claiming to be Bob
    // is simply ignored.
    const response = await req(h, 'POST', '/api/orders', {
      token: alice.token,
      body: { accountId: bob.accountId, householdId: bobHouseholdId },
    });
    assert.ok(response.status === 201 || response.status === 200);
    const created = bodyOf(response)['order'];
    assert.notEqual(created.householdId, bobHouseholdId, 'must not adopt the forged household');
    assert.equal(
      repo.findHousehold(h.ctx.db, created.householdId)!.accountId,
      alice.accountId,
    );
  });

  test('a tampered or absent session token is refused outright', async () => {
    for (const token of [null, '', 'not-a-token', bob.token.slice(0, -4) + 'aaaa']) {
      const response = await req(h, 'GET', '/api/me/orders', { token });
      assert.equal(response.status, 401, `token "${String(token).slice(0, 12)}" must be refused`);
    }
  });

  test('a signed-out session cannot be replayed', async () => {
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const carol = await createCustomer(h, adminToken, 'carol@example.test');
    const before = await req(h, 'GET', '/api/me/orders', { token: carol.token });
    assert.equal(before.status, 200);

    await req(h, 'POST', '/api/auth/sign-out', { token: carol.token });
    const after = await req(h, 'GET', '/api/me/orders', { token: carol.token });
    assert.equal(after.status, 401, 'a revoked session must stop working');
  });
});

describe('acceptance criterion 11: customers cannot reach staff or admin surfaces', () => {
  let h: Harness;
  let customerToken: string;

  before(async () => {
    h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    customerToken = (await createCustomer(h, adminToken, 'c-boundary@example.test')).token;
  });

  test('the catalog editor, program rules, and store records are all refused', async () => {
    const attempts: [string, string, unknown][] = [
      ['POST', '/api/admin/items', { item: { name: 'Free food', categoryKey: 'fruit', priceCents: 0, servingsPerPackageUnits: 400 } }],
      ['POST', '/api/admin/items/import', { csv: 'name,categoryKey,price,servingsPerPackage\nx,fruit,0,99', commit: true }],
      ['POST', '/api/admin/profiles', { profile: { name: 'Mine', daysCovered: 1, capAmountCents: 999999 } }],
      ['POST', '/api/admin/categories', { category: { key: 'candy', label: 'Candy' } }],
      ['GET', '/api/admin/audit', null],
      ['GET', '/api/admin/records/export', null],
      ['GET', '/api/admin/profiles', null],
      ['GET', '/api/staff/records', null],
      ['GET', '/api/staff/accounts', null],
      ['GET', '/api/staff/orders', null],
    ];

    for (const [method, path, body] of attempts) {
      const response = await req(h, method, path, { token: customerToken, body });
      assert.equal(response.status, 403, `${method} ${path} must be refused (got ${response.status})`);
    }
  });

  test('nothing the customer attempted actually changed the catalog or rules', async () => {
    assert.equal(
      repo.listItems(h.ctx.db).some((i) => i.name === 'Free food'),
      false,
    );
    assert.equal(repo.listCategories(h.ctx.db).some((c) => c.key === 'candy'), false);
    assert.equal(repo.listProfiles(h.ctx.db).some((p) => p.name === 'Mine'), false);
  });

  test('a customer may still browse the catalog with prices (NFR-5)', async () => {
    const response = await req(h, 'GET', '/api/items', { token: customerToken });
    assert.equal(response.status, 200);
    const items = bodyOf(response)['items'];
    assert.ok(items.length > 0);
    assert.ok(typeof items[0].priceCents === 'number', 'prices are part of the browse experience');
    assert.equal(items.every((i: Item) => i.active), true, 'but only active items');
  });
});

describe('acceptance criterion 12: assist mode names the staff member', () => {
  test('actions are audited to staff, not to the customer', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    await req(h, 'POST', '/api/staff/accounts', {
      token: adminToken,
      body: { role: 'staff', email: 'sam@store.test', password: 'sam-password-1', displayName: 'Sam Rivera' },
    });
    const staffToken = await signIn(h, 'sam@store.test', 'sam-password-1');
    const customer = await createCustomer(h, adminToken, 'c-assisted@example.test');
    const staffAccount = repo.findAccountByIdentifier(h.ctx.db, 'sam@store.test')!;

    const enter = await req(h, 'POST', `/api/staff/accounts/${customer.accountId}/assist`, {
      token: staffToken,
    });
    assert.equal(enter.status, 200);

    // Acting on the customer's data, using the staff session.
    const orderId = await buildCompliantOrder(h, staffToken);
    const household = repo.findHousehold(h.ctx.db, repo.findOrder(h.ctx.db, orderId)!.householdId)!;
    assert.equal(household.accountId, customer.accountId, 'the order belongs to the customer');

    const events = repo.listAuditEvents(h.ctx.db);
    const created = events.find((e) => e.action === 'order_created' && e.orderId === orderId)!;
    assert.ok(created, 'the order creation must be audited');
    assert.equal(created.actorAccountId, staffAccount.id, 'the actor must be the staff member');
    assert.notEqual(created.actorAccountId, customer.accountId, 'never the customer');
    assert.equal(created.onBehalfOfAccountId, customer.accountId);
    assert.ok(created.actor.includes('Sam Rivera'), 'the log should name the staff member');
    assert.ok(created.actor.includes('assist'), 'and mark it as assist mode');

    assert.ok(events.some((e) => e.action === 'assist_mode_started'));

    const leave = await req(h, 'POST', '/api/auth/end-assist', { token: staffToken });
    assert.equal(leave.status, 200);
    assert.ok(repo.listAuditEvents(h.ctx.db).some((e) => e.action === 'assist_mode_ended'));
  });

  test('a customer cannot enter assist mode on anyone', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const a = await createCustomer(h, adminToken, 'a-assist@example.test');
    const b = await createCustomer(h, adminToken, 'b-assist@example.test');

    const attempt = await req(h, 'POST', `/api/staff/accounts/${b.accountId}/assist`, {
      token: a.token,
    });
    assert.equal(attempt.status, 403);
  });
});

describe('acceptance criterion 13: a suspended account', () => {
  let h: Harness;
  let customer: { accountId: string; token: string };
  let pastOrderId: string;

  before(async () => {
    h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    customer = await createCustomer(h, adminToken, 'c-suspended@example.test');

    pastOrderId = await buildCompliantOrder(h, customer.token);
    await req(h, 'POST', `/api/orders/${pastOrderId}/finalize`, {
      token: customer.token,
      body: { staffInitials: '' },
    });

    const suspend = await req(h, 'POST', `/api/staff/accounts/${customer.accountId}/suspend`, {
      token: adminToken,
    });
    assert.equal(suspend.status, 200);
  });

  test('can still sign in', async () => {
    const token = await signIn(h, 'c-suspended@example.test', CUSTOMER_PASSWORD);
    assert.ok(token);
  });

  test('can still view past orders', async () => {
    const token = await signIn(h, 'c-suspended@example.test', CUSTOMER_PASSWORD);
    const history = await req(h, 'GET', '/api/me/orders', { token });
    assert.equal(history.status, 200);
    assert.ok(bodyOf(history)['orders'].some((o: { id: string }) => o.id === pastOrderId));

    const single = await req(h, 'GET', `/api/orders/${pastOrderId}`, { token });
    assert.equal(single.status, 200);
  });

  test('cannot start a new order', async () => {
    const token = await signIn(h, 'c-suspended@example.test', CUSTOMER_PASSWORD);
    const response = await req(h, 'POST', '/api/orders', { token });
    assert.equal(response.status, 403);
    assert.equal(bodyOf(response)['code'], 'suspended');
    assert.ok(String(bodyOf(response)['error']).includes('suspended'));
  });

  test('reinstating restores ordering', async () => {
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    await req(h, 'POST', `/api/staff/accounts/${customer.accountId}/reinstate`, { token: adminToken });
    const token = await signIn(h, 'c-suspended@example.test', CUSTOMER_PASSWORD);
    const response = await req(h, 'POST', '/api/orders', { token });
    assert.ok(response.status === 201 || response.status === 200);
  });
});

describe('acceptance criterion 3: over the cap needs a recorded override', () => {
  let h: Harness;
  let customer: { accountId: string; token: string };
  let staffToken: string;
  let orderId: string;

  before(async () => {
    h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    await req(h, 'POST', '/api/staff/accounts', {
      token: adminToken,
      body: { role: 'staff', email: 'til@store.test', password: 'till-password-1', displayName: 'Tilly' },
    });
    staffToken = await signIn(h, 'til@store.test', 'till-password-1');
    customer = await createCustomer(h, adminToken, 'c-overcap@example.test');

    orderId = await buildCompliantOrder(h, customer.token);
    // Push it well past the $285 cap.
    const items = repo.listItems(h.ctx.db, true);
    const order = repo.findOrder(h.ctx.db, orderId)!;
    const lines = order.lines.map((l) => ({ itemId: l.itemId, qty: l.qty }));
    const pricey = items.reduce((a, b) => (a.priceCents >= b.priceCents ? a : b));
    lines.push({ itemId: pricey.id, qty: 60 });
    const put = await req(h, 'PUT', `/api/orders/${orderId}/lines`, { token: customer.token, body: { lines } });
    assert.equal(put.status, 200);
    assert.equal(bodyOf(put)['compliance'].overCap, true, 'the fixture must be over the cap');
  });

  test('the customer cannot finalize it and cannot override it themselves', async () => {
    const response = await req(h, 'POST', `/api/orders/${orderId}/finalize`, {
      token: customer.token,
      body: { staffInitials: 'ZZ', overrideReason: 'I want it anyway' },
    });
    assert.equal(response.status, 422);
    assert.equal(repo.findOrder(h.ctx.db, orderId)!.status, 'draft');
  });

  test('staff cannot finalize it without a reason', async () => {
    const response = await req(h, 'POST', `/api/orders/${orderId}/finalize`, {
      token: staffToken,
      body: { staffInitials: 'TR' },
    });
    assert.equal(response.status, 422);
    assert.ok(String(bodyOf(response)['error']).includes('override'));
    assert.equal(repo.findOrder(h.ctx.db, orderId)!.status, 'draft');
  });

  test('staff finalize with a reason, and it is recorded with initials', async () => {
    const response = await req(h, 'POST', `/api/orders/${orderId}/finalize`, {
      token: staffToken,
      body: { staffInitials: 'TR', overrideReason: 'Supervisor approved: replacing spoiled delivery.' },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const stored = repo.findOrder(h.ctx.db, orderId)!;
    assert.equal(stored.status, 'final');
    assert.equal(stored.override!.reason, 'Supervisor approved: replacing spoiled delivery.');
    assert.equal(stored.override!.staffInitials, 'TR');
    assert.ok(stored.override!.violations.includes('over_cap'), 'the violation is recorded too');
    assert.ok(stored.override!.at);

    // FR-18: overrides are reported to admin through the audit log.
    const events = repo.listAuditEvents(h.ctx.db);
    const override = events.find((e) => e.action === 'override_applied' && e.orderId === orderId);
    assert.ok(override, 'the override must reach the audit log');
    assert.equal(override!.detail['staffInitials'], 'TR');
  });
});

describe('the server does not trust the client', () => {
  let h: Harness;
  let customer: { accountId: string; token: string };

  before(async () => {
    h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    customer = await createCustomer(h, adminToken, 'c-tamper@example.test');
  });

  test('a price sent by the client is ignored; the catalog price is used', async () => {
    const start = await req(h, 'POST', '/api/orders', { token: customer.token });
    const orderId = bodyOf(start)['order'].id as string;
    const item = repo.listItems(h.ctx.db, true).find((i) => i.priceCents > 0)!;

    const response = await req(h, 'PUT', `/api/orders/${orderId}/lines`, {
      token: customer.token,
      body: {
        lines: [
          {
            itemId: item.id,
            qty: 2,
            unitPriceCentsSnapshot: 1,
            servingsUnitsSnapshot: servingsToUnits(9999),
            categorySnapshot: 'fruit',
          },
        ],
      },
    });
    assert.equal(response.status, 200);
    const line = bodyOf(response)['order'].lines[0];
    assert.equal(line.unitPriceCentsSnapshot, item.priceCents, 'price comes from the catalog');
    assert.equal(line.servingsUnitsSnapshot, item.servingsPerPackageUnits, 'so do the servings');
    assert.equal(line.categorySnapshot, item.categoryKey);
    assert.equal(bodyOf(response)['order'].totalCents, item.priceCents * 2);
  });

  test('a fabricated item id is rejected', async () => {
    const start = await req(h, 'POST', '/api/orders', { token: customer.token });
    const orderId = bodyOf(start)['order'].id as string;
    const response = await req(h, 'PUT', `/api/orders/${orderId}/lines`, {
      token: customer.token,
      body: { lines: [{ itemId: 'item_invented', qty: 1 }] },
    });
    assert.equal(response.status, 400);
  });

  test('fractional and negative quantities are rejected', async () => {
    const start = await req(h, 'POST', '/api/orders', { token: customer.token });
    const orderId = bodyOf(start)['order'].id as string;
    const item = repo.listItems(h.ctx.db, true)[0]!;
    for (const qty of [2.5, -3]) {
      const response = await req(h, 'PUT', `/api/orders/${orderId}/lines`, {
        token: customer.token,
        body: { lines: [{ itemId: item.id, qty }] },
      });
      assert.equal(response.status, 400, `qty ${qty} must be rejected`);
    }
  });

  test('a finalized order cannot be edited afterwards', async () => {
    const orderId = await buildCompliantOrder(h, customer.token);
    await req(h, 'POST', `/api/orders/${orderId}/finalize`, {
      token: customer.token,
      body: { staffInitials: '' },
    });
    const item = repo.listItems(h.ctx.db, true)[0]!;
    const response = await req(h, 'PUT', `/api/orders/${orderId}/lines`, {
      token: customer.token,
      body: { lines: [{ itemId: item.id, qty: 1 }] },
    });
    assert.equal(response.status, 409);
  });

  test('duplicate item ids are rejected rather than bypassing variety rules', async () => {
    const start = await req(h, 'POST', '/api/orders', { token: customer.token });
    const orderId = bodyOf(start)['order'].id as string;
    const item = repo.listItems(h.ctx.db, true)[0]!;
    const response = await req(h, 'PUT', `/api/orders/${orderId}/lines`, {
      token: customer.token,
      body: { lines: [{ itemId: item.id, qty: 1 }, { itemId: item.id, qty: 1 }] },
    });
    assert.equal(response.status, 400);
  });
});

describe('acceptance criterion 5: a price change cannot alter a finalized order', () => {
  test('the stored total and line prices survive a catalog edit', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const customer = await createCustomer(h, adminToken, 'c-price@example.test');

    const orderId = await buildCompliantOrder(h, customer.token);
    const finalize = await req(h, 'POST', `/api/orders/${orderId}/finalize`, {
      token: customer.token,
      body: { staffInitials: '' },
    });
    assert.equal(finalize.status, 200);
    const totalBefore = bodyOf(finalize)['order'].totalCents as number;
    const linesBefore = JSON.stringify(bodyOf(finalize)['order'].lines);

    // Admin doubles every price in the catalog.
    for (const item of repo.listItems(h.ctx.db)) {
      const response = await req(h, 'POST', '/api/admin/items', {
        token: adminToken,
        body: { item: { ...item, priceCents: item.priceCents * 2 } },
      });
      assert.equal(response.status, 200);
    }

    const after = repo.findOrder(h.ctx.db, orderId)!;
    assert.equal(after.totalCents, totalBefore, 'the finalized total must not move');
    assert.equal(JSON.stringify(after.lines), linesBefore, 'nor any captured line price');

    // NFR-6: and every price change is on the audit log.
    const priceEvents = repo.listAuditEvents(h.ctx.db).filter((e) => e.action === 'price_changed');
    assert.ok(priceEvents.length > 0);
    assert.ok(typeof priceEvents[0]!.detail['fromCents'] === 'number');
  });
});

describe('NFR-4: rate limiting and lockout', () => {
  test('an account locks after repeated failures and staff can clear it', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const customer = await createCustomer(h, adminToken, 'c-lock@example.test');

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      const response = await req(h, 'POST', '/api/auth/sign-in', {
        body: { identifier: 'c-lock@example.test', password: 'wrong-guess' },
        ip: `10.0.1.${i}`,
      });
      assert.equal(response.status, 401);
    }

    // Even the correct password is refused while locked.
    const locked = await req(h, 'POST', '/api/auth/sign-in', {
      body: { identifier: 'c-lock@example.test', password: CUSTOMER_PASSWORD },
      ip: '10.0.2.1',
    });
    assert.equal(locked.status, 423);

    const unlock = await req(h, 'POST', `/api/staff/accounts/${customer.accountId}/unlock`, {
      token: adminToken,
    });
    assert.equal(unlock.status, 200);

    const after = await req(h, 'POST', '/api/auth/sign-in', {
      body: { identifier: 'c-lock@example.test', password: CUSTOMER_PASSWORD },
      ip: '10.0.2.2',
    });
    assert.equal(after.status, 200, 'a staff unlock must restore access');
  });

  test('one IP is throttled regardless of which identifier it guesses', async () => {
    const h = await makeHarness();
    let throttled = false;
    for (let i = 0; i < 15; i++) {
      const response = await req(h, 'POST', '/api/auth/sign-in', {
        body: { identifier: `guess-${i}@example.test`, password: 'x' },
        ip: '198.51.100.7',
      });
      if (response.status === 429) {
        throttled = true;
        break;
      }
    }
    assert.equal(throttled, true, 'a single IP must eventually be rate limited');
  });

  test('sign-in does not reveal which identifiers are registered', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    await createCustomer(h, adminToken, 'c-known@example.test');

    const known = await req(h, 'POST', '/api/auth/sign-in', {
      body: { identifier: 'c-known@example.test', password: 'wrong-password' },
      ip: '203.0.113.1',
    });
    const unknown = await req(h, 'POST', '/api/auth/sign-in', {
      body: { identifier: 'nobody@example.test', password: 'wrong-password' },
      ip: '203.0.113.2',
    });
    assert.equal(known.status, unknown.status);
    assert.deepEqual(known.body, unknown.body);
  });

  test('a reset request answers the same whether or not the account exists', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    await createCustomer(h, adminToken, 'c-reset@example.test');

    const real = await req(h, 'POST', '/api/auth/request-reset', {
      body: { identifier: 'c-reset@example.test' },
      ip: '203.0.113.10',
    });
    const fake = await req(h, 'POST', '/api/auth/request-reset', {
      body: { identifier: 'ghost@example.test' },
      ip: '203.0.113.11',
    });
    assert.equal(real.status, fake.status);
    assert.deepEqual(real.body, fake.body);
    // But a code was only actually issued for the real one.
    assert.equal(h.codes.length, 1);
    assert.equal(h.codes[0]!.to, 'c-reset@example.test');
  });
});

describe('FR-A3/FR-A4: one-time codes', () => {
  test('a code signs the customer in and cannot be reused', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    await createCustomer(h, adminToken, 'c-otp@example.test');

    await req(h, 'POST', '/api/auth/request-code', { body: { identifier: 'c-otp@example.test' } });
    const code = h.codes.find((c) => c.purpose === 'sign_in')!.code;
    assert.match(code, /^\d{6}$/);

    const first = await req(h, 'POST', '/api/auth/verify-code', {
      body: { identifier: 'c-otp@example.test', code },
    });
    assert.equal(first.status, 200);
    assert.ok(first.sessionToken);

    const replay = await req(h, 'POST', '/api/auth/verify-code', {
      body: { identifier: 'c-otp@example.test', code },
    });
    assert.equal(replay.status, 401, 'a code is single use');
  });

  test('a wrong code is refused', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    await createCustomer(h, adminToken, 'c-otp2@example.test');
    await req(h, 'POST', '/api/auth/request-code', { body: { identifier: 'c-otp2@example.test' } });

    const response = await req(h, 'POST', '/api/auth/verify-code', {
      body: { identifier: 'c-otp2@example.test', code: '000000' },
    });
    assert.equal(response.status, 401);
  });

  test('a completed password reset revokes existing sessions (NFR-9)', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const customer = await createCustomer(h, adminToken, 'c-reset2@example.test');

    const live = await req(h, 'GET', '/api/me/orders', { token: customer.token });
    assert.equal(live.status, 200);

    await req(h, 'POST', '/api/auth/request-reset', { body: { identifier: 'c-reset2@example.test' } });
    const code = h.codes.find((c) => c.purpose === 'password_reset')!.code;
    const reset = await req(h, 'POST', '/api/auth/reset', {
      body: { identifier: 'c-reset2@example.test', code, newPassword: 'a-brand-new-password' },
    });
    assert.equal(reset.status, 200);

    const afterwards = await req(h, 'GET', '/api/me/orders', { token: customer.token });
    assert.equal(afterwards.status, 401, 'the old session must be dead');
    await signIn(h, 'c-reset2@example.test', 'a-brand-new-password');
  });

  test('a short password is refused', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    await createCustomer(h, adminToken, 'c-short@example.test');
    await req(h, 'POST', '/api/auth/request-reset', { body: { identifier: 'c-short@example.test' } });
    const code = h.codes.find((c) => c.purpose === 'password_reset')!.code;

    const response = await req(h, 'POST', '/api/auth/reset', {
      body: { identifier: 'c-short@example.test', code, newPassword: 'short' },
    });
    assert.equal(response.status, 400);
  });
});

describe('FR-34 / FR-2: records and profile versioning', () => {
  test('admin can search and export records as CSV', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const customer = await createCustomer(h, adminToken, 'c-records@example.test');
    const orderId = await buildCompliantOrder(h, customer.token);
    await req(h, 'POST', `/api/orders/${orderId}/finalize`, {
      token: customer.token,
      body: { staffInitials: '' },
    });

    const search = await req(h, 'GET', '/api/staff/records', {
      token: adminToken,
      query: { referralId: 'REF-c-records@example.test' },
    });
    assert.equal(search.status, 200);
    assert.equal(bodyOf(search)['orders'].length, 1);

    const csv = await req(h, 'GET', '/api/admin/records/export', { token: adminToken });
    assert.equal(csv.status, 200);
    assert.equal(csv.headers?.['content-type'], 'text/csv; charset=utf-8');
    const text = csv.body as string;
    assert.ok(text.includes('referral_id'), 'the export carries the referral id column');
    assert.ok(text.includes('REF-c-records@example.test'));
    assert.ok(text.includes('required_servings'));

    assert.ok(repo.listAuditEvents(h.ctx.db).some((e) => e.action === 'records_exported'));
  });

  test('a new profile version does not disturb an order already finalized', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const customer = await createCustomer(h, adminToken, 'c-version@example.test');
    const orderId = await buildCompliantOrder(h, customer.token);
    await req(h, 'POST', `/api/orders/${orderId}/finalize`, {
      token: customer.token,
      body: { staffInitials: '' },
    });
    const before = repo.findOrder(h.ctx.db, orderId)!;

    const profile = repo.findProfile(h.ctx.db, 'profile-default-v1')!;
    const response = await req(h, 'POST', '/api/admin/profiles', {
      token: adminToken,
      body: {
        newVersion: true,
        profile: {
          ...profile,
          capAmountCents: 5000,
          daysCovered: 14,
          effectiveFrom: '2026-09-01',
        },
      },
    });
    assert.equal(response.status, 201);
    assert.equal(bodyOf(response)['profile'].version, 2);

    const after = repo.findOrder(h.ctx.db, orderId)!;
    assert.deepEqual(after.rulesSnapshot, before.rulesSnapshot, 'the snapshot is frozen');
    assert.equal(after.rulesSnapshot.capTotalCents, 28500);
    assert.equal(after.rulesSnapshot.daysCovered, 7);
    // The previous version is closed out rather than deleted.
    assert.equal(repo.findProfile(h.ctx.db, 'profile-default-v1')!.effectiveTo, '2026-09-01');
  });

  test('a mathematical edit versions the profile even if the client asks for an in-place save', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const profile = repo.findProfile(h.ctx.db, 'profile-default-v1')!;
    const response = await req(h, 'POST', '/api/admin/profiles', {
      token: adminToken,
      body: {
        newVersion: false,
        profile: { ...profile, capAmountCents: profile.capAmountCents + 100, effectiveFrom: '2026-09-01' },
      },
    });
    assert.equal(response.status, 201);
    assert.equal(bodyOf(response)['profile'].version, 2);
    assert.equal(repo.findProfile(h.ctx.db, profile.id)!.capAmountCents, profile.capAmountCents);
  });

  test('deactivating catalog categories cannot make an empty order qualify', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    for (const category of repo.listCategories(h.ctx.db)) {
      const response = await req(h, 'POST', '/api/admin/categories', {
        token: adminToken,
        body: { category: { ...category, active: false } },
      });
      assert.equal(response.status, 200);
    }
    const customer = await createCustomer(h, adminToken, 'inactive-categories@store.test');
    const start = await req(h, 'POST', '/api/orders', { token: customer.token });
    const order = bodyOf(start)['order'];
    assert.ok(order.rulesSnapshot.categories.length > 0, 'requirements must remain in the snapshot');
    const finalized = await req(h, 'POST', `/api/orders/${order.id}/finalize`, {
      token: customer.token,
      body: {},
    });
    assert.equal(finalized.status, 422);
  });

  test('an invalid profile is refused with a reason', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const profile = repo.findProfile(h.ctx.db, 'profile-default-v1')!;

    const response = await req(h, 'POST', '/api/admin/profiles', {
      token: adminToken,
      body: { profile: { ...profile, daysCovered: 0 } },
    });
    assert.equal(response.status, 400);
    assert.ok(String(bodyOf(response)['error']).length > 0);
  });
});

describe('acceptance criterion 1, through the API', () => {
  test('the seeded profile yields 42/63/63/84 servings and a $285 cap', async () => {
    const h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    const customer = await createCustomer(h, adminToken, 'c-ac1@example.test', { memberCount: 3 });

    const start = await req(h, 'POST', '/api/orders', { token: customer.token });
    const snapshot = bodyOf(start)['order'].rulesSnapshot;

    assert.equal(snapshot.capTotalCents, 28500);
    assert.equal(snapshot.requiredUnitsByCategory.fruit, servingsToUnits(42));
    assert.equal(snapshot.requiredUnitsByCategory.vegetable, servingsToUnits(63));
    assert.equal(snapshot.requiredUnitsByCategory.protein, servingsToUnits(63));
    assert.equal(snapshot.requiredUnitsByCategory.starch, servingsToUnits(84));
  });
});

describe('section 5: concurrent edits warn only on a real conflict', () => {
  let h: Harness;
  let customer: { accountId: string; token: string };
  let orderId: string;
  let itemA: string;
  let itemB: string;

  before(async () => {
    h = await makeHarness();
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    customer = await createCustomer(h, adminToken, 'c-conflict@example.test');
    const start = await req(h, 'POST', '/api/orders', { token: customer.token });
    orderId = bodyOf(start)['order'].id;
    const items = repo.listItems(h.ctx.db, true);
    itemA = items[0]!.id;
    itemB = items[1]!.id;
  });

  test('one person tapping faster than the round trip is not a conflict', async () => {
    // Both writes carry the same stale base revision, as a fast double tap does.
    const first = await req(h, 'PUT', `/api/orders/${orderId}/lines`, {
      token: customer.token,
      body: { lines: [{ itemId: itemA, qty: 1 }], baseRevision: 1 },
    });
    assert.equal(first.status, 200);

    const second = await req(h, 'PUT', `/api/orders/${orderId}/lines`, {
      token: customer.token,
      body: { lines: [{ itemId: itemA, qty: 2 }], baseRevision: 1 },
    });
    assert.equal(second.status, 200);
    assert.equal(bodyOf(second)['conflict'], null, 'the same writer must not be warned');
    assert.equal(bodyOf(second)['order'].lines[0].qty, 2, 'last write still wins');
  });

  test('a second person editing the same draft does warn', async () => {
    const adminToken = await signIn(h, ADMIN_EMAIL, ADMIN_PASSWORD);
    await req(h, 'POST', '/api/staff/accounts', {
      token: adminToken,
      body: { role: 'staff', email: 'two@store.test', password: 'staff-password-2', displayName: 'Pat' },
    });
    const staffToken = await signIn(h, 'two@store.test', 'staff-password-2');

    const stale = repo.findOrder(h.ctx.db, orderId)!.revision - 1;
    const response = await req(h, 'PUT', `/api/orders/${orderId}/lines`, {
      token: staffToken,
      body: { lines: [{ itemId: itemB, qty: 5 }], baseRevision: stale },
    });
    assert.equal(response.status, 200);
    assert.ok(bodyOf(response)['conflict'], 'a different writer must be warned');
    // Section 5: last write still wins.
    assert.equal(bodyOf(response)['order'].lines[0].itemId, itemB);
  });
});
