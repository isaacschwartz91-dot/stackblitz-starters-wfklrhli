/**
 * Domain model (spec section 4).
 *
 * Storage invariants:
 *  - Money is integer cents everywhere. Field names end in `Cents`.
 *  - Servings are integer quarter-servings. Field names end in `Units`.
 *  - Anything printed on a compliance sheet is snapshotted onto the order.
 */

export type CapBasis = 'per_member' | 'per_order';
export type OrderStatus = 'draft' | 'final' | 'void';
export type MealKey = 'breakfast' | 'lunch' | 'supper';

export const MEAL_KEYS: readonly MealKey[] = ['breakfast', 'lunch', 'supper'] as const;

/**
 * FR-27 / FR-4: shelf-life class drives which days of the period an item is
 * scheduled into. `fresh` is spent first, `shelf_stable` last.
 */
export type ShelfLifeClass = 'fresh' | 'refrigerated' | 'frozen' | 'shelf_stable';

export const SHELF_LIFE_CLASSES: readonly ShelfLifeClass[] = [
  'fresh',
  'refrigerated',
  'frozen',
  'shelf_stable',
] as const;

/** Lower = must be eaten sooner. Used to order items across the period. */
export const SHELF_LIFE_RANK: Record<ShelfLifeClass, number> = {
  fresh: 0,
  refrigerated: 1,
  frozen: 2,
  shelf_stable: 3,
};

/** FR-4 dietary/handling tags. Restriction matching (FR-10) works off these. */
export type DietaryTag =
  | 'halal'
  | 'kosher'
  | 'gluten_free'
  | 'low_sodium'
  | 'vegetarian'
  | 'vegan'
  | 'nut_free'
  | 'dairy_free'
  | 'shellfish_free'
  | 'pork_free';

export const DIETARY_TAGS: readonly DietaryTag[] = [
  'halal',
  'kosher',
  'gluten_free',
  'low_sodium',
  'vegetarian',
  'vegan',
  'nut_free',
  'dairy_free',
  'shellfish_free',
  'pork_free',
] as const;

/** FR-3: categories are data, not an enum. Renaming must not break orders. */
export interface Category {
  id: string;
  /** Stable machine key. Orders reference this; never change it after use. */
  key: string;
  /** Display name. Safe to rename at any time. */
  label: string;
  /** e.g. "cup-eq", "oz-eq" — the SCN's crediting unit (DECIDE #4). */
  unitLabel: string;
  sortOrder: number;
  active: boolean;
}

export interface CategoryRequirement {
  categoryKey: string;
  /** Integer quarter-servings per member per day. */
  servingsPerMemberPerDayUnits: number;
  /**
   * FR-22 (DECIDE): optional per-category ceiling, in quarter-servings per
   * member per day. Null = no maximum, which is the default.
   */
  maxServingsPerMemberPerDayUnits: number | null;
  /**
   * FR-22 (DECIDE): optional minimum distinct items in this category.
   * Null = no variety rule, which is the default.
   */
  minDistinctItems: number | null;
}

/** FR-25: fraction of a category's daily requirement assigned to one meal. */
export interface MealSplit {
  meal: MealKey;
  categoryKey: string;
  /** Basis points. All meals for one category must sum to 10000. */
  fractionBp: number;
}

/** FR-1 / FR-2: a versioned snapshot of one SCN contract's rules. */
export interface ProgramProfile {
  id: string;
  /** Stable across versions; versions of the same contract share this. */
  familyId: string;
  version: number;
  name: string;
  scnName: string;
  effectiveFrom: string; // ISO date
  effectiveTo: string | null;
  daysCovered: number;
  capAmountCents: number;
  capBasis: CapBasis;
  requirements: CategoryRequirement[];
  mealSplits: MealSplit[];
  /**
   * Section 5 (DECIDE): may items with zero creditable servings be purchased?
   * When false, they cannot be added to an order at all.
   */
  allowNonCreditableItems: boolean;
  /** FR-27: last day index (0-based) each shelf-life class should be used by. */
  shelfLifeHorizonDays: Record<ShelfLifeClass, number | null>;
  archived: boolean;
  createdAt: string;
}

/** FR-4 */
export interface Item {
  id: string;
  name: string;
  nameEs: string;
  packageSize: string;
  categoryKey: string;
  priceCents: number;
  /** Creditable quarter-servings in one whole package. May be 0. */
  servingsPerPackageUnits: number;
  sku: string;
  upc: string;
  tags: DietaryTag[];
  shelfLifeClass: ShelfLifeClass;
  active: boolean;
  updatedAt: string;
}

// --- accounts and sessions (section 3.0) ---------------------------------

export type AccountRole = 'customer' | 'staff' | 'admin';
export type AccountStatus = 'active' | 'suspended';

/**
 * FR-A1: accounts are created by staff when a referral arrives, never by open
 * self-registration.
 *
 * NFR-1: the identifier and the referral link are the whole record. No
 * address, date of birth, diagnosis, or referral reason is stored — the fact
 * that this person receives a Medicaid food benefit is itself the sensitive
 * datum, so there is nothing to gain by holding more.
 */
export interface Account {
  id: string;
  role: AccountRole;
  /** At least one of email/phone is present; both are sign-in identifiers. */
  email: string | null;
  phone: string | null;
  /** Display name for staff screens. Optional for customers. */
  displayName: string;
  status: AccountStatus;
  lastLoginAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** FR-A5 / FR-A6 */
export interface SessionRecord {
  id: string;
  accountId: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /** FR-A6: set only while staff are acting on a customer's behalf. */
  actingAsAccountId: string | null;
}

/** The caller identity every request is authorized against (NFR-3). */
export interface Principal {
  account: Account;
  sessionId: string;
  /** FR-A6: the customer being assisted, when staff are in assist mode. */
  actingAs: Account | null;
  /**
   * Whose data this request may touch. In assist mode this is the customer;
   * otherwise it is the signed-in account itself.
   */
  effectiveAccountId: string;
  assistMode: boolean;
}

/** FR-9 / FR-10 */
export interface Household {
  id: string;
  /** FR-A2: one account, one household. */
  accountId: string;
  referralId: string;
  memberCount: number;
  profileId: string;
  profileVersion: number;
  periodStart: string; // ISO date
  /** Dietary tags every item in the plan must carry. */
  restrictions: DietaryTag[];
  createdAt: string;
}

/**
 * FR-2 / FR-33: the rules an order was built against, frozen at draft time.
 * Nothing on the compliance sheet is looked up live.
 */
export interface RulesSnapshot {
  profileId: string;
  profileFamilyId: string;
  profileVersion: number;
  profileName: string;
  scnName: string;
  daysCovered: number;
  capAmountCents: number;
  capBasis: CapBasis;
  memberCount: number;
  /** Cap in cents for this order, already multiplied out. */
  capTotalCents: number;
  requirements: CategoryRequirement[];
  mealSplits: MealSplit[];
  allowNonCreditableItems: boolean;
  shelfLifeHorizonDays: Record<ShelfLifeClass, number | null>;
  /** Label + unit snapshot so a later rename cannot rewrite an old sheet. */
  categories: { key: string; label: string; unitLabel: string; sortOrder: number }[];
  /** Total required quarter-servings per category for the whole order. */
  requiredUnitsByCategory: Record<string, number>;
  snapshotAt: string;
}

/** FR-6 / FR-33: line items carry their own copies of everything printable. */
export interface OrderLine {
  id: string;
  itemId: string;
  itemNameSnapshot: string;
  itemNameEsSnapshot: string;
  packageSizeSnapshot: string;
  qty: number;
  unitPriceCentsSnapshot: number;
  /** Quarter-servings per package, snapshotted. */
  servingsUnitsSnapshot: number;
  categorySnapshot: string;
  tagsSnapshot: DietaryTag[];
  shelfLifeClassSnapshot: ShelfLifeClass;
  addedAt: string;
}

export interface OrderOverride {
  reason: string;
  staffInitials: string;
  at: string;
  /** What was wrong at the moment the override was applied. */
  violations: string[];
}

export interface Order {
  id: string;
  householdId: string;
  status: OrderStatus;
  rulesSnapshot: RulesSnapshot;
  lines: OrderLine[];
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  staffInitials: string;
  override: OrderOverride | null;
  totalCents: number;
  /** FR-33: category totals frozen at finalize time. */
  categoryTotalsUnits: Record<string, number>;
  /** Optimistic-concurrency counter for the last-write-wins warning. */
  revision: number;
  /** Device that wrote `revision` last, for the conflict warning. */
  lastWriterId: string;
}

export interface MealSlotItem {
  itemId: string;
  itemName: string;
  itemNameEs: string;
  categoryKey: string;
  /** Quarter-servings of this item served in this slot. */
  units: number;
}

export interface MealSlotShortfall {
  categoryKey: string;
  /** Quarter-servings that could not be filled. */
  units: number;
}

export interface MealSlot {
  meal: MealKey;
  items: MealSlotItem[];
  /** FR-28: empty when the meal is fully filled. */
  shortfalls: MealSlotShortfall[];
}

export interface PlanDay {
  dayIndex: number;
  date: string; // ISO date
  meals: MealSlot[];
}

export interface UnusedItem {
  itemId: string;
  itemName: string;
  /** Quarter-servings purchased but never scheduled. */
  leftoverUnits: number;
  /** True when no part of the item was used anywhere. */
  entirelyUnused: boolean;
  /**
   * True for items that credit no servings (cooking oil, spices). They are
   * never schedulable, so they are listed for the record rather than as waste.
   */
  nonCreditable: boolean;
}

/** FR-24 .. FR-30 */
export interface MealPlan {
  id: string;
  orderId: string;
  generatedAt: string;
  seed: number;
  days: PlanDay[];
  unused: UnusedItem[];
  /** True when the order changed after this plan was made (section 5). */
  stale: boolean;
  /** Hash of the order lines the plan was generated from. */
  sourceLinesHash: string;
  complete: boolean;
}

export type AuditAction =
  | 'sign_in'
  | 'sign_in_failed'
  | 'sign_out'
  | 'account_locked'
  | 'account_unlocked'
  | 'account_created'
  | 'account_suspended'
  | 'account_reinstated'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'staff_password_reset'
  | 'assist_mode_started'
  | 'assist_mode_ended'
  | 'authorization_denied'
  | 'profile_created'
  | 'profile_updated'
  | 'profile_version_created'
  | 'category_created'
  | 'category_updated'
  | 'price_changed'
  | 'item_created'
  | 'item_updated'
  | 'item_deactivated'
  | 'catalog_imported'
  | 'order_created'
  | 'order_finalized'
  | 'order_voided'
  | 'override_applied'
  | 'records_exported'
  | 'plan_generated'
  | 'settings_updated'
  | 'admin_unlocked'
  | 'admin_unlock_failed'
  | 'retention_purge';

/** NFR-6 */
export interface AuditEvent {
  id: string;
  orderId: string | null;
  /** Human-readable actor label, kept for display. */
  actor: string;
  /**
   * FR-A6: the account that actually performed the action. In assist mode
   * this is the staff member, never the customer being assisted.
   */
  actorAccountId: string | null;
  /** FR-A6: the customer whose data was touched, when acting on their behalf. */
  onBehalfOfAccountId: string | null;
  action: AuditAction;
  detail: Record<string, unknown>;
  at: string;
}

export type RestrictionMode = 'hide' | 'flag';
export type Language = 'en' | 'es';

/** App-level settings; every DECIDE item that is a policy choice lives here. */
export interface AppSettings {
  /** NFR-2/NFR-3: SHA-256 of the admin passcode. Never the passcode itself. */
  adminPasscodeHash: string | null;
  /** FR-10 (DECIDE): hide conflicting items or show them flagged. */
  restrictionMode: RestrictionMode;
  /** FR-8 (DECIDE): is a barcode scanner present at the counter? */
  barcodeScannerEnabled: boolean;
  /** NFR-5: how long finalized records are kept, in days. */
  retentionDays: number;
  language: Language;
  storeName: string;
  /** Stable per-device id, used for the concurrent-edit warning. */
  deviceId: string;
}
