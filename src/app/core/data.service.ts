/**
 * The application's single source of truth.
 *
 * Loads everything from the active backend into signals once, then keeps
 * memory and storage in step on every change. Holding the catalog in memory is
 * what makes matching feel instant — the match index is rebuilt only when the
 * catalog or the alias table actually changes.
 */

import { Injectable, computed, signal } from '@angular/core';

import type { Backend } from './backend';
import { LocalBackend } from './local-backend';
import { SupabaseBackend, readStoredConfig } from './supabase-backend';
import { runtimeConfig } from './runtime-config';
import { newId } from './ids';
import type {
  AppSettings,
  Aisle,
  Alias,
  Customer,
  Item,
  Order,
  OrderLine,
  OrderStatus,
  Snapshot,
} from './models';
import { DEFAULT_SETTINGS } from './models';
import { buildMatchIndex } from '../matching/matcher';
import { normalize } from '../matching/normalize';
import { aisleKey } from '../matching/pick-list';

@Injectable({ providedIn: 'root' })
export class DataService {
  private backendRef: Backend = createBackend();

  readonly items = signal<Item[]>([]);
  readonly aisles = signal<Aisle[]>([]);
  readonly customers = signal<Customer[]>([]);
  readonly aliases = signal<Alias[]>([]);
  readonly orders = signal<Order[]>([]);
  readonly orderLines = signal<OrderLine[]>([]);
  // Seeded from the deploy so the login screen carries the store's name even
  // before any data has loaded.
  readonly settings = signal<AppSettings>(deployedDefaults());

  readonly loading = signal(true);
  readonly error = signal<string>('');
  readonly loaded = signal(false);

  /** Rebuilt only when the catalog or the learned shorthand changes. */
  readonly matchIndex = computed(() => buildMatchIndex(this.items(), this.aliases()));

  readonly itemsById = computed(() => new Map(this.items().map((item) => [item.id, item])));

  readonly sortedAisles = computed(() =>
    [...this.aisles()].sort((a, b) => a.sequence - b.sequence),
  );

  /** Aisle codes found on items but missing from the walking order sheet. */
  readonly unmappedAisles = computed(() => {
    const known = new Set(this.aisles().map((aisle) => aisleKey(aisle.id)));
    const missing = new Set<string>();
    for (const item of this.items()) {
      const key = aisleKey(item.aisle);
      if (key !== '' && !known.has(key)) missing.add(item.aisle.trim());
    }
    return [...missing].sort();
  });

  /**
   * Products with no position at all. An item with no aisle but a shelf
   * sequence still has a place in the walk, so it does not count.
   */
  readonly itemsWithoutLocation = computed(
    () =>
      this.items().filter((item) => aisleKey(item.aisle) === '' && item.shelfSequence === null)
        .length,
  );

  get backend(): Backend {
    return this.backendRef;
  }

  get backendKind(): Backend['kind'] {
    return this.backendRef.kind;
  }

  /** Load everything once at start-up (and again after a backend switch). */
  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      await this.backendRef.init();
      this.apply(await this.backendRef.loadAll());
      this.loaded.set(true);
    } catch (cause) {
      this.error.set(messageOf(cause));
      this.loaded.set(false);
    } finally {
      this.loading.set(false);
    }
  }

  private apply(snapshot: Snapshot): void {
    // A store name set at deploy time seeds the app, but never overwrites one
    // an admin has since typed in.
    const deployedName = runtimeConfig()?.storeName ?? '';
    if (deployedName !== '' && (snapshot.settings.storeName || DEFAULT_SETTINGS.storeName) === DEFAULT_SETTINGS.storeName) {
      snapshot = { ...snapshot, settings: { ...snapshot.settings, storeName: deployedName } };
    }
    this.items.set(snapshot.items);
    this.aisles.set(snapshot.aisles);
    this.customers.set(snapshot.customers);
    this.aliases.set(snapshot.aliases);
    this.orders.set(snapshot.orders);
    this.orderLines.set(snapshot.orderLines);
    this.settings.set({ ...DEFAULT_SETTINGS, ...snapshot.settings });
  }

  /** Point the app at a different backend and reload. */
  async useBackend(backend: Backend): Promise<void> {
    this.backendRef = backend;
    this.loaded.set(false);
    await this.load();
  }

  /* ------------------------------------------------------------- catalog -- */

  async saveItems(items: Item[]): Promise<void> {
    if (items.length === 0) return;
    const stamped = items.map((item) => ({ ...item, updatedAt: new Date().toISOString() }));
    await this.backendRef.upsertItems(stamped);
    const byId = new Map(stamped.map((item) => [item.id, item]));
    const current = this.items();
    const existingIds = new Set(current.map((item) => item.id));
    // Update in place, then append what is genuinely new — importing the same
    // sheet twice must leave the catalog the same size.
    const merged = current.map((item) => byId.get(item.id) ?? item);
    for (const item of stamped) {
      if (!existingIds.has(item.id)) merged.push(item);
    }
    this.items.set(merged);
  }

  async deleteItems(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.backendRef.deleteItems(ids);
    const removed = new Set(ids);
    this.items.set(this.items().filter((item) => !removed.has(item.id)));
  }

  async replaceAisles(aisles: Aisle[]): Promise<void> {
    const ordered = [...aisles]
      .sort((a, b) => a.sequence - b.sequence)
      .map((aisle, position) => ({ ...aisle, sequence: position + 1 }));
    await this.backendRef.replaceAisles(ordered);
    this.aisles.set(ordered);
  }

  /* ----------------------------------------------------------- customers -- */

  async saveCustomer(customer: Customer): Promise<Customer> {
    await this.backendRef.upsertCustomers([customer]);
    const existing = this.customers().some((entry) => entry.id === customer.id);
    this.customers.set(
      existing
        ? this.customers().map((entry) => (entry.id === customer.id ? customer : entry))
        : [...this.customers(), customer],
    );
    return customer;
  }

  /** Insert-or-update many at once — the customer sheet import. */
  async saveCustomers(customers: Customer[]): Promise<void> {
    if (customers.length === 0) return;
    await this.backendRef.upsertCustomers(customers);
    const byId = new Map(customers.map((customer) => [customer.id, customer]));
    const current = this.customers();
    const existingIds = new Set(current.map((customer) => customer.id));
    const merged = current.map((customer) => byId.get(customer.id) ?? customer);
    for (const customer of customers) {
      if (!existingIds.has(customer.id)) merged.push(customer);
    }
    this.customers.set(merged);
  }

  async createCustomer(name: string, extra: Partial<Customer> = {}): Promise<Customer> {
    const customer: Customer = {
      id: newId('cust'),
      name: name.trim(),
      phone: '',
      email: '',
      address: '',
      notes: '',
      createdAt: new Date().toISOString(),
      ...extra,
    };
    return this.saveCustomer(customer);
  }

  async deleteCustomer(id: string): Promise<void> {
    await this.backendRef.deleteCustomer(id);
    this.customers.set(this.customers().filter((customer) => customer.id !== id));
    // Their shorthand goes with them; the orders stay, with the name snapshot.
    const orphaned = this.aliases().filter((alias) => alias.customerId === id);
    if (orphaned.length > 0) await this.deleteAliases(orphaned.map((alias) => alias.id));
    this.orders.set(
      this.orders().map((order) => (order.customerId === id ? { ...order, customerId: null } : order)),
    );
  }

  customerById(id: string | null): Customer | null {
    if (id === null) return null;
    return this.customers().find((customer) => customer.id === id) ?? null;
  }

  /* ------------------------------------------------------------- aliases -- */

  /**
   * Teach the software a phrase.
   *
   * Re-teaching the same phrase in the same scope overwrites the old meaning
   * rather than piling up a second, conflicting rule.
   */
  async saveAlias(input: {
    phrase: string;
    itemId: string;
    customerId: string | null;
    createdBy?: string;
  }): Promise<Alias | null> {
    const phrase = input.phrase.trim();
    const normalized = normalize(phrase);
    if (normalized === '') return null;

    const existing = this.aliases().find(
      (alias) => alias.normalizedPhrase === normalized && alias.customerId === input.customerId,
    );
    const alias: Alias = existing
      ? { ...existing, phrase, itemId: input.itemId }
      : {
          id: newId('alias'),
          phrase,
          normalizedPhrase: normalized,
          itemId: input.itemId,
          customerId: input.customerId,
          hits: 0,
          createdAt: new Date().toISOString(),
          createdBy: input.createdBy ?? '',
        };

    await this.backendRef.upsertAliases([alias]);
    this.aliases.set(
      existing
        ? this.aliases().map((entry) => (entry.id === alias.id ? alias : entry))
        : [...this.aliases(), alias],
    );
    return alias;
  }

  async deleteAliases(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.backendRef.deleteAliases(ids);
    const removed = new Set(ids);
    this.aliases.set(this.aliases().filter((alias) => !removed.has(alias.id)));
  }

  /** Bump usage counters so the alias screen can show what is actually used. */
  async recordAliasHits(aliasIds: string[]): Promise<void> {
    if (aliasIds.length === 0) return;
    const counted = new Set(aliasIds);
    const updated = this.aliases()
      .filter((alias) => counted.has(alias.id))
      .map((alias) => ({ ...alias, hits: alias.hits + 1 }));
    if (updated.length === 0) return;
    this.aliases.set(
      this.aliases().map((alias) => updated.find((entry) => entry.id === alias.id) ?? alias),
    );
    await this.backendRef.upsertAliases(updated).catch(() => undefined);
  }

  aliasesForCustomer(customerId: string | null): Alias[] {
    return this.aliases().filter((alias) => alias.customerId === customerId);
  }

  /* -------------------------------------------------------------- orders -- */

  linesFor(orderId: string): OrderLine[] {
    return this.orderLines()
      .filter((line) => line.orderId === orderId)
      .sort((a, b) => a.position - b.position);
  }

  orderById(id: string): Order | null {
    return this.orders().find((order) => order.id === id) ?? null;
  }

  async saveOrder(order: Order, lines: OrderLine[]): Promise<void> {
    const stamped: Order = { ...order, updatedAt: new Date().toISOString() };
    const positioned = lines.map((line, position) => ({ ...line, position, orderId: order.id }));
    await this.backendRef.saveOrder(stamped, positioned);

    const exists = this.orders().some((entry) => entry.id === order.id);
    this.orders.set(
      exists
        ? this.orders().map((entry) => (entry.id === order.id ? stamped : entry))
        : [stamped, ...this.orders()],
    );
    this.orderLines.set([
      ...this.orderLines().filter((line) => line.orderId !== order.id),
      ...positioned,
    ]);
  }

  async setOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    const order = this.orderById(orderId);
    if (order === null) return;
    await this.saveOrder({ ...order, status }, this.linesFor(orderId));
  }

  async deleteOrder(id: string): Promise<void> {
    await this.backendRef.deleteOrder(id);
    this.orders.set(this.orders().filter((order) => order.id !== id));
    this.orderLines.set(this.orderLines().filter((line) => line.orderId !== id));
  }

  /** The most recent saved order for a customer — powers "repeat last order". */
  lastOrderFor(customerId: string): Order | null {
    return (
      this.orders()
        .filter((order) => order.customerId === customerId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
    );
  }

  /* ------------------------------------------------------------ settings -- */

  async saveSettings(settings: AppSettings): Promise<void> {
    await this.backendRef.saveSettings(settings);
    this.settings.set(settings);
  }

  /* -------------------------------------------------------- bulk restore -- */

  snapshot(): Snapshot {
    return {
      items: this.items(),
      aisles: this.aisles(),
      customers: this.customers(),
      aliases: this.aliases(),
      orders: this.orders(),
      orderLines: this.orderLines(),
      settings: this.settings(),
      exportedAt: new Date().toISOString(),
      version: 1,
    };
  }

  /** Replace everything — used by "restore backup" and the demo data button. */
  async restore(snapshot: Snapshot): Promise<void> {
    await this.backendRef.clearAll();
    await this.backendRef.upsertItems(snapshot.items);
    await this.backendRef.replaceAisles(snapshot.aisles);
    await this.backendRef.upsertCustomers(snapshot.customers);
    await this.backendRef.upsertAliases(snapshot.aliases);
    for (const order of snapshot.orders) {
      await this.backendRef.saveOrder(
        order,
        snapshot.orderLines.filter((line) => line.orderId === order.id),
      );
    }
    await this.backendRef.saveSettings(snapshot.settings);
    this.apply(snapshot);
  }

  async clearAll(): Promise<void> {
    await this.backendRef.clearAll();
    this.apply({
      items: [],
      aisles: [],
      customers: [],
      aliases: [],
      orders: [],
      orderLines: [],
      settings: this.settings(),
    });
  }
}

function deployedDefaults(): AppSettings {
  const name = runtimeConfig()?.storeName ?? '';
  return name === '' ? DEFAULT_SETTINGS : { ...DEFAULT_SETTINGS, storeName: name };
}

/** Supabase when it has been configured, otherwise this browser. */
export function createBackend(): Backend {
  const config = readStoredConfig();
  return config === null ? new LocalBackend() : new SupabaseBackend(config);
}

export function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
