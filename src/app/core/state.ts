/**
 * Client application state.
 *
 * Holds the signed-in account, the catalog, and the order being built, and
 * derives the whole compliance picture with the *same* engine the server uses
 * (src/shared). That is what makes FR-14/FR-15 instant on every tap (NFR-12)
 * without asking the server to re-score after each button press — while the
 * server still re-evaluates independently at finalize, so the record never
 * depends on anything the browser computed.
 */

import { Injectable, computed, effect, inject, signal } from '@angular/core';

import { ApiClient, ApiFailure } from './api';
import { DraftStore } from './drafts';
import type {
  Account,
  Category,
  DietaryTag,
  Household,
  Item,
  MealPlan,
  Order,
} from '../../shared/types';
import {
  cheapestCompliantBasket,
  evaluateOrder,
  itemConflicts,
  planCapRecovery,
  suggestAll,
} from '../../shared/compliance/engine';
import { hashOrderLines } from '../../shared/mealplan/planner';

export type Screen =
  | 'signin'
  | 'order'
  | 'plan'
  | 'history'
  | 'records'
  | 'accounts'
  | 'admin';

@Injectable({ providedIn: 'root' })
export class AppState {
  private readonly api = inject(ApiClient);
  private readonly drafts = inject(DraftStore);

  readonly booting = signal(true);
  readonly account = signal<Account | null>(null);
  readonly actingAs = signal<Account | null>(null);
  readonly assistMode = signal(false);
  readonly household = signal<Household | null>(null);

  readonly categories = signal<Category[]>([]);
  readonly items = signal<Item[]>([]);
  readonly order = signal<Order | null>(null);
  readonly plan = signal<MealPlan | null>(null);
  readonly history = signal<Order[]>([]);

  readonly screen = signal<Screen>('signin');
  readonly banner = signal<string | null>(null);
  readonly errorMessage = signal<string | null>(null);
  readonly busy = signal(false);

  readonly online = this.api.online;
  readonly hasPendingEdits = this.drafts.hasPending;

  readonly signedIn = computed(() => this.account() !== null);
  readonly role = computed(() => this.account()?.role ?? 'customer');
  readonly isStaff = computed(() => this.role() !== 'customer');
  readonly isAdmin = computed(() => this.role() === 'admin');
  /** FR-A7: drives the "view only" state in the UI. */
  readonly suspended = computed(
    () => (this.actingAs() ?? this.account())?.status === 'suspended',
  );

  readonly restrictions = computed<DietaryTag[]>(() => this.household()?.restrictions ?? []);
  readonly activeItems = computed(() => this.items().filter((i) => i.active));

  /** FR-14, FR-15, FR-21, FR-22, FR-23 */
  readonly compliance = computed(() => {
    const order = this.order();
    if (!order) return null;
    return evaluateOrder(order.lines, order.rulesSnapshot);
  });

  /** FR-16 */
  readonly suggestions = computed(() => {
    const result = this.compliance();
    if (!result) return {};
    return suggestAll(result, this.activeItems(), this.restrictions(), 3);
  });

  /** FR-17 */
  readonly capRecovery = computed(() => {
    const order = this.order();
    const result = this.compliance();
    if (!order || !result?.overCap) return null;
    return planCapRecovery(order.lines, order.rulesSnapshot, this.activeItems(), this.restrictions());
  });

  /** Section 5: distinguishes a bad basket from an unsatisfiable contract. */
  readonly cheapestBasket = computed(() => {
    const order = this.order();
    if (!order) return null;
    return cheapestCompliantBasket(order.rulesSnapshot, this.activeItems(), this.restrictions());
  });

  /** Section 5: a plan built from different lines is stale, not current. */
  readonly planIsStale = computed(() => {
    const plan = this.plan();
    const order = this.order();
    if (!plan || !order) return false;
    return plan.sourceLinesHash !== hashOrderLines(order.lines);
  });

  /** FR-6: warn when a catalog price moved after an item was added. */
  readonly priceDrift = computed(() => {
    const order = this.order();
    if (!order) return [];
    const catalog = this.items();
    return order.lines.flatMap((line) => {
      const item = catalog.find((i) => i.id === line.itemId);
      if (!item || item.priceCents === line.unitPriceCentsSnapshot) return [];
      return [
        {
          lineId: line.id,
          itemName: line.itemNameSnapshot,
          capturedCents: line.unitPriceCentsSnapshot,
          currentCents: item.priceCents,
        },
      ];
    });
  });

  /** FR-10: which restrictions an item fails, for flag mode. */
  conflictsFor(item: Item): DietaryTag[] {
    return itemConflicts(item, this.restrictions());
  }

  constructor() {
    // FR-A5: when the server says the session is gone, drop to sign-in
    // rather than leaving a dead screen that silently fails every action.
    effect(() => {
      if (this.api.sessionEnded() && this.account() !== null) {
        this.account.set(null);
        this.screen.set('signin');
        this.banner.set('Your session ended. Sign in again to continue.');
      }
    });

    // NFR-11: flush anything queued the moment the connection returns.
    effect(() => {
      if (this.online() && this.hasPendingEdits() && this.signedIn()) {
        void this.flushPending();
      }
    });
  }

  // --- lifecycle ----------------------------------------------------------

  async boot(): Promise<void> {
    this.booting.set(true);
    try {
      const me = await this.api.me();
      this.applyMe(me);
      await this.loadCatalog();
      await this.resumeOrCreateNothing();
      this.screen.set(this.isStaff() ? 'accounts' : 'order');
    } catch {
      // Not signed in, or offline with no session: show sign-in.
      this.screen.set('signin');
    } finally {
      await this.drafts.refreshPendingFlag();
      this.booting.set(false);
    }
  }

  private applyMe(me: {
    account: Account;
    actingAs: Account | null;
    assistMode: boolean;
    household: Household | null;
  }): void {
    this.account.set(me.account);
    this.actingAs.set(me.actingAs);
    this.assistMode.set(me.assistMode);
    this.household.set(me.household);
  }

  async signIn(identifier: string, password: string): Promise<void> {
    await this.run(async () => {
      await this.api.signIn(identifier, password);
      this.api.sessionEnded.set(false);
      this.banner.set(null);
      const me = await this.api.me();
      this.applyMe(me);
      await this.loadCatalog();
      await this.resumeOrCreateNothing();
      this.screen.set(this.isStaff() ? 'accounts' : 'order');
    });
  }

  async signInWithCode(identifier: string, code: string): Promise<void> {
    await this.run(async () => {
      await this.api.verifyCode(identifier, code);
      this.api.sessionEnded.set(false);
      const me = await this.api.me();
      this.applyMe(me);
      await this.loadCatalog();
      await this.resumeOrCreateNothing();
      this.screen.set(this.isStaff() ? 'accounts' : 'order');
    });
  }

  async signOut(): Promise<void> {
    try {
      await this.api.signOut();
    } catch {
      /* signing out locally matters more than the round trip succeeding */
    }
    this.account.set(null);
    this.actingAs.set(null);
    this.assistMode.set(false);
    this.household.set(null);
    this.order.set(null);
    this.plan.set(null);
    this.history.set([]);
    this.screen.set('signin');
  }

  private async loadCatalog(): Promise<void> {
    try {
      const [categories, items] = await Promise.all([this.api.categories(), this.api.items()]);
      this.categories.set(categories);
      this.items.set(items);
      await this.drafts.cacheCatalog({ categories, items });
    } catch (error) {
      // Offline: fall back to the cached catalog so browsing still works.
      const cached = await this.drafts.cachedCatalog<{ categories: Category[]; items: Item[] }>();
      if (cached) {
        this.categories.set(cached.categories);
        this.items.set(cached.items);
      } else {
        throw error;
      }
    }
  }

  /** Resume a draft if one exists; never silently start a second one. */
  private async resumeOrCreateNothing(): Promise<void> {
    if (this.isStaff() && !this.assistMode()) return;
    try {
      const orders = await this.api.myOrders();
      this.history.set(orders);
      const draft = orders.find((o) => o.status === 'draft');
      if (draft) {
        this.order.set(await this.reconcileWithPending(draft));
        this.plan.set(await this.api.plan(draft.id));
      }
    } catch {
      /* offline: the pending-edit flush will reconcile later */
    }
  }

  /** AC-7: a queued edit made offline wins over what the server last saw. */
  private async reconcileWithPending(order: Order): Promise<Order> {
    const pending = await this.drafts.pendingFor(order.id);
    if (!pending) return order;
    try {
      const result = await this.api.setLines(order.id, pending.lines, pending.baseRevision);
      await this.drafts.clear(order.id);
      if (result.conflict) this.banner.set(result.conflict);
      return result.order;
    } catch {
      return order;
    }
  }

  async startOrder(): Promise<void> {
    await this.run(async () => {
      const { order, resumed } = await this.api.startOrder();
      this.order.set(order);
      this.plan.set(resumed ? await this.api.plan(order.id) : null);
      this.screen.set('order');
    });
  }

  // --- editing ------------------------------------------------------------

  /**
   * FR-13. Writes the edit to disk before sending it, so a connection lost
   * between tap and acknowledgement cannot lose it (AC-7).
   */
  async setQuantity(itemId: string, qty: number): Promise<void> {
    const order = this.order();
    if (!order || qty < 0 || !Number.isInteger(qty)) return;

    const lines = order.lines
      .map((l) => ({ itemId: l.itemId, qty: l.itemId === itemId ? qty : l.qty }))
      .filter((l) => l.qty > 0);
    if (qty > 0 && !order.lines.some((l) => l.itemId === itemId)) {
      lines.push({ itemId, qty });
    }

    // Optimistic local update keeps the panel instant (NFR-12).
    const catalog = this.items();
    const optimistic: Order = {
      ...order,
      lines: lines.map((l) => {
        const existing = order.lines.find((x) => x.itemId === l.itemId);
        if (existing) return { ...existing, qty: l.qty };
        const item = catalog.find((i) => i.id === l.itemId)!;
        return {
          id: `pending_${l.itemId}`,
          itemId: item.id,
          itemNameSnapshot: item.name,
          itemNameEsSnapshot: item.nameEs,
          packageSizeSnapshot: item.packageSize,
          qty: l.qty,
          unitPriceCentsSnapshot: item.priceCents,
          servingsUnitsSnapshot: item.servingsPerPackageUnits,
          categorySnapshot: item.categoryKey,
          tagsSnapshot: [...item.tags],
          shelfLifeClassSnapshot: item.shelfLifeClass,
          addedAt: new Date().toISOString(),
        };
      }),
      totalCents: 0,
    };
    optimistic.totalCents = optimistic.lines.reduce(
      (sum, l) => sum + l.unitPriceCentsSnapshot * l.qty,
      0,
    );
    this.order.set(optimistic);

    await this.drafts.stage({
      orderId: order.id,
      lines,
      baseRevision: order.revision,
      savedAt: new Date().toISOString(),
    });

    try {
      const result = await this.api.setLines(order.id, lines, order.revision);
      await this.drafts.clear(order.id);
      this.order.set(result.order);
      if (result.conflict) this.banner.set(result.conflict);
    } catch (error) {
      if (error instanceof ApiFailure && error.detail.code === 'offline') {
        // Stays staged; the reconnect effect will flush it.
        return;
      }
      // A rejected edit must not leave a false picture on screen.
      await this.drafts.clear(order.id);
      this.order.set(order);
      this.errorMessage.set(error instanceof Error ? error.message : 'That change was not saved.');
    }
  }

  async flushPending(): Promise<void> {
    for (const edit of await this.drafts.pending()) {
      try {
        const result = await this.api.setLines(edit.orderId, edit.lines, edit.baseRevision);
        await this.drafts.clear(edit.orderId);
        if (this.order()?.id === edit.orderId) this.order.set(result.order);
        if (result.conflict) this.banner.set(result.conflict);
      } catch {
        return; // still offline; try again on the next reconnect
      }
    }
  }

  async finalize(staffInitials: string, overrideReason?: string): Promise<boolean> {
    const order = this.order();
    if (!order) return false;
    let ok = false;
    await this.run(async () => {
      const result = await this.api.finalize(order.id, staffInitials, overrideReason);
      this.order.set(result.order);
      this.history.set(await this.api.myOrders().catch(() => this.history()));
      ok = true;
    });
    return ok;
  }

  async generatePlan(seed?: number): Promise<void> {
    const order = this.order();
    if (!order) return;
    await this.run(async () => {
      this.plan.set(await this.api.generatePlan(order.id, seed));
      this.screen.set('plan');
    });
  }

  async refreshHistory(): Promise<void> {
    await this.run(async () => {
      this.history.set(await this.api.myOrders());
    });
  }

  /** FR-A6 */
  async enterAssist(accountId: string): Promise<void> {
    await this.run(async () => {
      await this.api.accountAction(accountId, 'assist');
      this.applyMe(await this.api.me());
      this.order.set(null);
      this.plan.set(null);
      await this.resumeOrCreateNothing();
      this.screen.set('order');
    });
  }

  async endAssist(): Promise<void> {
    await this.run(async () => {
      await this.api.endAssist();
      this.applyMe(await this.api.me());
      this.order.set(null);
      this.plan.set(null);
      this.screen.set('accounts');
    });
  }

  /** Runs an action with busy state and a single place to surface errors. */
  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.errorMessage.set(null);
    try {
      await fn();
    } catch (error) {
      this.errorMessage.set(
        error instanceof Error ? error.message : 'Something went wrong. Try again.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
