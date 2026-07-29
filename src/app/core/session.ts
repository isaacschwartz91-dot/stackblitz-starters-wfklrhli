/**
 * The order currently being built.
 *
 * Holds the active household and draft order, and exposes the compliance
 * picture as computed signals so FR-14/FR-15 recalculate on every tap without
 * anyone having to remember to call a refresh (NFR-9).
 */

import { Injectable, computed, signal } from '@angular/core';

import { DataStore } from './store';
import { newId } from '../../shared/ids';
import { detectWriteConflict } from '../../shared/validation';
import type {
  DietaryTag,
  Household,
  Item,
  MealPlan,
  Order,
  OrderLine,
  OrderOverride,
  ProgramProfile,
} from '../../shared/types';
import {
  cheapestCompliantBasket,
  evaluateOrder,
  planCapRecovery,
  suggestAll,
} from '../../shared/compliance/engine';
import { generateMealPlan, hashOrderLines } from '../../shared/mealplan/planner';

export interface PriceDrift {
  lineId: string;
  itemName: string;
  capturedCents: number;
  currentCents: number;
}

@Injectable({ providedIn: 'root' })
export class OrderSession {
  private readonly currentOrderId = signal<string | null>(null);
  readonly conflictWarning = signal<string | null>(null);
  readonly lastSavedAt = signal<string | null>(null);

  constructor(private readonly store: DataStore) {}

  readonly order = computed<Order | null>(() => {
    const id = this.currentOrderId();
    if (!id) return null;
    return this.store.orders().find((o) => o.id === id) ?? null;
  });

  readonly household = computed<Household | null>(() => {
    const order = this.order();
    if (!order) return null;
    return this.store.households().find((h) => h.id === order.householdId) ?? null;
  });

  readonly restrictions = computed<DietaryTag[]>(() => this.household()?.restrictions ?? []);

  readonly hasOrder = computed(() => this.order() !== null);

  /** FR-14, FR-15, FR-21, FR-22, FR-23 — recomputed on every change. */
  readonly compliance = computed(() => {
    const order = this.order();
    if (!order) return null;
    return evaluateOrder(order.lines, order.rulesSnapshot);
  });

  /** FR-16 */
  readonly suggestions = computed(() => {
    const order = this.order();
    const result = this.compliance();
    if (!order || !result) return {};
    return suggestAll(result, this.store.activeItems(), this.restrictions(), 3);
  });

  /** FR-17 */
  readonly capRecovery = computed(() => {
    const order = this.order();
    const result = this.compliance();
    if (!order || !result || !result.overCap) return null;
    return planCapRecovery(
      order.lines,
      order.rulesSnapshot,
      this.store.activeItems(),
      this.restrictions(),
    );
  });

  /** Section 5: is the contract itself unachievable from this catalog? */
  readonly cheapestBasket = computed(() => {
    const order = this.order();
    if (!order) return null;
    return cheapestCompliantBasket(
      order.rulesSnapshot,
      this.store.activeItems(),
      this.restrictions(),
    );
  });

  /** FR-6: warn when a catalog price moved after an item was added. */
  readonly priceDrift = computed<PriceDrift[]>(() => {
    const order = this.order();
    if (!order) return [];
    const catalog = this.store.items();
    const drift: PriceDrift[] = [];
    for (const line of order.lines) {
      const item = catalog.find((i) => i.id === line.itemId);
      if (item && item.priceCents !== line.unitPriceCentsSnapshot) {
        drift.push({
          lineId: line.id,
          itemName: line.itemNameSnapshot,
          capturedCents: line.unitPriceCentsSnapshot,
          currentCents: item.priceCents,
        });
      }
    }
    return drift;
  });

  readonly plan = computed<MealPlan | null>(() => {
    const order = this.order();
    if (!order) return null;
    const plan = this.store.planForOrder(order.id);
    if (!plan) return null;
    // Section 5: a plan built from different lines is stale, not current.
    const stale = plan.sourceLinesHash !== hashOrderLines(order.lines);
    return stale === plan.stale ? plan : { ...plan, stale };
  });

  // --- lifecycle ----------------------------------------------------------

  async startOrder(
    household: Omit<Household, 'id' | 'createdAt'>,
    profile: ProgramProfile,
  ): Promise<Order> {
    const householdRecord: Household = {
      ...household,
      id: newId('hh'),
      createdAt: new Date().toISOString(),
    };
    await this.store.saveHousehold(householdRecord);

    const now = new Date().toISOString();
    const order: Order = {
      id: newId('order'),
      householdId: householdRecord.id,
      status: 'draft',
      rulesSnapshot: this.store.buildRulesSnapshot(profile, householdRecord.memberCount),
      lines: [],
      createdAt: now,
      updatedAt: now,
      finalizedAt: null,
      staffInitials: '',
      override: null,
      totalCents: 0,
      categoryTotalsUnits: {},
      revision: 1,
      lastWriterId: this.store.settings().deviceId,
    };

    await this.store.saveOrder(order);
    await this.store.logAudit(
      'order_created',
      { referralId: householdRecord.referralId, memberCount: householdRecord.memberCount },
      order.id,
    );
    this.currentOrderId.set(order.id);
    this.lastSavedAt.set(now);
    return order;
  }

  resume(orderId: string): void {
    this.currentOrderId.set(orderId);
    this.conflictWarning.set(null);
  }

  close(): void {
    this.currentOrderId.set(null);
    this.conflictWarning.set(null);
  }

  // --- editing ------------------------------------------------------------

  private async commit(mutate: (order: Order) => Order): Promise<void> {
    const current = this.order();
    if (!current) return;

    // Section 5: last write wins, but say so when another device got there
    // first. `current` is what this device last read.
    const stored = this.store.orders().find((o) => o.id === current.id);
    if (stored) {
      const { conflict, message } = detectWriteConflict(
        stored.revision,
        stored.lastWriterId,
        current.revision,
        this.store.settings().deviceId,
      );
      if (conflict) this.conflictWarning.set(message);
    }

    const next = mutate(current);
    const saved: Order = {
      ...next,
      updatedAt: new Date().toISOString(),
      revision: current.revision + 1,
      lastWriterId: this.store.settings().deviceId,
      totalCents: next.lines.reduce((sum, l) => sum + l.unitPriceCentsSnapshot * l.qty, 0),
    };
    await this.store.saveOrder(saved);
    this.lastSavedAt.set(saved.updatedAt);
  }

  /** FR-13: add whole packages. Re-adding an item bumps its quantity. */
  async addItem(item: Item, qty = 1): Promise<void> {
    if (qty <= 0) return;
    const order = this.order();
    if (!order) return;

    // Section 5 / DECIDE: the contract may forbid non-creditable purchases.
    if (item.servingsPerPackageUnits === 0 && !order.rulesSnapshot.allowNonCreditableItems) {
      return;
    }

    await this.commit((current) => {
      const existing = current.lines.find((l) => l.itemId === item.id);
      if (existing) {
        return {
          ...current,
          lines: current.lines.map((l) =>
            l.id === existing.id ? { ...l, qty: l.qty + qty } : l,
          ),
        };
      }
      // FR-6: capture price and servings now; later catalog edits cannot
      // reach back into an order already in progress.
      const line: OrderLine = {
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
        addedAt: new Date().toISOString(),
      };
      return { ...current, lines: [...current.lines, line] };
    });
  }

  async setQuantity(lineId: string, qty: number): Promise<void> {
    if (!Number.isInteger(qty) || qty < 0) return;
    await this.commit((current) => ({
      ...current,
      lines:
        qty === 0
          ? current.lines.filter((l) => l.id !== lineId)
          : current.lines.map((l) => (l.id === lineId ? { ...l, qty } : l)),
    }));
  }

  async removeLine(lineId: string): Promise<void> {
    await this.commit((current) => ({
      ...current,
      lines: current.lines.filter((l) => l.id !== lineId),
    }));
  }

  /** FR-6: staff price correction, applied to this order only. */
  async correctPrice(lineId: string, priceCents: number): Promise<void> {
    if (priceCents < 0) return;
    const order = this.order();
    if (!order) return;
    const line = order.lines.find((l) => l.id === lineId);
    await this.commit((current) => ({
      ...current,
      lines: current.lines.map((l) =>
        l.id === lineId ? { ...l, unitPriceCentsSnapshot: priceCents } : l,
      ),
    }));
    if (line) {
      await this.store.logAudit(
        'price_changed',
        {
          scope: 'order_line',
          itemName: line.itemNameSnapshot,
          fromCents: line.unitPriceCentsSnapshot,
          toCents: priceCents,
        },
        order.id,
        'staff',
      );
    }
  }

  /** FR-6: accept the current catalog price for a drifted line. */
  async acceptCurrentPrice(lineId: string): Promise<void> {
    const order = this.order();
    const line = order?.lines.find((l) => l.id === lineId);
    if (!order || !line) return;
    const item = this.store.items().find((i) => i.id === line.itemId);
    if (!item) return;
    await this.correctPrice(lineId, item.priceCents);
  }

  // --- finalize (FR-18) ---------------------------------------------------

  /**
   * FR-18: an order cannot be finalized while short or over the cap unless
   * staff record an override with a reason.
   */
  async finalize(staffInitials: string, override?: { reason: string }): Promise<
    { ok: true; order: Order } | { ok: false; reason: string }
  > {
    const order = this.order();
    const result = this.compliance();
    if (!order || !result) return { ok: false, reason: 'No order is open.' };
    if (!staffInitials.trim()) return { ok: false, reason: 'Staff initials are required.' };

    if (!result.canFinalize && !override?.reason?.trim()) {
      return {
        ok: false,
        reason: 'This order is short or over the cap. An override with a reason is required.',
      };
    }

    const now = new Date().toISOString();
    const categoryTotals: Record<string, number> = {};
    for (const cat of result.categories) categoryTotals[cat.categoryKey] = cat.inCartUnits;

    const recordedOverride: OrderOverride | null =
      !result.canFinalize && override
        ? {
            reason: override.reason.trim(),
            staffInitials: staffInitials.trim(),
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
      staffInitials: staffInitials.trim(),
      override: recordedOverride,
      totalCents: result.totalCents,
      categoryTotalsUnits: categoryTotals,
      revision: order.revision + 1,
      lastWriterId: this.store.settings().deviceId,
    };

    await this.store.saveOrder(finalized);

    if (recordedOverride) {
      await this.store.logAudit(
        'override_applied',
        {
          reason: recordedOverride.reason,
          staffInitials: recordedOverride.staffInitials,
          violations: recordedOverride.violations,
        },
        finalized.id,
        'staff',
      );
    }
    await this.store.logAudit(
      'order_finalized',
      {
        totalCents: finalized.totalCents,
        capTotalCents: finalized.rulesSnapshot.capTotalCents,
        overridden: recordedOverride !== null,
      },
      finalized.id,
      'staff',
    );

    return { ok: true, order: finalized };
  }

  // --- meal plan ----------------------------------------------------------

  /** FR-24 / FR-30. A new seed each time gives staff a genuine reroll. */
  async generatePlan(seed = Math.floor(Math.random() * 2_147_483_647)): Promise<MealPlan | null> {
    const order = this.order();
    const household = this.household();
    if (!order || !household) return null;

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
      generatedAt: new Date().toISOString(),
      seed,
      days: generated.days,
      unused: generated.unused,
      stale: false,
      sourceLinesHash: hashOrderLines(order.lines),
      complete: generated.complete,
    };

    await this.store.saveMealPlan(plan);
    await this.store.logAudit(
      'plan_generated',
      { seed, complete: plan.complete, days: plan.days.length },
      order.id,
    );
    return plan;
  }
}
