/**
 * Supabase backend — hosted Postgres shared by every member of staff.
 *
 * Talks to PostgREST and GoTrue over plain `fetch`, so the app carries no
 * extra dependency and the whole contract is visible in one file. The matching
 * SQL (tables, roles, row-level security) lives in `supabase/schema.sql`.
 *
 * Configure it from Settings: paste the project URL and the anon public key.
 * Nothing here uses the service-role key — it must never reach a browser.
 */

import type { Backend, AuthBackend, ClearScope } from './backend';
import type {
  AppSettings,
  Aisle,
  Alias,
  Customer,
  Item,
  Order,
  OrderLine,
  Role,
  Snapshot,
  User,
} from './models';
import { DEFAULT_SETTINGS } from './models';
import { runtimeSupabase } from './runtime-config';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

const SESSION_KEY = 'grocery-picker.supabase-session';
const CONFIG_KEY = 'grocery-picker.supabase-config';
const DISCONNECTED_KEY = 'grocery-picker.supabase-disconnected';
/** Rows per read. Matches the default PostgREST `max-rows`, so no page is short by surprise. */
const SELECT_PAGE_SIZE = 1000;

/** The one table a scoped clear deletes from; foreign keys take care of the rest. */
const SCOPE_TABLE: Record<Exclude<ClearScope, 'everything'>, string> = {
  items: 'items',
  customers: 'customers',
  orders: 'orders',
};

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: User;
}

/**
 * The Supabase project this browser should use.
 *
 * A setting made on this device wins over the one baked into the deploy, in
 * both directions — including a deliberate disconnect, which must not be
 * quietly undone by the deployed config on the next reload.
 */
export function readStoredConfig(): SupabaseConfig | null {
  if (isDisconnectedHere()) return null;
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<SupabaseConfig>;
      if (
        typeof parsed.url === 'string' &&
        typeof parsed.anonKey === 'string' &&
        parsed.url.trim() !== '' &&
        parsed.anonKey.trim() !== ''
      ) {
        return { url: parsed.url.replace(/\/+$/, ''), anonKey: parsed.anonKey };
      }
    }
  } catch {
    // Fall through to whatever the deploy configured.
  }
  const deployed = runtimeSupabase();
  return deployed === null ? null : { url: deployed.url, anonKey: deployed.anonKey };
}

/** True when someone on this device chose browser storage on purpose. */
export function isDisconnectedHere(): boolean {
  return localStorage.getItem(DISCONNECTED_KEY) === 'yes';
}

/** True when the connection came from the deploy rather than from this device. */
export function isConfiguredByDeploy(): boolean {
  return !isDisconnectedHere() && localStorage.getItem(CONFIG_KEY) === null && runtimeSupabase() !== null;
}

export function writeStoredConfig(config: SupabaseConfig | null): void {
  if (config === null) {
    localStorage.removeItem(CONFIG_KEY);
    localStorage.removeItem(SESSION_KEY);
    // Remember the choice, so a deployed config does not override it.
    if (runtimeSupabase() !== null) localStorage.setItem(DISCONNECTED_KEY, 'yes');
    return;
  }
  localStorage.removeItem(DISCONNECTED_KEY);
  localStorage.setItem(
    CONFIG_KEY,
    JSON.stringify({ url: config.url.replace(/\/+$/, ''), anonKey: config.anonKey }),
  );
}

/* ---------------------------------------------------------------- mapping -- */
/* Postgres columns are snake_case; the app model is camelCase.               */

function toItemRow(item: Item): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    brand: item.brand,
    size: item.size,
    department: item.department,
    aisle: item.aisle,
    shelf_sequence: item.shelfSequence,
    unit: item.unit,
    price: item.price,
    barcode: item.barcode,
    active: item.active,
    updated_at: item.updatedAt,
  };
}

function fromItemRow(row: Record<string, unknown>): Item {
  return {
    id: String(row['id'] ?? ''),
    name: String(row['name'] ?? ''),
    brand: String(row['brand'] ?? ''),
    size: String(row['size'] ?? ''),
    department: String(row['department'] ?? ''),
    aisle: String(row['aisle'] ?? ''),
    shelfSequence: row['shelf_sequence'] === null ? null : Number(row['shelf_sequence']),
    unit: String(row['unit'] ?? ''),
    price: row['price'] === null || row['price'] === undefined ? null : Number(row['price']),
    barcode: String(row['barcode'] ?? ''),
    active: row['active'] !== false,
    updatedAt: String(row['updated_at'] ?? new Date().toISOString()),
  };
}

function toAliasRow(alias: Alias): Record<string, unknown> {
  return {
    id: alias.id,
    phrase: alias.phrase,
    normalized_phrase: alias.normalizedPhrase,
    item_id: alias.itemId,
    customer_id: alias.customerId,
    hits: alias.hits,
    created_at: alias.createdAt,
    created_by: alias.createdBy,
  };
}

function fromAliasRow(row: Record<string, unknown>): Alias {
  return {
    id: String(row['id'] ?? ''),
    phrase: String(row['phrase'] ?? ''),
    normalizedPhrase: String(row['normalized_phrase'] ?? ''),
    itemId: String(row['item_id'] ?? ''),
    customerId: row['customer_id'] === null ? null : String(row['customer_id']),
    hits: Number(row['hits'] ?? 0),
    createdAt: String(row['created_at'] ?? ''),
    createdBy: String(row['created_by'] ?? ''),
  };
}

function toOrderRow(order: Order): Record<string, unknown> {
  return {
    id: order.id,
    customer_id: order.customerId,
    customer_name: order.customerName,
    delivery_at: order.deliveryAt === '' ? null : order.deliveryAt,
    notes: order.notes,
    status: order.status,
    created_by: order.createdBy,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
  };
}

function fromOrderRow(row: Record<string, unknown>): Order {
  return {
    id: String(row['id'] ?? ''),
    customerId: row['customer_id'] === null ? null : String(row['customer_id']),
    customerName: String(row['customer_name'] ?? ''),
    deliveryAt: row['delivery_at'] === null ? '' : String(row['delivery_at']),
    notes: String(row['notes'] ?? ''),
    status: (String(row['status'] ?? 'draft') as Order['status']) ?? 'draft',
    createdBy: String(row['created_by'] ?? ''),
    createdAt: String(row['created_at'] ?? ''),
    updatedAt: String(row['updated_at'] ?? ''),
  };
}

function toLineRow(line: OrderLine): Record<string, unknown> {
  return {
    id: line.id,
    order_id: line.orderId,
    position: line.position,
    raw_text: line.rawText,
    phrase: line.phrase,
    item_id: line.itemId,
    qty: line.qty,
    unit: line.unit,
    note: line.note,
    needs_review: line.needsReview,
    match_source: line.matchSource,
    match_score: line.matchScore,
    picked: line.picked,
    out_of_stock: line.outOfStock,
    substitute_item_id: line.substituteItemId,
  };
}

function fromLineRow(row: Record<string, unknown>): OrderLine {
  return {
    id: String(row['id'] ?? ''),
    orderId: String(row['order_id'] ?? ''),
    position: Number(row['position'] ?? 0),
    rawText: String(row['raw_text'] ?? ''),
    phrase: String(row['phrase'] ?? ''),
    itemId: row['item_id'] === null ? null : String(row['item_id']),
    qty: Number(row['qty'] ?? 1),
    unit: String(row['unit'] ?? ''),
    note: String(row['note'] ?? ''),
    needsReview: row['needs_review'] === true,
    matchSource: (String(row['match_source'] ?? 'none') as OrderLine['matchSource']) ?? 'none',
    matchScore: Number(row['match_score'] ?? 0),
    picked: row['picked'] === true,
    outOfStock: row['out_of_stock'] === true,
    substituteItemId: row['substitute_item_id'] === null ? null : String(row['substitute_item_id']),
  };
}

function fromCustomerRow(row: Record<string, unknown>): Customer {
  return {
    id: String(row['id'] ?? ''),
    name: String(row['name'] ?? ''),
    phone: String(row['phone'] ?? ''),
    email: String(row['email'] ?? ''),
    address: String(row['address'] ?? ''),
    notes: String(row['notes'] ?? ''),
    createdAt: String(row['created_at'] ?? ''),
  };
}

function toCustomerRow(customer: Customer): Record<string, unknown> {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    address: customer.address,
    notes: customer.notes,
    created_at: customer.createdAt,
  };
}

/* ------------------------------------------------------------- the client -- */

export class SupabaseBackend implements Backend, AuthBackend {
  readonly kind = 'supabase' as const;
  readonly describe: string;

  private session: StoredSession | null = null;

  constructor(private readonly config: SupabaseConfig) {
    this.describe = `Supabase (${config.url})`;
    this.session = readSession();
  }

  async init(): Promise<void> {
    if (this.session !== null && this.session.expiresAt <= Date.now() + 60_000) {
      await this.refresh().catch(() => {
        this.session = null;
        writeSession(null);
      });
    }
  }

  /* --------------------------------------------------------------- auth -- */

  async signIn(email: string, password: string): Promise<User> {
    const response = await fetch(`${this.config.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: this.config.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        String(payload['error_description'] ?? payload['msg'] ?? 'Could not sign in.'),
      );
    }
    this.session = sessionFromPayload(payload);
    writeSession(this.session);
    // The role lives in `profiles`, not in the auth token.
    const profile = await this.loadProfile(this.session.user.id).catch(() => null);
    if (profile !== null) {
      this.session = { ...this.session, user: { ...this.session.user, ...profile } };
      writeSession(this.session);
    }
    return this.session.user;
  }

  async signOut(): Promise<void> {
    const token = this.session?.accessToken;
    this.session = null;
    writeSession(null);
    if (token === undefined) return;
    await fetch(`${this.config.url}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: this.config.anonKey, Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }

  async currentUser(): Promise<User | null> {
    if (this.session === null) return null;
    if (this.session.expiresAt <= Date.now() + 60_000) {
      const refreshed = await this.refresh().catch(() => null);
      if (refreshed === null) return null;
    }
    return this.session?.user ?? null;
  }

  private async refresh(): Promise<StoredSession> {
    const refreshToken = this.session?.refreshToken;
    if (refreshToken === undefined) throw new Error('No session to refresh.');
    const response = await fetch(`${this.config.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: this.config.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!response.ok) throw new Error('Session expired. Please sign in again.');
    const payload = (await response.json()) as Record<string, unknown>;
    const previousUser = this.session?.user;
    this.session = sessionFromPayload(payload);
    if (previousUser !== undefined) {
      this.session = {
        ...this.session,
        user: { ...this.session.user, name: previousUser.name, role: previousUser.role },
      };
    }
    writeSession(this.session);
    return this.session;
  }

  private async loadProfile(userId: string): Promise<Partial<User> | null> {
    const rows = await this.select<Record<string, unknown>>(
      `profiles?select=*&id=eq.${encodeURIComponent(userId)}`,
    );
    const row = rows[0];
    if (row === undefined) return null;
    const role = String(row['role'] ?? 'staff');
    return {
      name: String(row['name'] ?? ''),
      role: (role === 'admin' ? 'admin' : 'staff') as Role,
    };
  }

  /* ------------------------------------------------------------- fetch -- */

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      apikey: this.config.anonKey,
      'Content-Type': 'application/json',
      ...extra,
    };
    const token = this.session?.accessToken;
    headers['Authorization'] = `Bearer ${token ?? this.config.anonKey}`;
    return headers;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(`${this.config.url}/rest/v1/${path}`, init);
    if (response.status === 401 && this.session !== null) {
      await this.refresh();
      return fetch(`${this.config.url}/rest/v1/${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), ...this.headers() },
      });
    }
    return response;
  }

  /**
   * Read a whole table, however big it is.
   *
   * PostgREST refuses to return more than the project's `max-rows` — 1,000 on
   * a default Supabase — and does not treat that as an error: it answers 200
   * with the first 1,000 rows and mentions the truncation only in a
   * Content-Range header. A 9,420-product catalog would quietly arrive as the
   * alphabetically-first 1,000, and every search would look broken because
   * most of the store was never loaded. So page until a short page arrives.
   */
  private async select<T>(path: string): Promise<T[]> {
    const rows: T[] = [];
    for (let from = 0; ; from += SELECT_PAGE_SIZE) {
      const response = await this.request(path, {
        headers: this.headers({
          'Range-Unit': 'items',
          Range: `${from}-${from + SELECT_PAGE_SIZE - 1}`,
        }),
      });
      // Asking past the last row is how a table whose size is an exact
      // multiple of the page size ends; it is not a failure.
      if (response.status === 416) return rows;
      if (!response.ok) throw new Error(await describeError(response));

      const page = (await response.json()) as T[];
      rows.push(...page);
      if (page.length < SELECT_PAGE_SIZE) return rows;
    }
  }

  /** PostgREST upsert: conflicting ids are merged, not rejected. */
  private async upsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    // Chunked so a full catalog import does not hit the request size limit.
    for (let start = 0; start < rows.length; start += 500) {
      const response = await this.request(table, {
        method: 'POST',
        headers: this.headers({
          Prefer: 'resolution=merge-duplicates,return=minimal',
        }),
        body: JSON.stringify(rows.slice(start, start + 500)),
      });
      if (!response.ok) throw new Error(await describeError(response));
    }
  }

  private async remove(table: string, column: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const list = ids.map((id) => `"${id.replace(/"/g, '""')}"`).join(',');
    const response = await this.request(`${table}?${column}=in.(${encodeURIComponent(list)})`, {
      method: 'DELETE',
      headers: this.headers({ Prefer: 'return=minimal' }),
    });
    if (!response.ok) throw new Error(await describeError(response));
  }

  /* -------------------------------------------------------------- data -- */

  async loadAll(): Promise<Snapshot> {
    const [items, aisles, customers, aliases, orders, orderLines, settings] = await Promise.all([
      this.select<Record<string, unknown>>('items?select=*&order=name.asc'),
      this.select<Record<string, unknown>>('aisles?select=*&order=sequence.asc'),
      this.select<Record<string, unknown>>('customers?select=*&order=name.asc'),
      this.select<Record<string, unknown>>('aliases?select=*'),
      this.select<Record<string, unknown>>('orders?select=*&order=created_at.desc'),
      this.select<Record<string, unknown>>('order_lines?select=*'),
      this.select<Record<string, unknown>>('app_settings?select=*&id=eq.1'),
    ]);

    const storedSettings = settings[0]?.['value'] as Partial<AppSettings> | undefined;

    return {
      items: items.map(fromItemRow),
      aisles: aisles.map((row) => ({
        id: String(row['id'] ?? ''),
        sequence: Number(row['sequence'] ?? 0),
        name: String(row['name'] ?? ''),
      })),
      customers: customers.map(fromCustomerRow),
      aliases: aliases.map(fromAliasRow),
      orders: orders.map(fromOrderRow),
      orderLines: orderLines.map(fromLineRow),
      settings: { ...DEFAULT_SETTINGS, ...(storedSettings ?? {}) },
    };
  }

  upsertItems(items: Item[]): Promise<void> {
    return this.upsert('items', items.map(toItemRow));
  }

  deleteItems(ids: string[]): Promise<void> {
    return this.remove('items', 'id', ids);
  }

  async replaceAisles(aisles: Aisle[]): Promise<void> {
    const response = await this.request('aisles?id=neq.__none__', {
      method: 'DELETE',
      headers: this.headers({ Prefer: 'return=minimal' }),
    });
    if (!response.ok) throw new Error(await describeError(response));
    await this.upsert(
      'aisles',
      aisles.map((aisle) => ({ id: aisle.id, sequence: aisle.sequence, name: aisle.name })),
    );
  }

  upsertCustomers(customers: Customer[]): Promise<void> {
    return this.upsert('customers', customers.map(toCustomerRow));
  }

  deleteCustomer(id: string): Promise<void> {
    return this.remove('customers', 'id', [id]);
  }

  upsertAliases(aliases: Alias[]): Promise<void> {
    return this.upsert('aliases', aliases.map(toAliasRow));
  }

  deleteAliases(ids: string[]): Promise<void> {
    return this.remove('aliases', 'id', ids);
  }

  async saveOrder(order: Order, lines: OrderLine[]): Promise<void> {
    await this.upsert('orders', [toOrderRow(order)]);
    const response = await this.request(`order_lines?order_id=eq.${encodeURIComponent(order.id)}`, {
      method: 'DELETE',
      headers: this.headers({ Prefer: 'return=minimal' }),
    });
    if (!response.ok) throw new Error(await describeError(response));
    await this.upsert('order_lines', lines.map(toLineRow));
  }

  async deleteOrder(id: string): Promise<void> {
    // order_lines has ON DELETE CASCADE, so the header row is enough.
    await this.remove('orders', 'id', [id]);
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    await this.upsert('app_settings', [{ id: 1, value: settings }]);
  }

  /**
   * The schema's `on delete cascade` does most of this: dropping items takes
   * their aliases with it, dropping customers takes their private shorthand,
   * dropping orders takes their lines. Only the everything case has to name
   * each table, and then only to control the order.
   */
  async clear(scope: ClearScope): Promise<void> {
    const tables =
      scope === 'everything'
        ? ['order_lines', 'orders', 'aliases', 'customers', 'items', 'aisles']
        : [SCOPE_TABLE[scope]];

    for (const table of tables) {
      const response = await this.request(`${table}?id=neq.__none__`, {
        method: 'DELETE',
        headers: this.headers({ Prefer: 'return=minimal' }),
      });
      if (!response.ok) throw new Error(await describeError(response));
    }
  }

  /**
   * Put the logo in Supabase Storage and hand back a public URL.
   *
   * The bucket has to exist and be public — `supabase/schema.sql` creates it.
   * If it does not, this says so plainly rather than failing with a bare 404,
   * because the caller has a working alternative and needs to know to use it.
   */
  async uploadLogo(blob: Blob, extension: string): Promise<string> {
    const bucket = 'branding';
    // A fresh name each time, so a replaced logo is never served from a cache
    // that still holds the old one.
    const objectPath = `logo-${Date.now().toString(36)}.${extension}`;

    const response = await fetch(
      `${this.config.url}/storage/v1/object/${bucket}/${objectPath}`,
      {
        method: 'POST',
        headers: {
          apikey: this.config.anonKey,
          Authorization: `Bearer ${this.session?.accessToken ?? this.config.anonKey}`,
          'Content-Type': blob.type === '' ? 'application/octet-stream' : blob.type,
          'x-upsert': 'true',
        },
        body: blob,
      },
    );

    if (!response.ok) {
      const detail = await describeError(response);
      if (response.status === 404 || /bucket/i.test(detail)) {
        throw new Error(
          `The "${bucket}" storage bucket does not exist yet. Run supabase/schema.sql, or create a public bucket called "${bucket}".`,
        );
      }
      throw new Error(detail);
    }

    return `${this.config.url}/storage/v1/object/public/${bucket}/${objectPath}`;
  }

  /** Settings screen "Test connection" button. */
  async testConnection(): Promise<string> {
    const response = await this.request('items?select=id&limit=1', { headers: this.headers() });
    if (!response.ok) throw new Error(await describeError(response));
    return 'Connected. Tables are reachable.';
  }
}

async function describeError(response: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await response.json()) as Record<string, unknown>;
    detail = String(body['message'] ?? body['hint'] ?? body['error'] ?? '');
  } catch {
    detail = await response.text().catch(() => '');
  }
  return `Supabase ${response.status}: ${detail || response.statusText}`;
}

function sessionFromPayload(payload: Record<string, unknown>): StoredSession {
  const rawUser = (payload['user'] ?? {}) as Record<string, unknown>;
  const metadata = (rawUser['user_metadata'] ?? {}) as Record<string, unknown>;
  const email = String(rawUser['email'] ?? '');
  return {
    accessToken: String(payload['access_token'] ?? ''),
    refreshToken: String(payload['refresh_token'] ?? ''),
    expiresAt: Date.now() + Number(payload['expires_in'] ?? 3600) * 1000,
    user: {
      id: String(rawUser['id'] ?? ''),
      email,
      name: String(metadata['name'] ?? email.split('@')[0] ?? 'Staff'),
      role: (String(metadata['role'] ?? 'staff') === 'admin' ? 'admin' : 'staff') as Role,
    },
  };
}

function readSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw === null ? null : (JSON.parse(raw) as StoredSession);
  } catch {
    return null;
  }
}

function writeSession(session: StoredSession | null): void {
  if (session === null) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
