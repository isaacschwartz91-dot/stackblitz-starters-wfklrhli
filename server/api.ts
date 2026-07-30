/**
 * API routes.
 *
 * `handle()` is a plain function from request to response so the whole API
 * can be driven directly in tests — which is what AC-10 demands: the
 * cross-customer refusal has to be proven against the server, not the UI.
 *
 * Two rules run through every mutating route:
 *   1. Ownership comes from the database (authz.ts), never from the payload.
 *   2. Money and servings come from the catalog, never from the payload. A
 *      client that posts its own price is ignored, because the price on a
 *      reimbursement claim cannot be attacker-controlled.
 */

import { createHmac } from 'node:crypto';

import type {
  Account,
  AuditAction,
  DietaryTag,
  Household,
  Item,
  MealPlan,
  Order,
  OrderLine,
  Principal,
  ProgramProfile,
} from '../src/shared/types';
import { DIETARY_TAGS, SHELF_LIFE_CLASSES } from '../src/shared/types';
import { evaluateOrder } from '../src/shared/compliance/engine';
import { generateMealPlan, hashOrderLines } from '../src/shared/mealplan/planner';
import {
  validateHouseholdInput,
  validateProfile,
  validateQuantity,
  requiresNewVersion,
} from '../src/shared/validation';
import { importCatalogRows, exportCatalogCsv, parseCsv, toCsv, inferColumnMapping } from '../src/shared/csv';
import { centsToPlain, unitsToServings } from '../src/shared/units';
import { newId } from '../src/shared/ids';

import type { Db } from './db';
import { transact } from './db';
import * as repo from './repo';
import {
  authenticate,
  authorizeOrder,
  requireAdmin,
  requireNotSuspended,
  requireStaff,
  type Denial,
  type Guard,
} from './authz';
import {
  checkRateLimit,
  clearRateLimit,
  dummyVerify,
  generateOtp,
  hashOtp,
  hashPassword,
  issueToken,
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  otpMatches,
  RESET_RATE_LIMIT,
  SIGN_IN_RATE_LIMIT,
  verifyPassword,
} from './security';

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  /** Bearer token or session cookie value. */
  token: string | null;
  ip: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Set to issue or clear the session cookie. */
  sessionToken?: string | null;
}

export interface ApiContext {
  db: Db;
  now: () => number;
  /**
   * FR-A3/FR-A4 delivery of one-time codes. The default transport writes to
   * the server log; a real email/SMS provider must be wired before launch.
   */
  deliverCode: (
    to: { email: string | null; phone: string | null },
    code: string,
    purpose: string,
  ) => void | Promise<void>;
  /** Required in production; used to make audit records tamper-evident. */
  auditKey?: string;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // FR-A5: 30 minutes of inactivity.
const SESSION_MAX_TTL_MS = 12 * 60 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

const json = (status: number, body: unknown, headers?: Record<string, string>): ApiResponse => ({
  status,
  body,
  headers,
});
const fromDenial = (denial: Denial): ApiResponse =>
  json(denial.status, { error: denial.message, code: denial.code });

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null;

function audit(
  ctx: ApiContext,
  action: AuditAction,
  detail: Record<string, unknown>,
  options: { orderId?: string | null; principal?: Principal; actor?: string } = {},
): void {
  const principal = options.principal;
  // FR-A6: in assist mode the actor is the staff member, never the customer.
  const actorAccountId = principal?.account.id ?? null;
  const onBehalfOf = principal?.assistMode ? principal.effectiveAccountId : null;
  const actorLabel =
    options.actor ??
    (principal
      ? `${principal.account.role}:${principal.account.displayName || principal.account.id}${
          principal.assistMode ? ' (assist)' : ''
        }`
      : 'anonymous');

  const at = new Date(ctx.now()).toISOString();
  const detailJson = JSON.stringify(detail);
  const previousHash = (
    ctx.db
      .prepare('SELECT integrity_hash FROM audit_events WHERE integrity_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1')
      .get() as { integrity_hash?: string } | undefined
  )?.integrity_hash ?? null;
  const unsigned = JSON.stringify({
    previousHash,
    orderId: options.orderId ?? null,
    actor: actorLabel,
    actorAccountId,
    onBehalfOf,
    action,
    detail: detailJson,
    at,
  });
  const auditKey = ctx.auditKey ?? process.env['AUDIT_SIGNING_KEY'] ?? 'development-only-audit-key';
  const integrityHash = createHmac('sha256', auditKey).update(unsigned).digest('hex');

  ctx.db
    .prepare(
      `INSERT INTO audit_events (id, order_id, actor, actor_account_id,
        on_behalf_of_account_id, action, detail_json, at, prev_hash, integrity_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      newId('audit'),
      options.orderId ?? null,
      actorLabel,
      actorAccountId,
      onBehalfOf,
      action,
      detailJson,
      at,
      previousHash,
      integrityHash,
    );
}

/** Accounts are returned without any secret material, ever. */
function publicAccount(account: Account): Omit<Account, never> {
  return { ...account };
}

// --- sessions -------------------------------------------------------------

function createSession(
  ctx: ApiContext,
  accountId: string,
  actingAsAccountId: string | null = null,
): string {
  const { token, tokenHash } = issueToken();
  const now = ctx.now();
  ctx.db
    .prepare(
      `INSERT INTO sessions (id, account_id, issued_at, expires_at, revoked_at, acting_as_account_id)
       VALUES (?,?,?,?,NULL,?)`,
    )
    .run(
      tokenHash,
      accountId,
      new Date(now).toISOString(),
       new Date(Math.min(now + SESSION_TTL_MS, now + SESSION_MAX_TTL_MS)).toISOString(),
      actingAsAccountId,
    );
  ctx.db
    .prepare('UPDATE sessions SET max_expires_at = ? WHERE id = ?')
    .run(new Date(now + SESSION_MAX_TTL_MS).toISOString(), tokenHash);
  return token;
}

/** FR-A5: activity slides the expiry forward; inactivity lets it lapse. */
function touchSession(ctx: ApiContext, sessionId: string): void {
  const candidate = new Date(ctx.now() + SESSION_TTL_MS).toISOString();
  ctx.db
    .prepare(
      `UPDATE sessions
       SET expires_at = CASE
         WHEN max_expires_at IS NOT NULL AND max_expires_at < ? THEN max_expires_at
         ELSE ?
       END
       WHERE id = ?`,
    )
    .run(candidate, candidate, sessionId);
}

function auth(ctx: ApiContext, request: ApiRequest): Guard<Principal> {
  const result = authenticate(ctx.db, request.token, { now: ctx.now() });
  if (result.ok) touchSession(ctx, result.value.sessionId);
  return result;
}

// --- route table ----------------------------------------------------------

export async function handle(ctx: ApiContext, request: ApiRequest): Promise<ApiResponse> {
  const { method, path } = request;

  try {
    // Liveness probe for the host's health check. Deliberately reveals
    // nothing beyond the fact that the process is up.
    if (path === '/api/health' && method === 'GET') return json(200, { ok: true });

    // --- unauthenticated auth endpoints
    if (path === '/api/auth/sign-in' && method === 'POST') return await signIn(ctx, request);
    if (path === '/api/auth/request-code' && method === 'POST') return await requestCode(ctx, request, 'sign_in');
    if (path === '/api/auth/verify-code' && method === 'POST') return verifyCode(ctx, request);
    if (path === '/api/auth/request-reset' && method === 'POST') return await requestCode(ctx, request, 'password_reset');
    if (path === '/api/auth/reset' && method === 'POST') return await resetPassword(ctx, request);

    // --- everything below requires a valid session
    const principal = auth(ctx, request);
    if (!principal.ok) return fromDenial(principal);
    const me = principal.value;

    if (path === '/api/auth/me' && method === 'GET') return meResponse(ctx, me);
    if (path === '/api/auth/sign-out' && method === 'POST') return signOut(ctx, me);
    if (path === '/api/auth/end-assist' && method === 'POST') return endAssist(ctx, me);

    if (path === '/api/categories' && method === 'GET') {
      return json(200, { categories: repo.listCategories(ctx.db) });
    }
    if (path === '/api/items' && method === 'GET') {
      // NFR-5: customers may browse the full catalog with prices. They see
      // only active items; staff see everything including deactivated ones.
      const staff = me.account.role !== 'customer';
      return json(200, { items: repo.listItems(ctx.db, !staff) });
    }
    if (path === '/api/items/lookup' && method === 'GET') {
      const upc = request.query.get('upc') ?? '';
      const item = repo.findItemByUpc(ctx.db, upc);
      return item ? json(200, { item }) : json(404, { error: 'No item matches that code.' });
    }

    if (path === '/api/me/household' && method === 'GET') {
      const household = repo.findHouseholdByAccount(ctx.db, me.effectiveAccountId);
      return json(200, { household });
    }
    if (path === '/api/me/orders' && method === 'GET') {
      // FR-A8: a customer's own history, scoped by account at the query.
      return json(200, { orders: repo.listOrdersForAccount(ctx.db, me.effectiveAccountId) });
    }

    if (path === '/api/orders' && method === 'POST') return startOrder(ctx, me);

    const orderMatch = path.match(/^\/api\/orders\/([^/]+)(\/[a-z-]+)?$/);
    if (orderMatch) {
      const orderId = decodeURIComponent(orderMatch[1]!);
      const sub = orderMatch[2] ?? '';
      const guard = authorizeOrder(ctx.db, me, orderId);
      if (!guard.ok) {
        audit(ctx, 'authorization_denied', { path, orderId }, { principal: me });
        return fromDenial(guard);
      }
      const order = guard.value;

      if (sub === '' && method === 'GET') return json(200, { order });
      if (sub === '/lines' && method === 'PUT') return setLines(ctx, me, order, request);
      if (sub === '/finalize' && method === 'POST') return finalizeOrder(ctx, me, order, request);
      if (sub === '/plan' && method === 'GET') {
        return json(200, { plan: planWithStaleness(ctx, order) });
      }
      if (sub === '/plan' && method === 'POST') return generatePlan(ctx, me, order, request);
      if (sub === '/compliance' && method === 'GET') {
        return json(200, { compliance: evaluateOrder(order.lines, order.rulesSnapshot) });
      }
      return json(405, { error: 'Method not allowed.' });
    }

    // --- staff and admin only from here (NFR-5, AC-11)
    if (path.startsWith('/api/admin/') || path.startsWith('/api/staff/')) {
      const staffGuard = requireStaff(me);
      if (!staffGuard.ok) {
        audit(ctx, 'authorization_denied', { path }, { principal: me });
        return fromDenial(staffGuard);
      }
    }

    if (path === '/api/staff/accounts' && method === 'GET') return listAccounts(ctx, me);
    if (path === '/api/staff/accounts' && method === 'POST') return await createAccount(ctx, me, request);
    if (path === '/api/staff/records' && method === 'GET') return searchRecords(ctx, me, request);
    if (path === '/api/staff/orders' && method === 'GET') {
      return json(200, { orders: repo.searchOrders(ctx.db, { status: 'draft' }) });
    }

    const accountMatch = path.match(/^\/api\/staff\/accounts\/([^/]+)\/([a-z-]+)$/);
    if (accountMatch && method === 'POST') {
      return await accountAction(
        ctx,
        me,
        decodeURIComponent(accountMatch[1]!),
        accountMatch[2]!,
        request,
      );
    }

    if (path === '/api/admin/profiles' && method === 'GET') {
      const guard = requireAdmin(me);
      if (!guard.ok) return fromDenial(guard);
      return json(200, { profiles: repo.listProfiles(ctx.db) });
    }
    if (path === '/api/admin/profiles' && method === 'POST') return saveProfile(ctx, me, request);
    if (path === '/api/admin/categories' && method === 'POST') return saveCategory(ctx, me, request);
    if (path === '/api/admin/items' && method === 'POST') return saveItem(ctx, me, request);
    if (path === '/api/admin/items/import' && method === 'POST') return importCatalog(ctx, me, request);
    if (path === '/api/admin/items/export' && method === 'GET') {
      const guard = requireAdmin(me);
      if (!guard.ok) return fromDenial(guard);
      return {
        status: 200,
        body: exportCatalogCsv(repo.listItems(ctx.db)),
        headers: { 'content-type': 'text/csv; charset=utf-8' },
      };
    }
    if (path === '/api/admin/records/export' && method === 'GET') return exportRecords(ctx, me, request);
    if (path === '/api/admin/audit' && method === 'GET') {
      const guard = requireAdmin(me);
      if (!guard.ok) return fromDenial(guard);
      return json(200, { events: repo.listAuditEvents(ctx.db) });
    }

    return json(404, { error: 'Not found.' });
  } catch (error) {
    // Never leak a stack trace or SQL text to a client.
    const message = error instanceof Error ? error.message : String(error);
    console.error('[api] unhandled error', request.method, request.path, message);
    return json(500, { error: 'Something went wrong.' });
  }
}

// --- auth handlers --------------------------------------------------------

async function signIn(ctx: ApiContext, request: ApiRequest): Promise<ApiResponse> {
  const body = asRecord(request.body);
  const identifier = asString(body['identifier']).trim();
  const password = asString(body['password']);

  // NFR-4: limit by IP and by identifier, so neither a single address nor a
  // single targeted account can be hammered.
  for (const bucket of [`signin:ip:${request.ip}`, `signin:id:${identifier.toLowerCase()}`]) {
    const limit = checkRateLimit(ctx.db, bucket, SIGN_IN_RATE_LIMIT, ctx.now());
    if (!limit.allowed) {
      return json(429, {
        error: 'Too many attempts. Try again later.',
        retryAfterMs: limit.retryAfterMs,
      });
    }
  }

  const account = repo.findAccountByIdentifier(ctx.db, identifier);
  if (!account) {
    // Same work and the same answer as a wrong password, so the response
    // cannot be used to discover which identifiers are registered.
    await dummyVerify();
    audit(ctx, 'sign_in_failed', { identifier, reason: 'unknown_identifier' });
    return json(401, { error: 'That sign-in was not recognised.' });
  }
  if (account.status === 'suspended' && account.role !== 'customer') {
    audit(ctx, 'sign_in_failed', { accountId: account.id, reason: 'suspended_staff' });
    return json(403, { error: 'This staff account is suspended.' });
  }

  const secrets = repo.accountSecrets(ctx.db, account.id);
  const now = ctx.now();
  if (secrets?.lockedUntil && Date.parse(secrets.lockedUntil) > now) {
    return json(423, {
      error: 'This account is locked. Store staff can unlock it for you.',
      lockedUntil: secrets.lockedUntil,
    });
  }

  const valid = await verifyPassword(password, secrets?.passwordHash ?? null);
  if (!valid) {
    const attempts = (secrets?.failedAttempts ?? 0) + 1;
    const locked = attempts >= MAX_FAILED_ATTEMPTS;
    ctx.db
      .prepare('UPDATE accounts SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .run(attempts, locked ? new Date(now + LOCKOUT_MS).toISOString() : null, account.id);
    audit(ctx, 'sign_in_failed', { accountId: account.id, attempts }, {});
    if (locked) audit(ctx, 'account_locked', { accountId: account.id, attempts }, {});
    return json(401, { error: 'That sign-in was not recognised.' });
  }

  ctx.db
    .prepare('UPDATE accounts SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
    .run(new Date(now).toISOString(), account.id);
  clearRateLimit(ctx.db, `signin:id:${identifier.toLowerCase()}`);

  const token = createSession(ctx, account.id);
  audit(ctx, 'sign_in', { accountId: account.id, method: 'password' }, {});
  return { status: 200, body: { account: publicAccount(account) }, sessionToken: token };
}

/** FR-A3/FR-A4: passwordless code, for sign-in or for a reset. */
async function requestCode(
  ctx: ApiContext,
  request: ApiRequest,
  purpose: 'sign_in' | 'password_reset',
): Promise<ApiResponse> {
  const body = asRecord(request.body);
  const identifier = asString(body['identifier']).trim();

  for (const bucket of [`otp:ip:${request.ip}`, `otp:id:${identifier.toLowerCase()}`]) {
    const limit = checkRateLimit(ctx.db, bucket, RESET_RATE_LIMIT, ctx.now());
    if (!limit.allowed) {
      return json(429, { error: 'Too many requests. Try again later.', retryAfterMs: limit.retryAfterMs });
    }
  }

  const account = repo.findAccountByIdentifier(ctx.db, identifier);
  // Always answer the same way, so this cannot enumerate accounts either.
  const generic = json(200, {
    sent: true,
    message: 'If that account exists, a code has been sent.',
  });
  if (!account) return generic;
  if (account.status === 'suspended' && account.role !== 'customer') return generic;

  const code = generateOtp();
  const now = ctx.now();
  try {
    await ctx.deliverCode({ email: account.email, phone: account.phone }, code, purpose);
  } catch {
    audit(ctx, 'otp_delivery_failed', { accountId: account.id, purpose });
    // Keep the indistinguishable response even during a provider outage.
    // Otherwise the outage itself becomes an account-enumeration oracle.
    return generic;
  }

  // Only the most recently delivered code is usable. This prevents a stale
  // email or SMS from becoming a second active credential.
  ctx.db
    .prepare('UPDATE otp_codes SET consumed_at = ? WHERE account_id = ? AND purpose = ? AND consumed_at IS NULL')
    .run(new Date(now).toISOString(), account.id, purpose);
  ctx.db
    .prepare(
      `INSERT INTO otp_codes (id, account_id, code_hash, purpose, expires_at, consumed_at, attempts, created_at)
       VALUES (?,?,?,?,?,NULL,0,?)`,
    )
    .run(
      newId('otp'),
      account.id,
      hashOtp(code),
      purpose,
      new Date(now + OTP_TTL_MS).toISOString(),
      new Date(now).toISOString(),
    );

  audit(ctx, 'otp_requested', {
    accountId: account.id,
    purpose,
  });
  return generic;
}

interface OtpCheck {
  ok: boolean;
  accountId?: string;
  response?: ApiResponse;
}

function consumeOtp(
  ctx: ApiContext,
  identifier: string,
  code: string,
  purpose: 'sign_in' | 'password_reset',
): OtpCheck {
  const account = repo.findAccountByIdentifier(ctx.db, identifier);
  const invalid = json(401, { error: 'That code is not valid.' });
  if (!account) return { ok: false, response: invalid };
  if (account.status === 'suspended' && account.role !== 'customer') {
    return { ok: false, response: json(403, { error: 'This staff account is suspended.' }) };
  }

  const row = ctx.db
    .prepare(
      `SELECT * FROM otp_codes WHERE account_id = ? AND purpose = ? AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(account.id, purpose) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, response: invalid };

  const expiresAt = String(row['expires_at']);
  const attempts = Number(row['attempts'] ?? 0);
  if (Date.parse(expiresAt) <= ctx.now() || attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, response: invalid };
  }

  if (!otpMatches(code, String(row['code_hash']))) {
    ctx.db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row['id']);
    return { ok: false, response: invalid };
  }

  // Single use: burn it whether or not what follows succeeds.
  ctx.db
    .prepare('UPDATE otp_codes SET consumed_at = ? WHERE id = ?')
    .run(new Date(ctx.now()).toISOString(), row['id']);
  return { ok: true, accountId: account.id };
}

function verifyCode(ctx: ApiContext, request: ApiRequest): ApiResponse {
  const body = asRecord(request.body);
  const identifier = asString(body['identifier']);
  for (const bucket of [`otpverify:ip:${request.ip}`, `otpverify:id:${identifier.trim().toLowerCase()}`]) {
    const limit = checkRateLimit(ctx.db, bucket, SIGN_IN_RATE_LIMIT, ctx.now());
    if (!limit.allowed) return json(429, { error: 'Too many attempts. Try again later.' });
  }

  const check = consumeOtp(ctx, identifier, asString(body['code']), 'sign_in');
  if (!check.ok) return check.response!;

  const account = repo.findAccountById(ctx.db, check.accountId!)!;
  ctx.db
    .prepare('UPDATE accounts SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
    .run(new Date(ctx.now()).toISOString(), account.id);
  const token = createSession(ctx, account.id);
  audit(ctx, 'sign_in', { accountId: account.id, method: 'code' });
  return { status: 200, body: { account: publicAccount(account) }, sessionToken: token };
}

async function resetPassword(ctx: ApiContext, request: ApiRequest): Promise<ApiResponse> {
  const body = asRecord(request.body);
  const identifier = asString(body['identifier']);
  for (const bucket of [`otpreset:ip:${request.ip}`, `otpreset:id:${identifier.trim().toLowerCase()}`]) {
    const limit = checkRateLimit(ctx.db, bucket, SIGN_IN_RATE_LIMIT, ctx.now());
    if (!limit.allowed) return json(429, { error: 'Too many attempts. Try again later.' });
  }
  const newPassword = asString(body['newPassword']);
  const problem = passwordProblem(newPassword);
  if (problem) return json(400, { error: problem });

  const check = consumeOtp(
    ctx,
    identifier,
    asString(body['code']),
    'password_reset',
  );
  if (!check.ok) return check.response!;

  ctx.db
    .prepare('UPDATE accounts SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .run(await hashPassword(newPassword), check.accountId!);
  // NFR-9: a password change kills every existing session.
  repo.revokeAllSessions(ctx.db, check.accountId!, new Date(ctx.now()).toISOString());
  audit(ctx, 'password_reset_completed', { accountId: check.accountId });
  return json(200, { ok: true });
}

function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'Choose a password of at least 10 characters.';
  if (password.length > 200) return 'That password is too long.';
  return null;
}

function meResponse(ctx: ApiContext, me: Principal): ApiResponse {
  return json(200, {
    account: publicAccount(me.account),
    actingAs: me.actingAs ? publicAccount(me.actingAs) : null,
    assistMode: me.assistMode,
    household: repo.findHouseholdByAccount(ctx.db, me.effectiveAccountId),
  });
}

function signOut(ctx: ApiContext, me: Principal): ApiResponse {
  ctx.db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?')
    .run(new Date(ctx.now()).toISOString(), me.sessionId);
  audit(ctx, 'sign_out', {}, { principal: me });
  return { status: 200, body: { ok: true }, sessionToken: null };
}

function endAssist(ctx: ApiContext, me: Principal): ApiResponse {
  if (!me.assistMode) return json(400, { error: 'Not in assist mode.' });
  ctx.db.prepare('UPDATE sessions SET acting_as_account_id = NULL WHERE id = ?').run(me.sessionId);
  audit(ctx, 'assist_mode_ended', { customerAccountId: me.effectiveAccountId }, { principal: me });
  return json(200, { ok: true });
}

// --- account management (staff) ------------------------------------------

function listAccounts(ctx: ApiContext, me: Principal): ApiResponse {
  const guard = requireStaff(me);
  if (!guard.ok) return fromDenial(guard);
  return json(200, { accounts: repo.listAccounts(ctx.db).map(publicAccount) });
}

/**
 * FR-A1 / FR-A2: staff create the account and its household together. There
 * is deliberately no open self-registration route anywhere in this API.
 */
async function createAccount(
  ctx: ApiContext,
  me: Principal,
  request: ApiRequest,
): Promise<ApiResponse> {
  const guard = requireStaff(me);
  if (!guard.ok) return fromDenial(guard);

  const body = asRecord(request.body);
  const email = asString(body['email']).trim() || null;
  const phoneRaw = asString(body['phone']).trim();
  const phone = phoneRaw ? repo.normalizePhone(phoneRaw) : null;
  const role = asString(body['role']) || 'customer';

  if (!email && !phone) return json(400, { error: 'An email address or phone number is required.' });
  if (role !== 'customer' && role !== 'staff' && role !== 'admin') {
    return json(400, { error: 'Unknown role.' });
  }
  // Only an admin may mint another staff or admin account.
  if (role !== 'customer') {
    const adminGuard = requireAdmin(me);
    if (!adminGuard.ok) return fromDenial(adminGuard);
  }

  const password = asString(body['password']);
  if (password) {
    const problem = passwordProblem(password);
    if (problem) return json(400, { error: problem });
  }

  const memberCount = asInt(body['memberCount']) ?? 0;
  const profileId = asString(body['profileId']);
  const periodStart = asString(body['periodStart']);
  const referralId = asString(body['referralId']).trim();

  let profile: ProgramProfile | null = null;
  if (role === 'customer') {
    const issues = validateHouseholdInput({ memberCount, referralId, periodStart, profileId });
    if (issues.length > 0) return json(400, { error: issues[0]!.message, issues });
    profile = repo.findProfile(ctx.db, profileId);
    if (!profile) return json(400, { error: 'That program profile does not exist.' });
  }

  const existing = email ? repo.findAccountByIdentifier(ctx.db, email) : null;
  const existingPhone = phone ? repo.findAccountByIdentifier(ctx.db, phone) : null;
  if (existing || existingPhone) {
    return json(409, { error: 'An account already uses that email or phone number.' });
  }

  const passwordHash = password ? await hashPassword(password) : null;
  const now = new Date(ctx.now()).toISOString();
  const accountId = newId('acct');

  const restrictions = Array.isArray(body['restrictions'])
    ? (body['restrictions'] as unknown[]).filter(
        (t): t is DietaryTag => typeof t === 'string' && (DIETARY_TAGS as readonly string[]).includes(t),
      )
    : [];

  transact(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO accounts (id, role, email, phone, display_name, password_hash, status,
          last_login_at, created_by, created_at, failed_attempts, locked_until)
         VALUES (?,?,?,?,?,?,'active',NULL,?,?,0,NULL)`,
      )
      .run(accountId, role, email, phone, asString(body['displayName']), passwordHash, me.account.id, now);

    if (role === 'customer' && profile) {
      const household: Household = {
        id: newId('hh'),
        accountId,
        referralId,
        memberCount,
        profileId: profile.id,
        profileVersion: profile.version,
        periodStart,
        restrictions,
        createdAt: now,
      };
      repo.upsertHousehold(ctx.db, household);
    }
  });

  audit(ctx, 'account_created', { accountId, role, referralId: role === 'customer' ? referralId : undefined }, { principal: me });
  return json(201, { account: publicAccount(repo.findAccountById(ctx.db, accountId)!) });
}

async function accountAction(
  ctx: ApiContext,
  me: Principal,
  accountId: string,
  action: string,
  request: ApiRequest,
): Promise<ApiResponse> {
  const guard = requireStaff(me);
  if (!guard.ok) return fromDenial(guard);

  const target = repo.findAccountById(ctx.db, accountId);
  if (!target) return json(404, { error: 'Not found.' });
  // A staff member may serve customers, but must never be able to alter a
  // peer or administrator. Without this check, reset-password is a complete
  // privilege-escalation route.
  if (target.role !== 'customer') {
    const adminGuard = requireAdmin(me);
    if (!adminGuard.ok) return fromDenial(adminGuard);
  }
  const now = new Date(ctx.now()).toISOString();

  switch (action) {
    case 'suspend': {
      // FR-A7
      ctx.db.prepare("UPDATE accounts SET status = 'suspended' WHERE id = ?").run(accountId);
      audit(ctx, 'account_suspended', { accountId }, { principal: me });
      return json(200, { account: publicAccount(repo.findAccountById(ctx.db, accountId)!) });
    }
    case 'reinstate': {
      ctx.db.prepare("UPDATE accounts SET status = 'active' WHERE id = ?").run(accountId);
      audit(ctx, 'account_reinstated', { accountId }, { principal: me });
      return json(200, { account: publicAccount(repo.findAccountById(ctx.db, accountId)!) });
    }
    case 'unlock': {
      // NFR-4: staff-clearable lockout.
      ctx.db
        .prepare('UPDATE accounts SET failed_attempts = 0, locked_until = NULL WHERE id = ?')
        .run(accountId);
      audit(ctx, 'account_unlocked', { accountId }, { principal: me });
      return json(200, { ok: true });
    }
    case 'reset-password': {
      // FR-A4: staff-initiated reset at the counter.
      const password = asString(asRecord(request.body)['password']);
      const problem = passwordProblem(password);
      if (problem) return json(400, { error: problem });
      ctx.db
        .prepare('UPDATE accounts SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?')
        .run(await hashPassword(password), accountId);
      repo.revokeAllSessions(ctx.db, accountId, now);
      audit(ctx, 'staff_password_reset', { accountId }, { principal: me });
      return json(200, { ok: true });
    }
    case 'assist': {
      // FR-A6: a staff session that acts on the customer's data.
      if (target.role !== 'customer') {
        return json(400, { error: 'Assist mode is only for customer accounts.' });
      }
      ctx.db
        .prepare('UPDATE sessions SET acting_as_account_id = ? WHERE id = ?')
        .run(accountId, me.sessionId);
      audit(ctx, 'assist_mode_started', { customerAccountId: accountId }, { principal: me });
      return json(200, { ok: true, actingAs: publicAccount(target) });
    }
    case 'revoke-sessions': {
      // NFR-9: forced sign-out after a suspected compromise.
      const count = repo.revokeAllSessions(ctx.db, accountId, now);
      audit(ctx, 'sessions_revoked', { accountId, revokedSessions: count }, { principal: me });
      return json(200, { revoked: count });
    }
    default:
      return json(404, { error: 'Not found.' });
  }
}

// --- orders ---------------------------------------------------------------

function startOrder(ctx: ApiContext, me: Principal): ApiResponse {
  // FR-A7: suspended accounts may read history but not start a new order.
  const notSuspended = requireNotSuspended(me);
  if (!notSuspended.ok) return fromDenial(notSuspended);

  const household = repo.findHouseholdByAccount(ctx.db, me.effectiveAccountId);
  if (!household) return json(400, { error: 'This account has no household on file.' });

  const profile = repo.findProfile(ctx.db, household.profileId);
  if (!profile) return json(400, { error: 'The program profile for this household is missing.' });

  // FR-19: one draft at a time; resume it rather than starting a second.
  const existingDraft = repo
    .listOrdersForAccount(ctx.db, me.effectiveAccountId)
    .find((o) => o.status === 'draft');
  if (existingDraft) return json(200, { order: existingDraft, resumed: true });

  const now = new Date(ctx.now()).toISOString();
  const order: Order = {
    id: newId('order'),
    householdId: household.id,
    status: 'draft',
    rulesSnapshot: buildRulesSnapshot(ctx, profile, household.memberCount),
    lines: [],
    createdAt: now,
    updatedAt: now,
    finalizedAt: null,
    staffInitials: '',
    override: null,
    totalCents: 0,
    categoryTotalsUnits: {},
    revision: 1,
    lastWriterId: me.account.id,
  };
  transact(ctx.db, () => {
    repo.upsertOrder(ctx.db, order);
    audit(ctx, 'order_created', { referralId: household.referralId }, { principal: me, orderId: order.id });
  });
  return json(201, { order, resumed: false });
}

/** FR-2 / FR-33: freeze the rules onto the order at creation. */
function buildRulesSnapshot(ctx: ApiContext, profile: ProgramProfile, memberCount: number) {
  const categories = repo
    .listCategories(ctx.db)
    // Program requirements never disappear merely because an admin hides a
    // category from catalog administration. Otherwise an empty order can
    // qualify after categories are deactivated.
    .filter((c) => profile.requirements.some((r) => r.categoryKey === c.key))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((c) => ({ key: c.key, label: c.label, unitLabel: c.unitLabel, sortOrder: c.sortOrder }));

  const requiredUnitsByCategory: Record<string, number> = {};
  for (const req of profile.requirements) {
    requiredUnitsByCategory[req.categoryKey] =
      req.servingsPerMemberPerDayUnits * memberCount * profile.daysCovered;
  }

  return {
    profileId: profile.id,
    profileFamilyId: profile.familyId,
    profileVersion: profile.version,
    profileName: profile.name,
    scnName: profile.scnName,
    daysCovered: profile.daysCovered,
    capAmountCents: profile.capAmountCents,
    capBasis: profile.capBasis,
    memberCount,
    capTotalCents:
      profile.capBasis === 'per_member'
        ? profile.capAmountCents * memberCount
        : profile.capAmountCents,
    requirements: profile.requirements.map((r) => ({ ...r })),
    mealSplits: profile.mealSplits.map((s) => ({ ...s })),
    allowNonCreditableItems: profile.allowNonCreditableItems,
    shelfLifeHorizonDays: { ...profile.shelfLifeHorizonDays },
    categories,
    requiredUnitsByCategory,
    snapshotAt: new Date(ctx.now()).toISOString(),
  };
}

/**
 * FR-13: the client sends only item ids and quantities. Price, servings,
 * category and tags are read from the catalog here, so a tampered payload
 * cannot put a false price or a false serving count on a claim.
 */
function setLines(
  ctx: ApiContext,
  me: Principal,
  order: Order,
  request: ApiRequest,
): ApiResponse {
  const notSuspended = requireNotSuspended(me);
  if (!notSuspended.ok) return fromDenial(notSuspended);
  if (order.status !== 'draft') {
    return json(409, { error: 'This order is final and can no longer be edited.' });
  }

  const body = asRecord(request.body);
  const incoming = Array.isArray(body['lines']) ? (body['lines'] as unknown[]) : null;
  if (!incoming) return json(400, { error: 'Expected a list of lines.' });

  const baseRevision = asInt(body['baseRevision']);
  // Section 5: last write wins, but warn on conflict.
  //
  // A stale revision alone is not a conflict — one person tapping faster than
  // the round trip produces those constantly, and a warning that cries wolf
  // is worse than none. It is only a conflict when someone *else* wrote last,
  // which is the case section 5 actually describes.
  const conflict =
    baseRevision !== null &&
    baseRevision < order.revision &&
    order.lastWriterId !== '' &&
    order.lastWriterId !== me.account.id
      ? 'This order was changed on another device. Your version has been saved over it.'
      : null;

  const existingByItem = new Map(order.lines.map((l) => [l.itemId, l]));
  const lines: OrderLine[] = [];
  const seenItemIds = new Set<string>();
  const now = new Date(ctx.now()).toISOString();

  for (const raw of incoming) {
    const entry = asRecord(raw);
    const itemId = asString(entry['itemId']);
    if (seenItemIds.has(itemId)) {
      return json(400, { error: 'Each catalog item may appear only once in an order.' });
    }
    seenItemIds.add(itemId);

    // A quantity that is present but not a whole package is an error, not a
    // line to skip. Dropping it silently would quietly shrink an order that
    // becomes a reimbursement claim.
    const rawQty = entry['qty'];
    if (typeof rawQty !== 'number' || validateQuantity(rawQty).length > 0) {
      return json(400, { error: 'Quantities must be whole packages of zero or more.' });
    }
    const qty = rawQty;
    if (qty === 0) continue;

    const item = repo.findItem(ctx.db, itemId);
    if (!item) return json(400, { error: 'That item is not in the catalog.' });
    if (!item.active && !existingByItem.has(itemId)) {
      return json(400, { error: `"${item.name}" is no longer available.` });
    }
    if (item.servingsPerPackageUnits === 0 && !order.rulesSnapshot.allowNonCreditableItems) {
      return json(400, {
        error: `"${item.name}" credits no servings and this program does not allow it.`,
      });
    }

    const existing = existingByItem.get(itemId);
    if (existing) {
      // FR-6: an item already in the order keeps the price captured when it
      // was added, whatever the catalog says now.
      lines.push({ ...existing, qty });
    } else {
      lines.push({
        id: newId('line'),
        itemId: item.id,
        itemNameSnapshot: item.name,
        itemNameEsSnapshot: item.nameEs,
        packageSizeSnapshot: item.packageSize,
        qty,
        unitPriceCentsSnapshot: item.priceCents,
        servingsUnitsSnapshot: item.servingsPerPackageUnits,
        categorySnapshot: item.categoryKey,
        tagsSnapshot: [...item.tags],
        shelfLifeClassSnapshot: item.shelfLifeClass,
        addedAt: now,
      });
    }
  }

  const updated: Order = {
    ...order,
    lines,
    updatedAt: now,
    revision: order.revision + 1,
    lastWriterId: me.account.id,
    totalCents: lines.reduce((sum, l) => sum + l.unitPriceCentsSnapshot * l.qty, 0),
  };
  transact(ctx.db, () => {
    repo.upsertOrder(ctx.db, updated);
    audit(ctx, 'order_updated', { revision: updated.revision, lineCount: lines.length }, { principal: me, orderId: order.id });
  });

  return json(200, {
    order: updated,
    compliance: evaluateOrder(updated.lines, updated.rulesSnapshot),
    conflict,
  });
}

/**
 * FR-18: the server decides whether the order qualifies. The client's opinion
 * is never consulted — it recomputes the same shared engine for the live
 * panel, but this is the copy that gates the record.
 */
function finalizeOrder(
  ctx: ApiContext,
  me: Principal,
  order: Order,
  request: ApiRequest,
): ApiResponse {
  const notSuspended = requireNotSuspended(me);
  if (!notSuspended.ok) return fromDenial(notSuspended);
  if (order.status !== 'draft') return json(409, { error: 'This order is already final.' });

  const body = asRecord(request.body);
  const staffInitials = asString(body['staffInitials']).trim();
  const overrideReason = asString(body['overrideReason']).trim();

  const result = evaluateOrder(order.lines, order.rulesSnapshot);

  if (!result.canFinalize) {
    // Only staff may override; a customer cannot wave through their own
    // short order.
    if (me.account.role === 'customer') {
      return json(422, {
        error: 'This order is short or over the cap. Ask store staff to review it.',
        compliance: result,
      });
    }
    if (!overrideReason) {
      return json(422, {
        error: 'An override reason is required to finalize an order that does not qualify.',
        compliance: result,
      });
    }
    if (!staffInitials) return json(400, { error: 'Staff initials are required.' });
  }

  const now = new Date(ctx.now()).toISOString();
  const categoryTotals: Record<string, number> = {};
  for (const cat of result.categories) categoryTotals[cat.categoryKey] = cat.inCartUnits;

  const override =
    !result.canFinalize
      ? {
          reason: overrideReason,
          staffInitials,
          at: now,
          violations: result.violations.map((v) =>
            v.categoryKey ? `${v.kind}:${v.categoryKey}` : v.kind,
          ),
        }
      : null;

  const finalized: Order = {
    ...order,
    status: 'final',
    finalizedAt: now,
    updatedAt: now,
    staffInitials: staffInitials || (me.account.displayName || me.account.id).slice(0, 8),
    override,
    totalCents: result.totalCents,
    categoryTotalsUnits: categoryTotals,
    revision: order.revision + 1,
    lastWriterId: me.account.id,
  };
  transact(ctx.db, () => {
    repo.upsertOrder(ctx.db, finalized);
    if (override) {
      audit(ctx, 'override_applied', { ...override }, { principal: me, orderId: order.id });
    }
    audit(
      ctx,
      'order_finalized',
      {
        totalCents: finalized.totalCents,
        capTotalCents: finalized.rulesSnapshot.capTotalCents,
        overridden: override !== null,
      },
      { principal: me, orderId: order.id },
    );
  });

  return json(200, { order: finalized, compliance: result });
}

function planWithStaleness(ctx: ApiContext, order: Order): MealPlan | null {
  const plan = repo.latestPlanForOrder(ctx.db, order.id);
  if (!plan) return null;
  // Section 5: a plan built from different lines is stale, not current.
  return { ...plan, stale: plan.sourceLinesHash !== hashOrderLines(order.lines) };
}

function generatePlan(
  ctx: ApiContext,
  me: Principal,
  order: Order,
  request: ApiRequest,
): ApiResponse {
  const household = repo.findHousehold(ctx.db, order.householdId);
  if (!household) return json(400, { error: 'This order has no household on file.' });

  const body = asRecord(request.body);
  const seed = asInt(body['seed']) ?? Math.floor(Math.random() * 2_147_483_647);

  const generated = generateMealPlan({
    lines: order.lines,
    snapshot: order.rulesSnapshot,
    periodStart: household.periodStart,
    restrictions: household.restrictions,
    seed,
  });

  const plan: MealPlan = {
    id: newId('plan'),
    orderId: order.id,
    generatedAt: new Date(ctx.now()).toISOString(),
    seed,
    days: generated.days,
    unused: generated.unused,
    stale: false,
    sourceLinesHash: hashOrderLines(order.lines),
    complete: generated.complete,
  };
  repo.insertMealPlan(ctx.db, plan);
  audit(ctx, 'plan_generated', { seed, complete: plan.complete }, { principal: me, orderId: order.id });
  return json(201, { plan });
}

// --- admin: rules and catalog --------------------------------------------

function saveProfile(ctx: ApiContext, me: Principal, request: ApiRequest): ApiResponse {
  const guard = requireAdmin(me);
  if (!guard.ok) return fromDenial(guard);

  const body = asRecord(request.body);
  const incoming = body['profile'] as ProgramProfile | undefined;
  if (!incoming || typeof incoming !== 'object') return json(400, { error: 'Missing profile.' });

  const issues = validateProfile({
    name: incoming.name ?? '',
    daysCovered: incoming.daysCovered,
    capAmountCents: incoming.capAmountCents,
    requirements: incoming.requirements ?? [],
    mealSplits: incoming.mealSplits ?? [],
  });
  const categoryKeys = new Set(repo.listCategories(ctx.db).map((category) => category.key));
  for (const requirement of incoming.requirements ?? []) {
    if (!categoryKeys.has(requirement.categoryKey)) {
      issues.push({ field: `requirement.${requirement.categoryKey}`, message: 'Each requirement must use an existing category.' });
    }
  }
  if (incoming.capBasis !== 'per_member' && incoming.capBasis !== 'per_order') {
    issues.push({ field: 'capBasis', message: 'Cap basis must be per member or per order.' });
  }
  if (!isIsoDate(incoming.effectiveFrom)) {
    issues.push({ field: 'effectiveFrom', message: 'Effective-from must be a valid calendar date.' });
  }
  if (incoming.effectiveTo !== null && !isIsoDate(incoming.effectiveTo)) {
    issues.push({ field: 'effectiveTo', message: 'Effective-to must be a valid calendar date.' });
  }
  for (const cls of SHELF_LIFE_CLASSES) {
    const horizon = incoming.shelfLifeHorizonDays?.[cls];
    if (horizon !== null && (!Number.isInteger(horizon) || horizon < 0 || horizon >= incoming.daysCovered)) {
      issues.push({ field: `shelfLifeHorizonDays.${cls}`, message: 'Shelf-life horizons must be a day within the benefit period or blank.' });
    }
  }
  if (issues.length > 0) return json(400, { error: issues[0]!.message, issues });

  const existing = repo.findProfile(ctx.db, incoming.id);
  const newVersion =
    body['newVersion'] === true ||
    (existing !== null &&
      requiresNewVersion(existing, {
        daysCovered: incoming.daysCovered,
        capAmountCents: incoming.capAmountCents,
        capBasis: incoming.capBasis,
        requirements: incoming.requirements,
        mealSplits: incoming.mealSplits,
      }));

  // FR-2: rule changes create a new version so completed orders keep meaning.
  if (existing && newVersion) {
    const siblings = repo.listProfiles(ctx.db).filter((p) => p.familyId === existing.familyId);
    const nextVersion = Math.max(...siblings.map((p) => p.version)) + 1;
    const effectiveFrom = incoming.effectiveFrom || new Date(ctx.now()).toISOString().slice(0, 10);
    const created: ProgramProfile = {
      ...incoming,
      id: newId('profile'),
      familyId: existing.familyId,
      version: nextVersion,
      effectiveFrom,
      effectiveTo: null,
      archived: false,
      createdAt: new Date(ctx.now()).toISOString(),
    };
    transact(ctx.db, () => {
      repo.upsertProfile(ctx.db, { ...existing, effectiveTo: effectiveFrom });
      repo.upsertProfile(ctx.db, created);
    });
    audit(ctx, 'profile_version_created', { familyId: existing.familyId, version: nextVersion }, { principal: me });
    return json(201, { profile: created });
  }

  const profile: ProgramProfile = {
    ...incoming,
    id: incoming.id || newId('profile'),
    familyId: incoming.familyId || newId('family'),
    version: existing?.version ?? 1,
    archived: incoming.archived ?? false,
    createdAt: existing?.createdAt ?? new Date(ctx.now()).toISOString(),
  };
  repo.upsertProfile(ctx.db, profile);
  audit(ctx, existing ? 'profile_updated' : 'profile_created', { id: profile.id, name: profile.name }, { principal: me });
  return json(existing ? 200 : 201, { profile });
}

function saveCategory(ctx: ApiContext, me: Principal, request: ApiRequest): ApiResponse {
  const guard = requireAdmin(me);
  if (!guard.ok) return fromDenial(guard);

  const body = asRecord(request.body);
  const incoming = asRecord(body['category']);
  const key = asString(incoming['key']).trim();
  const label = asString(incoming['label']).trim();
  if (!key || !label) return json(400, { error: 'Category key and label are required.' });

  const existing = repo.listCategories(ctx.db).find((c) => c.id === incoming['id']);
  // FR-3: renaming is safe, but the key is what orders reference and must
  // never change once it has been used.
  if (existing && existing.key !== key) {
    return json(400, { error: 'A category key cannot change once orders reference it.' });
  }

  const category = {
    id: asString(incoming['id']) || newId('cat'),
    key,
    label,
    unitLabel: asString(incoming['unitLabel']),
    sortOrder: asInt(incoming['sortOrder']) ?? 0,
    active: incoming['active'] !== false,
  };
  repo.upsertCategory(ctx.db, category);
  audit(ctx, existing ? 'category_updated' : 'category_created', { key, label }, { principal: me });
  return json(existing ? 200 : 201, { category });
}

function saveItem(ctx: ApiContext, me: Principal, request: ApiRequest): ApiResponse {
  const guard = requireAdmin(me);
  if (!guard.ok) return fromDenial(guard);

  const body = asRecord(request.body);
  const incoming = asRecord(body['item']);
  const name = asString(incoming['name']).trim();
  const categoryKey = asString(incoming['categoryKey']);
  const priceCents = asInt(incoming['priceCents']);
  const servings = asInt(incoming['servingsPerPackageUnits']);
  const shelfLifeClass = asString(incoming['shelfLifeClass']) || 'shelf_stable';

  if (!name) return json(400, { error: 'Item name is required.' });
  if (priceCents === null || priceCents < 0) return json(400, { error: 'Price must be zero or more, in cents.' });
  if (servings === null || servings < 0) return json(400, { error: 'Servings per package must be zero or more.' });
  if (!repo.listCategories(ctx.db).some((c) => c.key === categoryKey)) {
    return json(400, { error: 'Unknown category.' });
  }
  if (!(SHELF_LIFE_CLASSES as readonly string[]).includes(shelfLifeClass)) {
    return json(400, { error: 'Unknown shelf-life class.' });
  }

  const id = asString(incoming['id']);
  const existing = id ? repo.findItem(ctx.db, id) : null;

  const item: Item = {
    id: id || newId('item'),
    name,
    nameEs: asString(incoming['nameEs']),
    packageSize: asString(incoming['packageSize']),
    categoryKey,
    priceCents,
    servingsPerPackageUnits: servings,
    sku: asString(incoming['sku']),
    upc: asString(incoming['upc']),
    tags: Array.isArray(incoming['tags'])
      ? (incoming['tags'] as unknown[]).filter(
          (t): t is DietaryTag => typeof t === 'string' && (DIETARY_TAGS as readonly string[]).includes(t),
        )
      : [],
    shelfLifeClass: shelfLifeClass as Item['shelfLifeClass'],
    active: incoming['active'] !== false,
    updatedAt: new Date(ctx.now()).toISOString(),
  };
  repo.upsertItem(ctx.db, item);

  // NFR-6: price changes are audited on their own, not folded into edits.
  if (existing && existing.priceCents !== item.priceCents) {
    audit(
      ctx,
      'price_changed',
      { itemId: item.id, name: item.name, fromCents: existing.priceCents, toCents: item.priceCents },
      { principal: me },
    );
  }
  if (existing && existing.active && !item.active) {
    audit(ctx, 'item_deactivated', { itemId: item.id, name: item.name }, { principal: me });
  }
  audit(ctx, existing ? 'item_updated' : 'item_created', { itemId: item.id, name: item.name }, { principal: me });
  return json(existing ? 200 : 201, { item });
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month! - 1 &&
    parsed.getUTCDate() === day
  );
}

/** FR-5 */
function importCatalog(ctx: ApiContext, me: Principal, request: ApiRequest): ApiResponse {
  const guard = requireAdmin(me);
  if (!guard.ok) return fromDenial(guard);

  const body = asRecord(request.body);
  const csv = asString(body['csv']);
  if (!csv.trim()) return json(400, { error: 'The uploaded file is empty.' });

  const rows = parseCsv(csv);
  if (rows.length === 0) return json(400, { error: 'The uploaded file has no rows.' });

  const hasHeader = body['hasHeader'] !== false;
  const mapping =
    body['mapping'] && typeof body['mapping'] === 'object'
      ? (body['mapping'] as ReturnType<typeof inferColumnMapping>)
      : inferColumnMapping(rows[0] ?? []);

  const result = importCatalogRows({
    rows,
    mapping,
    hasHeader,
    existingItems: repo.listItems(ctx.db),
    validCategoryKeys: repo.listCategories(ctx.db).map((c) => c.key),
  });

  if (result.fatal) return json(400, { error: result.fatal, mapping });

  // Only commit when the caller has seen the report and confirmed.
  if (body['commit'] === true) {
    transact(ctx.db, () => {
      for (const item of result.items) repo.upsertItem(ctx.db, item);
    });
    audit(
      ctx,
      'catalog_imported',
      { created: result.created, updated: result.updated, rejected: result.rejected.length },
      { principal: me },
    );
  }

  return json(200, {
    created: result.created,
    updated: result.updated,
    rejected: result.rejected,
    committed: body['commit'] === true,
    mapping,
  });
}

// --- records (FR-34) ------------------------------------------------------

function parseSearch(request: ApiRequest) {
  const memberCountRaw = request.query.get('memberCount');
  const memberCount = memberCountRaw ? Number(memberCountRaw) : undefined;
  return {
    from: request.query.get('from') ?? undefined,
    to: request.query.get('to') ?? undefined,
    referralId: request.query.get('referralId') ?? undefined,
    memberCount: Number.isInteger(memberCount) ? memberCount : undefined,
    status: (request.query.get('status') as Order['status'] | null) ?? 'final',
  };
}

function searchRecords(ctx: ApiContext, me: Principal, request: ApiRequest): ApiResponse {
  const guard = requireStaff(me);
  if (!guard.ok) return fromDenial(guard);

  const orders = repo.searchOrders(ctx.db, parseSearch(request));
  const households = new Map(
    orders.map((o) => [o.householdId, repo.findHousehold(ctx.db, o.householdId)]),
  );
  return json(200, {
    orders: orders.map((order) => ({
      order,
      referralId: households.get(order.householdId)?.referralId ?? '',
      memberCount: households.get(order.householdId)?.memberCount ?? 0,
    })),
  });
}

function exportRecords(ctx: ApiContext, me: Principal, request: ApiRequest): ApiResponse {
  const guard = requireAdmin(me);
  if (!guard.ok) return fromDenial(guard);

  const orders = repo.searchOrders(ctx.db, parseSearch(request));
  const header = [
    'order_id',
    'referral_id',
    'member_count',
    'status',
    'finalized_at',
    'staff_initials',
    'profile_name',
    'profile_version',
    'scn_name',
    'days_covered',
    'cap_total',
    'order_total',
    'overridden',
    'override_reason',
    'category',
    'required_servings',
    'purchased_servings',
  ];

  const rows: string[][] = [];
  for (const order of orders) {
    const household = repo.findHousehold(ctx.db, order.householdId);
    const snapshot = order.rulesSnapshot;
    for (const cat of snapshot.categories ?? []) {
      rows.push([
        order.id,
        household?.referralId ?? '',
        String(household?.memberCount ?? ''),
        order.status,
        order.finalizedAt ?? '',
        order.staffInitials,
        snapshot.profileName ?? '',
        String(snapshot.profileVersion ?? ''),
        snapshot.scnName ?? '',
        String(snapshot.daysCovered ?? ''),
        centsToPlain(snapshot.capTotalCents ?? 0),
        centsToPlain(order.totalCents),
        order.override ? 'yes' : 'no',
        order.override?.reason ?? '',
        cat.label,
        String(unitsToServings(snapshot.requiredUnitsByCategory?.[cat.key] ?? 0)),
        String(unitsToServings(order.categoryTotalsUnits?.[cat.key] ?? 0)),
      ]);
    }
  }

  audit(ctx, 'records_exported', { count: orders.length }, { principal: me });
  return {
    status: 200,
    body: toCsv([header, ...rows]),
    headers: { 'content-type': 'text/csv; charset=utf-8' },
  };
}
