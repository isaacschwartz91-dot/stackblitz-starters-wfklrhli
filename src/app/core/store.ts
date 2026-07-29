/**
 * Application data store.
 *
 * Signal-backed, write-through to IndexedDB. Every mutation updates the
 * in-memory signal and persists in the same call, so a tab closed or a
 * connection dropped mid-order loses nothing (NFR-8).
 */

import { Injectable, computed, signal } from '@angular/core';

import * as idb from './idb';
import { STORES } from './idb';
import { deviceId, newId } from '../../shared/ids';
import { DEFAULT_SHELF_LIFE_HORIZONS, SEED_CATEGORIES, seedItems, seedProfile } from './seed';
import type {
  AppSettings,
  AuditAction,
  AuditEvent,
  Category,
  Household,
  Item,
  MealPlan,
  Order,
  ProgramProfile,
  RulesSnapshot,
} from '../../shared/types';
import { requiredUnitsByCategory, capTotalCents } from '../../shared/compliance/engine';

const SETTINGS_KEY = 'app';

function defaultSettings(): AppSettings {
  return {
    adminPasscodeHash: null,
    // FR-10 (DECIDE): default to flagging. Staff can see and explain why an
    // item is unsuitable, which they cannot do if it silently disappears.
    // Switch to 'hide' in Admin if the store prefers a cleaner customer view.
    restrictionMode: 'flag',
    // FR-8 (DECIDE): off until the owner confirms a scanner is at the counter.
    barcodeScannerEnabled: false,
    // NFR-5 (DECIDE): 6 years is the common Medicaid record retention floor.
    // Replace with whatever the SCN contract actually requires.
    retentionDays: 2192,
    language: 'en',
    storeName: '',
    deviceId: deviceId(),
  };
}

@Injectable({ providedIn: 'root' })
export class DataStore {
  readonly ready = signal(false);
  readonly loadError = signal<string | null>(null);

  readonly categories = signal<Category[]>([]);
  readonly profiles = signal<ProgramProfile[]>([]);
  readonly items = signal<Item[]>([]);
  readonly households = signal<Household[]>([]);
  readonly orders = signal<Order[]>([]);
  readonly mealPlans = signal<MealPlan[]>([]);
  readonly auditEvents = signal<AuditEvent[]>([]);
  readonly settings = signal<AppSettings>(defaultSettings());

  readonly activeCategories = computed(() =>
    this.categories()
      .filter((c) => c.active)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  );

  readonly activeItems = computed(() => this.items().filter((i) => i.active));

  /** Latest non-archived version of each profile family (FR-2). */
  readonly currentProfiles = computed(() => {
    const byFamily = new Map<string, ProgramProfile>();
    for (const profile of this.profiles()) {
      if (profile.archived) continue;
      const existing = byFamily.get(profile.familyId);
      if (!existing || profile.version > existing.version) byFamily.set(profile.familyId, profile);
    }
    return [...byFamily.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  readonly draftOrders = computed(() => this.orders().filter((o) => o.status === 'draft'));
  readonly finalizedOrders = computed(() =>
    this.orders()
      .filter((o) => o.status === 'final')
      .sort((a, b) => (b.finalizedAt ?? '').localeCompare(a.finalizedAt ?? '')),
  );

  async load(): Promise<void> {
    try {
      if (!idb.isIndexedDbAvailable()) {
        throw new Error('This browser has no IndexedDB, so orders cannot be saved.');
      }

      const [categories, profiles, items, households, orders, mealPlans, audit, storedSettings] =
        await Promise.all([
          idb.getAll<Category>(STORES.categories),
          idb.getAll<ProgramProfile>(STORES.profiles),
          idb.getAll<Item>(STORES.items),
          idb.getAll<Household>(STORES.households),
          idb.getAll<Order>(STORES.orders),
          idb.getAll<MealPlan>(STORES.mealPlans),
          idb.getAll<AuditEvent>(STORES.audit),
          idb.getOne<AppSettings>(STORES.settings, SETTINGS_KEY),
        ]);

      this.settings.set({ ...defaultSettings(), ...(storedSettings ?? {}), deviceId: deviceId() });

      if (categories.length === 0 && profiles.length === 0 && items.length === 0) {
        await this.seedFirstRun();
      } else {
        this.categories.set(categories);
        this.profiles.set(profiles);
        this.items.set(items);
      }

      this.households.set(households);
      this.orders.set(orders);
      this.mealPlans.set(mealPlans);
      this.auditEvents.set(audit);
      this.ready.set(true);
    } catch (error) {
      this.loadError.set(error instanceof Error ? error.message : String(error));
      this.ready.set(true);
    }
  }

  private async seedFirstRun(): Promise<void> {
    const categories = SEED_CATEGORIES;
    const profile = seedProfile();
    const items = seedItems();

    await Promise.all([
      idb.putMany(STORES.categories, categories),
      idb.putMany(STORES.profiles, [profile]),
      idb.putMany(STORES.items, items),
      idb.put(STORES.settings, this.settings(), SETTINGS_KEY),
    ]);

    this.categories.set(categories);
    this.profiles.set([profile]);
    this.items.set(items);
  }

  // --- audit (NFR-4) ------------------------------------------------------

  async logAudit(
    action: AuditAction,
    detail: Record<string, unknown>,
    orderId: string | null = null,
    actor = 'staff',
  ): Promise<void> {
    const event: AuditEvent = {
      id: newId('audit'),
      orderId,
      actor,
      action,
      detail,
      at: new Date().toISOString(),
    };
    await idb.put(STORES.audit, event);
    this.auditEvents.update((events) => [...events, event]);
  }

  // --- settings -----------------------------------------------------------

  async saveSettings(patch: Partial<AppSettings>): Promise<void> {
    const next = { ...this.settings(), ...patch };
    await idb.put(STORES.settings, next, SETTINGS_KEY);
    this.settings.set(next);
    // The passcode hash is never written into the audit trail.
    const { adminPasscodeHash: _omit, ...loggable } = patch;
    if (Object.keys(loggable).length > 0) {
      await this.logAudit('settings_updated', loggable, null, 'admin');
    }
  }

  // --- categories (FR-3) --------------------------------------------------

  async saveCategory(category: Category, isNew: boolean): Promise<void> {
    await idb.put(STORES.categories, category);
    this.categories.update((list) => {
      const index = list.findIndex((c) => c.id === category.id);
      if (index === -1) return [...list, category];
      const next = list.slice();
      next[index] = category;
      return next;
    });
    await this.logAudit(
      isNew ? 'category_created' : 'category_updated',
      { key: category.key, label: category.label, active: category.active },
      null,
      'admin',
    );
  }

  // --- profiles (FR-1, FR-2) ---------------------------------------------

  async saveProfile(profile: ProgramProfile, isNew: boolean): Promise<void> {
    await idb.put(STORES.profiles, profile);
    this.profiles.update((list) => {
      const index = list.findIndex((p) => p.id === profile.id);
      if (index === -1) return [...list, profile];
      const next = list.slice();
      next[index] = profile;
      return next;
    });
    await this.logAudit(
      isNew ? 'profile_created' : 'profile_updated',
      { id: profile.id, name: profile.name, version: profile.version },
      null,
      'admin',
    );
  }

  /**
   * FR-2: rule changes create a new version rather than editing in place, so
   * orders already completed under the previous version keep their meaning.
   */
  async createProfileVersion(base: ProgramProfile, changes: Partial<ProgramProfile>): Promise<ProgramProfile> {
    const siblings = this.profiles().filter((p) => p.familyId === base.familyId);
    const nextVersion = Math.max(...siblings.map((p) => p.version)) + 1;

    const created: ProgramProfile = {
      ...base,
      ...changes,
      id: newId('profile'),
      familyId: base.familyId,
      version: nextVersion,
      effectiveFrom: changes.effectiveFrom ?? new Date().toISOString().slice(0, 10),
      archived: false,
      createdAt: new Date().toISOString(),
    };

    // Close out the previous version the day the new one takes effect.
    const previous: ProgramProfile = { ...base, effectiveTo: created.effectiveFrom };

    await Promise.all([
      idb.put(STORES.profiles, created),
      idb.put(STORES.profiles, previous),
    ]);
    this.profiles.update((list) => [
      ...list.map((p) => (p.id === previous.id ? previous : p)),
      created,
    ]);
    await this.logAudit(
      'profile_version_created',
      { familyId: base.familyId, fromVersion: base.version, toVersion: nextVersion },
      null,
      'admin',
    );
    return created;
  }

  // --- items (FR-4 .. FR-7) ----------------------------------------------

  async saveItem(item: Item, isNew: boolean): Promise<void> {
    const previous = this.items().find((i) => i.id === item.id);
    const next = { ...item, updatedAt: new Date().toISOString() };

    await idb.put(STORES.items, next);
    this.items.update((list) => {
      const index = list.findIndex((i) => i.id === next.id);
      if (index === -1) return [...list, next];
      const copy = list.slice();
      copy[index] = next;
      return copy;
    });

    // NFR-4: price changes are audited specifically, not lumped in with edits.
    if (previous && previous.priceCents !== next.priceCents) {
      await this.logAudit(
        'price_changed',
        {
          itemId: next.id,
          name: next.name,
          fromCents: previous.priceCents,
          toCents: next.priceCents,
        },
        null,
        'admin',
      );
    }
    await this.logAudit(
      isNew ? 'item_created' : 'item_updated',
      { itemId: next.id, name: next.name },
      null,
      'admin',
    );
  }

  /** FR-7: items are deactivated, never deleted — orders reference them. */
  async setItemActive(itemId: string, active: boolean): Promise<void> {
    const item = this.items().find((i) => i.id === itemId);
    if (!item) return;
    await this.saveItem({ ...item, active }, false);
    if (!active) {
      await this.logAudit('item_deactivated', { itemId, name: item.name }, null, 'admin');
    }
  }

  async importItems(items: readonly Item[], summary: Record<string, unknown>): Promise<void> {
    await idb.putMany(STORES.items, items);
    this.items.update((list) => {
      const byId = new Map(list.map((i) => [i.id, i]));
      for (const item of items) byId.set(item.id, item);
      return [...byId.values()];
    });
    await this.logAudit('catalog_imported', summary, null, 'admin');
  }

  // --- households ---------------------------------------------------------

  async saveHousehold(household: Household): Promise<void> {
    await idb.put(STORES.households, household);
    this.households.update((list) => {
      const index = list.findIndex((h) => h.id === household.id);
      if (index === -1) return [...list, household];
      const next = list.slice();
      next[index] = household;
      return next;
    });
  }

  // --- orders -------------------------------------------------------------

  async saveOrder(order: Order): Promise<void> {
    await idb.put(STORES.orders, order);
    this.orders.update((list) => {
      const index = list.findIndex((o) => o.id === order.id);
      if (index === -1) return [...list, order];
      const next = list.slice();
      next[index] = order;
      return next;
    });
  }

  async saveMealPlan(plan: MealPlan): Promise<void> {
    await idb.put(STORES.mealPlans, plan);
    this.mealPlans.update((list) => {
      const index = list.findIndex((p) => p.id === plan.id);
      if (index === -1) return [...list, plan];
      const next = list.slice();
      next[index] = plan;
      return next;
    });
  }

  planForOrder(orderId: string): MealPlan | undefined {
    return this.mealPlans()
      .filter((p) => p.orderId === orderId)
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
  }

  householdFor(order: Order): Household | undefined {
    return this.households().find((h) => h.id === order.householdId);
  }

  // --- rules snapshot (FR-2, FR-33) ---------------------------------------

  /**
   * Freeze the rules an order is built against. Called once, when the order
   * is created; never recomputed afterwards, so later admin edits cannot
   * change what an existing order was measured against.
   */
  buildRulesSnapshot(profile: ProgramProfile, memberCount: number): RulesSnapshot {
    const categories = this.activeCategories()
      .filter((c) => profile.requirements.some((r) => r.categoryKey === c.key))
      .map((c) => ({ key: c.key, label: c.label, unitLabel: c.unitLabel, sortOrder: c.sortOrder }));

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
      capTotalCents: capTotalCents(profile.capAmountCents, profile.capBasis, memberCount),
      requirements: profile.requirements.map((r) => ({ ...r })),
      mealSplits: profile.mealSplits.map((s) => ({ ...s })),
      allowNonCreditableItems: profile.allowNonCreditableItems,
      shelfLifeHorizonDays: { ...DEFAULT_SHELF_LIFE_HORIZONS, ...profile.shelfLifeHorizonDays },
      categories,
      requiredUnitsByCategory: requiredUnitsByCategory(
        profile.requirements,
        memberCount,
        profile.daysCovered,
      ),
      snapshotAt: new Date().toISOString(),
    };
  }

  // --- retention (NFR-5) --------------------------------------------------

  /** Finalized orders older than the retention window, ready to purge. */
  expiredOrders(): Order[] {
    const days = this.settings().retentionDays;
    if (!days || days <= 0) return [];
    const cutoff = Date.now() - days * 86_400_000;
    return this.orders().filter(
      (o) => o.status === 'final' && o.finalizedAt !== null && Date.parse(o.finalizedAt) < cutoff,
    );
  }

  async purgeExpiredOrders(): Promise<number> {
    const expired = this.expiredOrders();
    for (const order of expired) {
      await idb.remove(STORES.orders, order.id);
      for (const plan of this.mealPlans().filter((p) => p.orderId === order.id)) {
        await idb.remove(STORES.mealPlans, plan.id);
      }
    }
    if (expired.length > 0) {
      const ids = new Set(expired.map((o) => o.id));
      this.orders.update((list) => list.filter((o) => !ids.has(o.id)));
      this.mealPlans.update((list) => list.filter((p) => !ids.has(p.orderId)));
      await this.logAudit(
        'retention_purge',
        { count: expired.length, retentionDays: this.settings().retentionDays },
        null,
        'admin',
      );
    }
    return expired.length;
  }
}
