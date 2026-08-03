/**
 * IndexedDB backend — the zero-setup default.
 *
 * Everything lives in the browser, so the app is fully usable the moment it
 * loads: import the sheets, sort an order, print the pick list. Data is
 * per-browser, which is why Settings offers a JSON backup and the Supabase
 * backend for real multi-user use.
 */

import type {
  AppSettings,
  Aisle,
  Alias,
  Customer,
  Item,
  Order,
  OrderLine,
  Snapshot,
} from './models';
import { DEFAULT_SETTINGS } from './models';
import type { Backend } from './backend';

const DB_NAME = 'grocery-picker';
const DB_VERSION = 1;

const STORES = ['items', 'aisles', 'customers', 'aliases', 'orders', 'orderLines', 'kv'] as const;
type StoreName = (typeof STORES)[number];

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error('IndexedDB request failed'));
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'));
  });
}

export class LocalBackend implements Backend {
  readonly kind = 'local' as const;
  readonly describe = 'This browser (IndexedDB)';

  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if (this.db !== null) return;
    if (typeof indexedDB === 'undefined') {
      throw new Error('This browser does not support IndexedDB.');
    }
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const store of STORES) {
        if (db.objectStoreNames.contains(store)) continue;
        const created = db.createObjectStore(store, { keyPath: store === 'kv' ? 'key' : 'id' });
        if (store === 'orderLines') created.createIndex('orderId', 'orderId', { unique: false });
        if (store === 'orders') created.createIndex('customerId', 'customerId', { unique: false });
      }
    };
    this.db = await request(open);
  }

  private async connection(): Promise<IDBDatabase> {
    await this.init();
    if (this.db === null) throw new Error('IndexedDB is unavailable.');
    return this.db;
  }

  private async readAll<T>(store: StoreName): Promise<T[]> {
    const db = await this.connection();
    const transaction = db.transaction(store, 'readonly');
    return request(transaction.objectStore(store).getAll() as IDBRequest<T[]>);
  }

  private async put(store: StoreName, rows: unknown[]): Promise<void> {
    if (rows.length === 0) return;
    const db = await this.connection();
    const transaction = db.transaction(store, 'readwrite');
    const target = transaction.objectStore(store);
    for (const row of rows) target.put(row);
    await finished(transaction);
  }

  private async remove(store: StoreName, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.connection();
    const transaction = db.transaction(store, 'readwrite');
    const target = transaction.objectStore(store);
    for (const id of ids) target.delete(id);
    await finished(transaction);
  }

  async loadAll(): Promise<Snapshot> {
    const [items, aisles, customers, aliases, orders, orderLines, kv] = await Promise.all([
      this.readAll<Item>('items'),
      this.readAll<Aisle>('aisles'),
      this.readAll<Customer>('customers'),
      this.readAll<Alias>('aliases'),
      this.readAll<Order>('orders'),
      this.readAll<OrderLine>('orderLines'),
      this.readAll<{ key: string; value: unknown }>('kv'),
    ]);

    const stored = kv.find((entry) => entry.key === 'settings')?.value as
      | Partial<AppSettings>
      | undefined;

    return {
      items,
      aisles,
      customers,
      aliases,
      orders,
      orderLines,
      settings: { ...DEFAULT_SETTINGS, ...(stored ?? {}) },
    };
  }

  upsertItems(items: Item[]): Promise<void> {
    return this.put('items', items);
  }

  deleteItems(ids: string[]): Promise<void> {
    return this.remove('items', ids);
  }

  async replaceAisles(aisles: Aisle[]): Promise<void> {
    const db = await this.connection();
    const transaction = db.transaction('aisles', 'readwrite');
    const store = transaction.objectStore('aisles');
    store.clear();
    for (const aisle of aisles) store.put(aisle);
    await finished(transaction);
  }

  upsertCustomers(customers: Customer[]): Promise<void> {
    return this.put('customers', customers);
  }

  deleteCustomer(id: string): Promise<void> {
    return this.remove('customers', [id]);
  }

  upsertAliases(aliases: Alias[]): Promise<void> {
    return this.put('aliases', aliases);
  }

  deleteAliases(ids: string[]): Promise<void> {
    return this.remove('aliases', ids);
  }

  /** Ids of every line currently stored against an order. */
  private async lineIdsFor(orderId: string): Promise<IDBValidKey[]> {
    const db = await this.connection();
    const transaction = db.transaction('orderLines', 'readonly');
    const index = transaction.objectStore('orderLines').index('orderId');
    return request(index.getAllKeys(IDBKeyRange.only(orderId)));
  }

  async saveOrder(order: Order, lines: OrderLine[]): Promise<void> {
    // The stale ids are read first so the write transaction never awaits
    // anything mid-flight, which would let the browser close it early.
    const stale = await this.lineIdsFor(order.id);
    const db = await this.connection();
    const transaction = db.transaction(['orders', 'orderLines'], 'readwrite');
    transaction.objectStore('orders').put(order);

    const lineStore = transaction.objectStore('orderLines');
    // Replace the whole line set so deleted lines really disappear.
    for (const key of stale) lineStore.delete(key);
    for (const line of lines) lineStore.put(line);
    await finished(transaction);
  }

  async deleteOrder(id: string): Promise<void> {
    const stale = await this.lineIdsFor(id);
    const db = await this.connection();
    const transaction = db.transaction(['orders', 'orderLines'], 'readwrite');
    transaction.objectStore('orders').delete(id);
    const lineStore = transaction.objectStore('orderLines');
    for (const key of stale) lineStore.delete(key);
    await finished(transaction);
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    await this.put('kv', [{ key: 'settings', value: settings }]);
  }

  async clearAll(): Promise<void> {
    const db = await this.connection();
    const transaction = db.transaction([...STORES], 'readwrite');
    for (const store of STORES) transaction.objectStore(store).clear();
    await finished(transaction);
  }
}
