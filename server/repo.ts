/**
 * Row <-> domain mapping and queries.
 *
 * All JSON columns are parsed here so the rest of the server works in domain
 * types, and the shared compliance engine can be handed exactly the same
 * shapes the browser uses.
 */

import type {
  Account,
  AccountRole,
  AccountStatus,
  AuditEvent,
  Category,
  CategoryRequirement,
  DietaryTag,
  Household,
  Item,
  MealPlan,
  Order,
  OrderLine,
  OrderOverride,
  ProgramProfile,
  RulesSnapshot,
  SessionRecord,
  ShelfLifeClass,
} from '../src/shared/types';
import type { Db } from './db';

type Row = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);
const nullableStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const bool = (v: unknown): boolean => v === 1 || v === true;
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/**
 * Profiles created before maximum-only ordering used their only per-day value
 * as a required minimum. Treat that legacy value as the current ceiling so an
 * existing local preview adopts the revised program rule without a database
 * reset. Profiles that already carry an explicit maximum are left unchanged.
 */
function normalizeRequirements(requirements: CategoryRequirement[]): CategoryRequirement[] {
  return requirements.map((requirement) => {
    if (
      requirement.maxServingsPerMemberPerDayUnits === null &&
      requirement.servingsPerMemberPerDayUnits > 0
    ) {
      return {
        ...requirement,
        servingsPerMemberPerDayUnits: 0,
        maxServingsPerMemberPerDayUnits: requirement.servingsPerMemberPerDayUnits,
      };
    }
    return requirement;
  });
}

function normalizeRulesSnapshot(snapshot: RulesSnapshot): RulesSnapshot {
  const requirements = normalizeRequirements(snapshot.requirements);
  const requiredUnitsByCategory: Record<string, number> = {};
  for (const requirement of requirements) {
    requiredUnitsByCategory[requirement.categoryKey] =
      requirement.servingsPerMemberPerDayUnits * snapshot.memberCount * snapshot.daysCovered;
  }
  return { ...snapshot, requirements, requiredUnitsByCategory };
}

// --- accounts -------------------------------------------------------------

export function rowToAccount(row: Row): Account {
  return {
    id: str(row['id']),
    role: str(row['role'], 'customer') as AccountRole,
    email: nullableStr(row['email']),
    phone: nullableStr(row['phone']),
    displayName: str(row['display_name']),
    status: str(row['status'], 'active') as AccountStatus,
    lastLoginAt: nullableStr(row['last_login_at']),
    createdBy: nullableStr(row['created_by']),
    createdAt: str(row['created_at']),
  };
}

export function findAccountById(db: Db, id: string): Account | null {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined;
  return row ? rowToAccount(row) : null;
}

/** FR-A3: sign in by email or phone. Email is matched case-insensitively. */
export function findAccountByIdentifier(db: Db, identifier: string): Account | null {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  const row = db
    .prepare('SELECT * FROM accounts WHERE lower(email) = lower(?) OR phone = ? LIMIT 1')
    .get(trimmed, normalizePhone(trimmed)) as Row | undefined;
  return row ? rowToAccount(row) : null;
}

/** Strip formatting so "(555) 010-1234" and "5550101234" are the same phone. */
export function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}

export function accountSecrets(
  db: Db,
  id: string,
): { passwordHash: string | null; failedAttempts: number; lockedUntil: string | null } | null {
  const row = db
    .prepare('SELECT password_hash, failed_attempts, locked_until FROM accounts WHERE id = ?')
    .get(id) as Row | undefined;
  if (!row) return null;
  return {
    passwordHash: nullableStr(row['password_hash']),
    failedAttempts: num(row['failed_attempts']),
    lockedUntil: nullableStr(row['locked_until']),
  };
}

export function listAccounts(db: Db, role?: AccountRole): Account[] {
  const rows = (
    role
      ? db.prepare('SELECT * FROM accounts WHERE role = ? ORDER BY created_at DESC').all(role)
      : db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all()
  ) as Row[];
  return rows.map(rowToAccount);
}

// --- sessions -------------------------------------------------------------

export function rowToSession(row: Row): SessionRecord {
  return {
    id: str(row['id']),
    accountId: str(row['account_id']),
    issuedAt: str(row['issued_at']),
    expiresAt: str(row['expires_at']),
    revokedAt: nullableStr(row['revoked_at']),
    actingAsAccountId: nullableStr(row['acting_as_account_id']),
  };
}

export function findSession(db: Db, tokenHash: string): SessionRecord | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(tokenHash) as Row | undefined;
  return row ? rowToSession(row) : null;
}

/** NFR-9: revoke every live session for an account after a compromise. */
export function revokeAllSessions(db: Db, accountId: string, at: string): number {
  const result = db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL')
    .run(at, accountId);
  return Number(result.changes ?? 0);
}

// --- categories -----------------------------------------------------------

export function rowToCategory(row: Row): Category {
  return {
    id: str(row['id']),
    key: str(row['key']),
    label: str(row['label']),
    unitLabel: str(row['unit_label']),
    sortOrder: num(row['sort_order']),
    active: bool(row['active']),
  };
}

export function listCategories(db: Db): Category[] {
  return (db.prepare('SELECT * FROM categories ORDER BY sort_order').all() as Row[]).map(
    rowToCategory,
  );
}

export function upsertCategory(db: Db, category: Category): void {
  db.prepare(
    `INSERT INTO categories (id, key, label, unit_label, sort_order, active)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       key = excluded.key, label = excluded.label, unit_label = excluded.unit_label,
       sort_order = excluded.sort_order, active = excluded.active`,
  ).run(
    category.id,
    category.key,
    category.label,
    category.unitLabel,
    category.sortOrder,
    category.active ? 1 : 0,
  );
}

// --- profiles -------------------------------------------------------------

export function rowToProfile(row: Row): ProgramProfile {
  return {
    id: str(row['id']),
    familyId: str(row['family_id']),
    version: num(row['version']),
    name: str(row['name']),
    scnName: str(row['scn_name']),
    effectiveFrom: str(row['effective_from']),
    effectiveTo: nullableStr(row['effective_to']),
    daysCovered: num(row['days_covered']),
    capAmountCents: num(row['cap_amount_cents']),
    capBasis: str(row['cap_basis'], 'per_member') as ProgramProfile['capBasis'],
    requirements: normalizeRequirements(json(row['requirements_json'], [])),
    mealSplits: json(row['meal_splits_json'], []),
    allowNonCreditableItems: bool(row['allow_non_creditable']),
    shelfLifeHorizonDays: json(row['shelf_life_horizons_json'], {} as Record<ShelfLifeClass, number | null>),
    archived: bool(row['archived']),
    createdAt: str(row['created_at']),
  };
}

export function listProfiles(db: Db): ProgramProfile[] {
  return (
    db.prepare('SELECT * FROM profiles ORDER BY family_id, version DESC').all() as Row[]
  ).map(rowToProfile);
}

export function findProfile(db: Db, id: string): ProgramProfile | null {
  const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Row | undefined;
  return row ? rowToProfile(row) : null;
}

export function upsertProfile(db: Db, profile: ProgramProfile): void {
  db.prepare(
    `INSERT INTO profiles (
        id, family_id, version, name, scn_name, effective_from, effective_to,
        days_covered, cap_amount_cents, cap_basis, requirements_json, meal_splits_json,
        allow_non_creditable, shelf_life_horizons_json, archived, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, scn_name = excluded.scn_name,
        effective_from = excluded.effective_from, effective_to = excluded.effective_to,
        days_covered = excluded.days_covered, cap_amount_cents = excluded.cap_amount_cents,
        cap_basis = excluded.cap_basis, requirements_json = excluded.requirements_json,
        meal_splits_json = excluded.meal_splits_json,
        allow_non_creditable = excluded.allow_non_creditable,
        shelf_life_horizons_json = excluded.shelf_life_horizons_json,
        archived = excluded.archived`,
  ).run(
    profile.id,
    profile.familyId,
    profile.version,
    profile.name,
    profile.scnName,
    profile.effectiveFrom,
    profile.effectiveTo,
    profile.daysCovered,
    profile.capAmountCents,
    profile.capBasis,
    JSON.stringify(profile.requirements),
    JSON.stringify(profile.mealSplits),
    profile.allowNonCreditableItems ? 1 : 0,
    JSON.stringify(profile.shelfLifeHorizonDays),
    profile.archived ? 1 : 0,
    profile.createdAt,
  );
}

// --- items ----------------------------------------------------------------

export function rowToItem(row: Row): Item {
  return {
    id: str(row['id']),
    name: str(row['name']),
    nameEs: str(row['name_es']),
    packageSize: str(row['package_size']),
    categoryKey: str(row['category_key']),
    priceCents: num(row['price_cents']),
    servingsPerPackageUnits: num(row['servings_per_package_units']),
    sku: str(row['sku']),
    upc: str(row['upc']),
    tags: json<DietaryTag[]>(row['tags_json'], []),
    shelfLifeClass: str(row['shelf_life_class'], 'shelf_stable') as ShelfLifeClass,
    active: bool(row['active']),
    updatedAt: str(row['updated_at']),
  };
}

export function listItems(db: Db, activeOnly = false): Item[] {
  const sql = activeOnly
    ? 'SELECT * FROM items WHERE active = 1 ORDER BY category_key, name'
    : 'SELECT * FROM items ORDER BY category_key, name';
  return (db.prepare(sql).all() as Row[]).map(rowToItem);
}

export function findItem(db: Db, id: string): Item | null {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Row | undefined;
  return row ? rowToItem(row) : null;
}

export function findItemByUpc(db: Db, upc: string): Item | null {
  const row = db
    .prepare('SELECT * FROM items WHERE upc = ? AND active = 1 LIMIT 1')
    .get(upc) as Row | undefined;
  return row ? rowToItem(row) : null;
}

export function upsertItem(db: Db, item: Item): void {
  db.prepare(
    `INSERT INTO items (
        id, name, name_es, package_size, category_key, price_cents,
        servings_per_package_units, sku, upc, tags_json, shelf_life_class, active, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, name_es = excluded.name_es,
        package_size = excluded.package_size, category_key = excluded.category_key,
        price_cents = excluded.price_cents,
        servings_per_package_units = excluded.servings_per_package_units,
        sku = excluded.sku, upc = excluded.upc, tags_json = excluded.tags_json,
        shelf_life_class = excluded.shelf_life_class, active = excluded.active,
        updated_at = excluded.updated_at`,
  ).run(
    item.id,
    item.name,
    item.nameEs,
    item.packageSize,
    item.categoryKey,
    item.priceCents,
    item.servingsPerPackageUnits,
    item.sku,
    item.upc,
    JSON.stringify(item.tags),
    item.shelfLifeClass,
    item.active ? 1 : 0,
    item.updatedAt,
  );
}

// --- households -----------------------------------------------------------

export function rowToHousehold(row: Row): Household {
  return {
    id: str(row['id']),
    accountId: str(row['account_id']),
    referralId: str(row['referral_id']),
    memberCount: num(row['member_count']),
    profileId: str(row['profile_id']),
    profileVersion: num(row['profile_version']),
    periodStart: str(row['period_start']),
    restrictions: json<DietaryTag[]>(row['restrictions_json'], []),
    createdAt: str(row['created_at']),
  };
}

export function findHousehold(db: Db, id: string): Household | null {
  const row = db.prepare('SELECT * FROM households WHERE id = ?').get(id) as Row | undefined;
  return row ? rowToHousehold(row) : null;
}

/** FR-A2: one account, one household. */
export function findHouseholdByAccount(db: Db, accountId: string): Household | null {
  const row = db
    .prepare('SELECT * FROM households WHERE account_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(accountId) as Row | undefined;
  return row ? rowToHousehold(row) : null;
}

export function upsertHousehold(db: Db, household: Household): void {
  db.prepare(
    `INSERT INTO households (
        id, account_id, referral_id, member_count, profile_id, profile_version,
        period_start, restrictions_json, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
        referral_id = excluded.referral_id, member_count = excluded.member_count,
        profile_id = excluded.profile_id, profile_version = excluded.profile_version,
        period_start = excluded.period_start, restrictions_json = excluded.restrictions_json`,
  ).run(
    household.id,
    household.accountId,
    household.referralId,
    household.memberCount,
    household.profileId,
    household.profileVersion,
    household.periodStart,
    JSON.stringify(household.restrictions),
    household.createdAt,
  );
}

// --- orders ---------------------------------------------------------------

export function rowToOrder(row: Row): Order {
  const snapshot = normalizeRulesSnapshot(json(row['rules_snapshot_json'], {} as RulesSnapshot));
  return {
    id: str(row['id']),
    householdId: str(row['household_id']),
    status: str(row['status'], 'draft') as Order['status'],
    rulesSnapshot: snapshot,
    lines: json<OrderLine[]>(row['lines_json'], []),
    createdAt: str(row['created_at']),
    updatedAt: str(row['updated_at']),
    finalizedAt: nullableStr(row['finalized_at']),
    staffInitials: str(row['staff_initials']),
    override: json<OrderOverride | null>(row['override_json'], null),
    totalCents: num(row['total_cents']),
    categoryTotalsUnits: json(row['category_totals_json'], {}),
    revision: num(row['revision'], 1),
    lastWriterId: str(row['last_writer_id']),
  };
}

export function findOrder(db: Db, id: string): Order | null {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Row | undefined;
  return row ? rowToOrder(row) : null;
}

export function upsertOrder(db: Db, order: Order): void {
  db.prepare(
    `INSERT INTO orders (
        id, household_id, status, rules_snapshot_json, lines_json, created_at, updated_at,
        finalized_at, staff_initials, override_json, total_cents, category_totals_json,
        revision, last_writer_id
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, rules_snapshot_json = excluded.rules_snapshot_json,
        lines_json = excluded.lines_json, updated_at = excluded.updated_at,
        finalized_at = excluded.finalized_at, staff_initials = excluded.staff_initials,
        override_json = excluded.override_json, total_cents = excluded.total_cents,
        category_totals_json = excluded.category_totals_json,
        revision = excluded.revision, last_writer_id = excluded.last_writer_id`,
  ).run(
    order.id,
    order.householdId,
    order.status,
    JSON.stringify(order.rulesSnapshot),
    JSON.stringify(order.lines),
    order.createdAt,
    order.updatedAt,
    order.finalizedAt,
    order.staffInitials,
    order.override ? JSON.stringify(order.override) : null,
    order.totalCents,
    JSON.stringify(order.categoryTotalsUnits),
    order.revision,
    order.lastWriterId,
  );
}

/** FR-A8: a customer's own history. */
export function listOrdersForAccount(db: Db, accountId: string): Order[] {
  const rows = db
    .prepare(
      `SELECT o.* FROM orders o
       JOIN households h ON h.id = o.household_id
       WHERE h.account_id = ?
       ORDER BY o.created_at DESC`,
    )
    .all(accountId) as Row[];
  return rows.map(rowToOrder);
}

export interface OrderSearch {
  from?: string;
  to?: string;
  referralId?: string;
  memberCount?: number;
  status?: Order['status'];
}

/** FR-34: staff and admin record search. */
export function searchOrders(db: Db, search: OrderSearch): Order[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (search.status) {
    clauses.push('o.status = ?');
    params.push(search.status);
  }
  if (search.from) {
    clauses.push("COALESCE(o.finalized_at, o.created_at) >= ?");
    params.push(search.from);
  }
  if (search.to) {
    // Inclusive of the whole end day.
    clauses.push("COALESCE(o.finalized_at, o.created_at) <= ?");
    params.push(`${search.to}T23:59:59.999Z`);
  }
  if (search.referralId) {
    clauses.push('h.referral_id = ?');
    params.push(search.referralId);
  }
  if (search.memberCount !== undefined) {
    clauses.push('h.member_count = ?');
    params.push(search.memberCount);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT o.* FROM orders o JOIN households h ON h.id = o.household_id
       ${where} ORDER BY COALESCE(o.finalized_at, o.created_at) DESC`,
    )
    .all(...params) as Row[];
  return rows.map(rowToOrder);
}

// --- meal plans -----------------------------------------------------------

export function rowToMealPlan(row: Row): MealPlan {
  return {
    id: str(row['id']),
    orderId: str(row['order_id']),
    generatedAt: str(row['generated_at']),
    seed: num(row['seed']),
    days: json(row['days_json'], []),
    unused: json(row['unused_json'], []),
    stale: bool(row['stale']),
    sourceLinesHash: str(row['source_lines_hash']),
    complete: bool(row['complete']),
  };
}

export function latestPlanForOrder(db: Db, orderId: string): MealPlan | null {
  const row = db
    .prepare('SELECT * FROM meal_plans WHERE order_id = ? ORDER BY generated_at DESC LIMIT 1')
    .get(orderId) as Row | undefined;
  return row ? rowToMealPlan(row) : null;
}

export function insertMealPlan(db: Db, plan: MealPlan): void {
  db.prepare(
    `INSERT INTO meal_plans (
        id, order_id, generated_at, seed, days_json, unused_json, stale,
        source_lines_hash, complete
     ) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    plan.id,
    plan.orderId,
    plan.generatedAt,
    plan.seed,
    JSON.stringify(plan.days),
    JSON.stringify(plan.unused),
    plan.stale ? 1 : 0,
    plan.sourceLinesHash,
    plan.complete ? 1 : 0,
  );
}

// --- audit ----------------------------------------------------------------

export function rowToAuditEvent(row: Row): AuditEvent {
  return {
    id: str(row['id']),
    orderId: nullableStr(row['order_id']),
    actor: str(row['actor']),
    actorAccountId: nullableStr(row['actor_account_id']),
    onBehalfOfAccountId: nullableStr(row['on_behalf_of_account_id']),
    action: str(row['action']) as AuditEvent['action'],
    detail: json(row['detail_json'], {}),
    at: str(row['at']),
  };
}

export function listAuditEvents(db: Db, limit = 500): AuditEvent[] {
  return (
    db.prepare('SELECT * FROM audit_events ORDER BY at DESC LIMIT ?').all(limit) as Row[]
  ).map(rowToAuditEvent);
}
