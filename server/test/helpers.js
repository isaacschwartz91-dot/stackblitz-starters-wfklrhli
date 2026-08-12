import './setup.js';

import { createApp } from '../src/app.js';
import { closePool, pool } from '../src/db/pool.js';
import { up } from '../src/db/migrate.js';
import { signToken } from '../src/middleware/auth.js';
import * as users from '../src/repositories/userRepository.js';
import { clearSettingsCache } from '../src/services/settingsService.js';

const TABLES = [
  'notifications',
  'proof_of_delivery',
  'order_status_events',
  'scan_events',
  'order_assignment_events',
  'orders',
  'order_import_batches',
  'app_settings',
  'users',
];

let migrated = false;

export async function migrateOnce() {
  if (migrated) return;
  // Silence the migration runner's progress output during tests.
  const log = console.log;
  console.log = () => {};
  try {
    await up();
  } finally {
    console.log = log;
  }
  migrated = true;
}

export async function resetDatabase() {
  await migrateOnce();
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  // Settings are cached in-process; truncating the table alone would leave a
  // previous test's toggles live.
  clearSettingsCache();
}

export async function teardown() {
  await closePool();
}

/** Starts the app on an ephemeral port and returns a client bound to it. */
export async function startTestServer() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let userCounter = 0;

export async function createTestUser({ role = 'admin', email, fullName, password = 'password123' } = {}) {
  userCounter += 1;
  const user = await users.create({
    email: email ?? `${role}${userCounter}@test.local`,
    fullName: fullName ?? `Test ${role} ${userCounter}`,
    role,
    password,
    phone: null,
  });
  return { ...user, token: signToken(user), password };
}

/**
 * Thin fetch wrapper. Returns { status, body } so assertions read cleanly, and
 * parses JSON only when the response actually is JSON (labels return HTML,
 * barcodes return PNG).
 */
export function apiClient(baseUrl, token) {
  async function request(method, path, { body, token: overrideToken, raw = false, headers = {} } = {}) {
    const authToken = overrideToken ?? token;
    const isFormData = body instanceof FormData;

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        ...(body && !isFormData ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: isFormData ? body : body ? JSON.stringify(body) : undefined,
    });

    if (raw) return { status: response.status, response };

    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    return { status: response.status, body: payload, headers: response.headers };
  }

  return {
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
    patch: (path, body, options) => request('PATCH', path, { ...options, body }),
    del: (path, options) => request('DELETE', path, options),
    request,
  };
}

/** Minimal valid order payload; override any field per test. */
export function orderPayload(overrides = {}) {
  return {
    orderRef: `ORD-${Math.floor(Math.random() * 1_000_000)}`,
    customerName: 'Dana Whitfield',
    customerPhone: '+15551234567',
    addressLine1: '84 Alder Street',
    city: 'Springfield',
    postalCode: '62704',
    deliveryZone: 'NORTH',
    ...overrides,
  };
}
