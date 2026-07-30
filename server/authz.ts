/**
 * Authorization (NFR-3, NFR-5, AC-10, AC-11).
 *
 * "Every request is authorized server-side against the signed-in account. A
 * customer requesting another customer's order by guessing an ID must be
 * refused by the server, not merely hidden by the interface. This is the
 * single most likely way this system leaks."
 *
 * So: no route reads a resource without going through a guard here, and the
 * guards resolve ownership from the database, never from anything the client
 * sent. A request body claiming `accountId` is ignored entirely.
 */

import type { Account, Order, Principal } from '../src/shared/types';
import type { Db } from './db';
import { findAccountById, findHousehold, findOrder, findSession } from './repo';
import { hashToken } from './security';

export type DenialCode =
  | 'unauthenticated'
  | 'session_expired'
  | 'forbidden'
  | 'not_found'
  | 'suspended';

export interface Denial {
  ok: false;
  code: DenialCode;
  /** HTTP status to return. */
  status: number;
  message: string;
}

export type Guard<T> = { ok: true; value: T } | Denial;

function deny(code: DenialCode, status: number, message: string): Denial {
  return { ok: false, code, status, message };
}

/**
 * A customer asking for someone else's resource gets 404, not 403.
 *
 * 403 would confirm the ID exists, which turns ID guessing into a working
 * enumeration oracle for who else is on the program. Staff and admin, who are
 * allowed to know what exists, still get a truthful 404 only when it truly
 * does not exist.
 */
const NOT_YOURS = () => deny('not_found', 404, 'Not found.');

// --- authentication -------------------------------------------------------

export interface AuthenticateOptions {
  now?: number;
}

/**
 * Resolve a bearer token into a principal. Returns a denial rather than
 * throwing, so every caller has to handle the failure explicitly.
 */
export function authenticate(
  db: Db,
  token: string | null,
  options: AuthenticateOptions = {},
): Guard<Principal> {
  if (!token) return deny('unauthenticated', 401, 'Sign in to continue.');

  const now = options.now ?? Date.now();
  const session = findSession(db, hashToken(token));
  if (!session) return deny('unauthenticated', 401, 'Sign in to continue.');

  if (session.revokedAt) return deny('session_expired', 401, 'This session has ended.');
  // FR-A5: sessions expire after inactivity.
  if (Date.parse(session.expiresAt) <= now) {
    return deny('session_expired', 401, 'This session has expired. Sign in again.');
  }

  const account = findAccountById(db, session.accountId);
  if (!account) return deny('unauthenticated', 401, 'Sign in to continue.');

  // Customers retain the deliberately limited history access described by
  // FR-A7. A suspended employee must lose every privileged route immediately;
  // otherwise suspension is only a cosmetic database field.
  if (account.status === 'suspended' && account.role !== 'customer') {
    return deny('suspended', 403, 'This staff account is suspended.');
  }

  // FR-A6: in assist mode the acting account is staff; the data belongs to
  // the customer. Both identities are carried so the audit log can name the
  // staff member rather than the customer.
  let actingAs: Account | null = null;
  if (session.actingAsAccountId) {
    actingAs = findAccountById(db, session.actingAsAccountId);
    if (!actingAs) return deny('forbidden', 403, 'The assisted account no longer exists.');
    // Only staff and admin may ever act as someone else.
    if (account.role === 'customer') {
      return deny('forbidden', 403, 'Assist mode is not available to customers.');
    }
  }

  return {
    ok: true,
    value: {
      account,
      sessionId: session.id,
      actingAs,
      effectiveAccountId: actingAs?.id ?? account.id,
      assistMode: actingAs !== null,
    },
  };
}

// --- role guards ----------------------------------------------------------

export function requireStaff(principal: Principal): Guard<Principal> {
  if (principal.account.role === 'customer') {
    // NFR-5 / AC-11: customers cannot reach the catalog editor, program
    // rules, or store-wide records by any route.
    return deny('forbidden', 403, 'Staff access is required.');
  }
  return { ok: true, value: principal };
}

export function requireAdmin(principal: Principal): Guard<Principal> {
  if (principal.account.role !== 'admin') {
    return deny('forbidden', 403, 'Administrator access is required.');
  }
  return { ok: true, value: principal };
}

/**
 * FR-A7: a suspended account can sign in and view history, but cannot start
 * a new order or change anything.
 */
export function requireNotSuspended(principal: Principal): Guard<Principal> {
  const subject = principal.actingAs ?? principal.account;
  if (subject.status === 'suspended') {
    return deny(
      'suspended',
      403,
      'This account is suspended. Past orders are still available, but a new order cannot be started.',
    );
  }
  return { ok: true, value: principal };
}

// --- resource guards ------------------------------------------------------

/**
 * Ownership is resolved from the database every time: order -> household ->
 * account. Nothing the client sends participates in the decision.
 */
export function authorizeOrder(
  db: Db,
  principal: Principal,
  orderId: string,
): Guard<Order> {
  const order = findOrder(db, orderId);
  if (!order) return NOT_YOURS();

  if (principal.account.role !== 'customer' && !principal.assistMode) {
    // Staff and admin may see any order (section 2).
    return { ok: true, value: order };
  }

  const household = findHousehold(db, order.householdId);
  if (!household) return NOT_YOURS();
  if (household.accountId !== principal.effectiveAccountId) return NOT_YOURS();

  return { ok: true, value: order };
}

export function authorizeHousehold(
  db: Db,
  principal: Principal,
  householdId: string,
): Guard<{ accountId: string; householdId: string }> {
  const household = findHousehold(db, householdId);
  if (!household) return NOT_YOURS();

  if (principal.account.role !== 'customer' && !principal.assistMode) {
    return { ok: true, value: { accountId: household.accountId, householdId } };
  }
  if (household.accountId !== principal.effectiveAccountId) return NOT_YOURS();
  return { ok: true, value: { accountId: household.accountId, householdId } };
}

/** Guard for reading another account record (staff/admin only, or self). */
export function authorizeAccountRead(
  db: Db,
  principal: Principal,
  accountId: string,
): Guard<Account> {
  if (principal.account.role === 'customer' && accountId !== principal.effectiveAccountId) {
    return NOT_YOURS();
  }
  const account = findAccountById(db, accountId);
  if (!account) return NOT_YOURS();
  return { ok: true, value: account };
}
