/**
 * Offline draft resilience (NFR-11, AC-7).
 *
 * "A draft order survives a dropped connection and resyncs on reconnect."
 *
 * The server is the system of record. This is a local write-ahead buffer, not
 * a second copy of the truth: every edit is written to IndexedDB *before* it
 * is sent, and cleared only once the server has acknowledged it. Pull the
 * cable mid-order and the pending edit is still on disk when the tab reopens.
 *
 * Full offline use is bounded by the login, exactly as NFR-11 says: an
 * already-signed-in customer keeps working, but a fresh sign-in needs network.
 */

import { Injectable, signal } from '@angular/core';

const DB_NAME = 'scn-drafts';
const DB_VERSION = 1;
const STORE = 'pending';
const CATALOG_STORE = 'catalog';

export interface PendingEdit {
  /** One pending edit per order; a newer edit supersedes an older one. */
  orderId: string;
  lines: { itemId: string; qty: number }[];
  baseRevision: number;
  savedAt: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'orderId' });
      }
      if (!db.objectStoreNames.contains(CATALOG_STORE)) {
        db.createObjectStore(CATALOG_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Cannot open local storage.'));
  });
}

/** Resolves on transaction commit, so a resolved promise means it is on disk. */
function commit<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let value: T;
    request.onsuccess = () => {
      value = request.result;
    };
    const tx = request.transaction;
    if (!tx) {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      return;
    }
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(tx.error ?? new Error('Local write aborted.'));
    tx.onerror = () => reject(tx.error ?? new Error('Local write failed.'));
  });
}

@Injectable({ providedIn: 'root' })
export class DraftStore {
  /** True while an edit is on disk but not yet accepted by the server. */
  readonly hasPending = signal(false);
  readonly available = signal(typeof indexedDB !== 'undefined');

  private async withStore<T>(
    store: string,
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T | null> {
    if (!this.available()) return null;
    try {
      const db = await open();
      return await commit(fn(db.transaction(store, mode).objectStore(store)));
    } catch {
      // Private browsing and storage pressure can both refuse IndexedDB.
      // The app must keep working online; it just loses the offline guarantee.
      this.available.set(false);
      return null;
    }
  }

  /** Write before sending, so a crash mid-request cannot lose the edit. */
  async stage(edit: PendingEdit): Promise<void> {
    await this.withStore(STORE, 'readwrite', (s) => s.put(edit));
    this.hasPending.set(true);
  }

  /** Clear only after the server has acknowledged. */
  async clear(orderId: string): Promise<void> {
    await this.withStore(STORE, 'readwrite', (s) => s.delete(orderId));
    const remaining = await this.pending();
    this.hasPending.set(remaining.length > 0);
  }

  async pending(): Promise<PendingEdit[]> {
    const all = await this.withStore<PendingEdit[]>(
      STORE,
      'readonly',
      (s) => s.getAll() as IDBRequest<PendingEdit[]>,
    );
    return all ?? [];
  }

  async pendingFor(orderId: string): Promise<PendingEdit | null> {
    const found = await this.withStore<PendingEdit | undefined>(
      STORE,
      'readonly',
      (s) => s.get(orderId) as IDBRequest<PendingEdit | undefined>,
    );
    return found ?? null;
  }

  async refreshPendingFlag(): Promise<void> {
    this.hasPending.set((await this.pending()).length > 0);
  }

  /**
   * A cached catalog so an offline customer can still browse and add items.
   * Prices here are display-only; the server captures the real ones.
   */
  async cacheCatalog(payload: unknown): Promise<void> {
    await this.withStore(CATALOG_STORE, 'readwrite', (s) => s.put(payload, 'catalog'));
  }

  async cachedCatalog<T>(): Promise<T | null> {
    return (await this.withStore<T>(CATALOG_STORE, 'readonly', (s) => s.get('catalog') as IDBRequest<T>)) ?? null;
  }
}
