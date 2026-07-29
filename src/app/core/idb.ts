/**
 * Minimal IndexedDB wrapper (NFR-8).
 *
 * Deliberately dependency-free and tiny: the persistence guarantee this app
 * needs is "a draft order survives a dropped connection or a closed tab", and
 * that is a durable local write, not a sync engine.
 *
 * Every write is awaited to transaction completion, not just request success,
 * so a resolved promise means the data is actually on disk.
 */

export const DB_NAME = 'scn-food-order-builder';
export const DB_VERSION = 1;

export const STORES = {
  settings: 'settings',
  categories: 'categories',
  profiles: 'profiles',
  items: 'items',
  households: 'households',
  orders: 'orders',
  mealPlans: 'mealPlans',
  audit: 'audit',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

let dbPromise: Promise<IDBDatabase> | null = null;

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings); // key-value, external keys
      }
      for (const name of [
        STORES.categories,
        STORES.profiles,
        STORES.items,
        STORES.households,
        STORES.orders,
        STORES.mealPlans,
        STORES.audit,
      ]) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () =>
      reject(new Error('Database is open in another tab and blocking an upgrade.'));
  });

  return dbPromise;
}

function tx(db: IDBDatabase, store: StoreName, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store);
}

/** Resolves when the whole transaction commits, not merely when the op fires. */
function awaitTransaction<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = request.transaction;
    let value: T;
    request.onsuccess = () => {
      value = request.result;
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    if (transaction) {
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Transaction failed'));
    } else {
      request.onsuccess = () => resolve(request.result);
    }
  });
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return awaitTransaction<T[]>(tx(db, store, 'readonly').getAll() as IDBRequest<T[]>);
}

export async function getOne<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return awaitTransaction<T | undefined>(
    tx(db, store, 'readonly').get(key) as IDBRequest<T | undefined>,
  );
}

export async function put<T>(store: StoreName, value: T, key?: IDBValidKey): Promise<void> {
  const db = await openDb();
  const objectStore = tx(db, store, 'readwrite');
  await awaitTransaction(
    key === undefined ? objectStore.put(value) : objectStore.put(value, key),
  );
}

/** One transaction for the whole batch, so a bulk import is all-or-nothing. */
export async function putMany<T>(store: StoreName, values: readonly T[]): Promise<void> {
  if (values.length === 0) return;
  const db = await openDb();
  const transaction = db.transaction(store, 'readwrite');
  const objectStore = transaction.objectStore(store);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Bulk write aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Bulk write failed'));
    for (const value of values) objectStore.put(value);
  });
}

export async function remove(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  await awaitTransaction(tx(db, store, 'readwrite').delete(key));
}

export async function clearStore(store: StoreName): Promise<void> {
  const db = await openDb();
  await awaitTransaction(tx(db, store, 'readwrite').clear());
}
