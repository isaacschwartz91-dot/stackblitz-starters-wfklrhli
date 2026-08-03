/**
 * Storage contract.
 *
 * The app never talks to a database directly — it talks to a `Backend`. Two
 * implementations ship: `LocalBackend` (IndexedDB in the browser, works with
 * zero setup) and `SupabaseBackend` (hosted Postgres, shared by every member
 * of staff). Swapping between them is a Settings screen away and changes
 * nothing else in the app.
 */

import type { AppSettings, Aisle, Alias, Customer, Item, Order, OrderLine, Snapshot, User } from './models';

export type BackendKind = 'local' | 'supabase';

export interface Backend {
  readonly kind: BackendKind;
  /** Human-readable description shown in Settings. */
  readonly describe: string;

  init(): Promise<void>;
  loadAll(): Promise<Snapshot>;

  /** Insert-or-update by id. Re-importing a sheet must never duplicate rows. */
  upsertItems(items: Item[]): Promise<void>;
  deleteItems(ids: string[]): Promise<void>;
  /** The walking order is small and always replaced wholesale. */
  replaceAisles(aisles: Aisle[]): Promise<void>;

  upsertCustomers(customers: Customer[]): Promise<void>;
  deleteCustomer(id: string): Promise<void>;

  upsertAliases(aliases: Alias[]): Promise<void>;
  deleteAliases(ids: string[]): Promise<void>;

  /** Saves the order and replaces its lines in one go. */
  saveOrder(order: Order, lines: OrderLine[]): Promise<void>;
  deleteOrder(id: string): Promise<void>;

  saveSettings(settings: AppSettings): Promise<void>;

  /** Wipe everything — used by "restore from backup" and the demo reset. */
  clearAll(): Promise<void>;
}

/** Authentication, when the backend provides it. */
export interface AuthBackend {
  signIn(email: string, password: string): Promise<User>;
  signOut(): Promise<void>;
  currentUser(): Promise<User | null>;
}

export function hasAuth(backend: Backend): backend is Backend & AuthBackend {
  return typeof (backend as Partial<AuthBackend>).signIn === 'function';
}

export function emptySnapshot(settings: AppSettings): Snapshot {
  return {
    items: [],
    aisles: [],
    customers: [],
    aliases: [],
    orders: [],
    orderLines: [],
    settings,
  };
}
