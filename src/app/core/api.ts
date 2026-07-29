/**
 * API client.
 *
 * The server is the system of record. This layer only talks to it — it never
 * decides who may see what, because NFR-3 puts that decision on the server.
 * When the UI hides a button, that is a convenience; the refusal that matters
 * happens behind the request.
 *
 * The session cookie is HttpOnly, so there is no token to hold here.
 */

import { Injectable, signal } from '@angular/core';

import type {
  Account,
  AuditEvent,
  Category,
  Household,
  Item,
  MealPlan,
  Order,
  ProgramProfile,
} from '../../shared/types';
import type { ComplianceResult } from '../../shared/compliance/engine';

export interface ApiError {
  status: number;
  message: string;
  code?: string;
  /** Present on a 422 from finalize, so the UI can explain what is wrong. */
  compliance?: ComplianceResult;
}

export class ApiFailure extends Error {
  constructor(readonly detail: ApiError) {
    super(detail.message);
    this.name = 'ApiFailure';
  }
}

export interface MeResponse {
  account: Account;
  actingAs: Account | null;
  assistMode: boolean;
  household: Household | null;
}

export interface RecordRow {
  order: Order;
  referralId: string;
  memberCount: number;
}

@Injectable({ providedIn: 'root' })
export class ApiClient {
  /** NFR-11: surfaced in the UI so staff know work is queued, not lost. */
  readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  /** Set when a request fails because the session ended (FR-A5). */
  readonly sessionEnded = signal(false);

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.online.set(true));
      window.addEventListener('offline', () => this.online.set(false));
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Send the HttpOnly session cookie.
        credentials: 'same-origin',
      });
    } catch {
      // A dropped connection is not an application error; callers that can
      // queue work offline catch this and do so.
      this.online.set(false);
      throw new ApiFailure({ status: 0, message: 'No connection.', code: 'offline' });
    }

    this.online.set(true);

    const text = await response.text();
    let payload: Record<string, unknown> = {};
    if (text) {
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // A CSV export or an unexpected body: hand the raw text back.
        if (response.ok) return text as unknown as T;
        payload = {};
      }
    }

    if (!response.ok) {
      if (response.status === 401) this.sessionEnded.set(true);
      throw new ApiFailure({
        status: response.status,
        message: (payload['error'] as string) ?? 'Something went wrong.',
        code: payload['code'] as string | undefined,
        compliance: payload['compliance'] as ComplianceResult | undefined,
      });
    }

    return payload as T;
  }

  // --- auth ---------------------------------------------------------------

  async signIn(identifier: string, password: string): Promise<Account> {
    const result = await this.request<{ account: Account }>('POST', '/api/auth/sign-in', {
      identifier,
      password,
    });
    this.sessionEnded.set(false);
    return result.account;
  }

  requestCode(identifier: string): Promise<{ sent: boolean; message: string }> {
    return this.request('POST', '/api/auth/request-code', { identifier });
  }

  async verifyCode(identifier: string, code: string): Promise<Account> {
    const result = await this.request<{ account: Account }>('POST', '/api/auth/verify-code', {
      identifier,
      code,
    });
    this.sessionEnded.set(false);
    return result.account;
  }

  requestReset(identifier: string): Promise<{ sent: boolean }> {
    return this.request('POST', '/api/auth/request-reset', { identifier });
  }

  resetPassword(identifier: string, code: string, newPassword: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/auth/reset', { identifier, code, newPassword });
  }

  me(): Promise<MeResponse> {
    return this.request('GET', '/api/auth/me');
  }

  signOut(): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/auth/sign-out');
  }

  endAssist(): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/auth/end-assist');
  }

  // --- catalog ------------------------------------------------------------

  async categories(): Promise<Category[]> {
    return (await this.request<{ categories: Category[] }>('GET', '/api/categories')).categories;
  }

  async items(): Promise<Item[]> {
    return (await this.request<{ items: Item[] }>('GET', '/api/items')).items;
  }

  /** FR-8: barcode lookup. Resolves to null when nothing matches. */
  async itemByUpc(upc: string): Promise<Item | null> {
    try {
      const result = await this.request<{ item: Item }>(
        'GET',
        `/api/items/lookup?upc=${encodeURIComponent(upc)}`,
      );
      return result.item;
    } catch (error) {
      if (error instanceof ApiFailure && error.detail.status === 404) return null;
      throw error;
    }
  }

  // --- orders -------------------------------------------------------------

  async household(): Promise<Household | null> {
    return (await this.request<{ household: Household | null }>('GET', '/api/me/household'))
      .household;
  }

  /** FR-A8 */
  async myOrders(): Promise<Order[]> {
    return (await this.request<{ orders: Order[] }>('GET', '/api/me/orders')).orders;
  }

  startOrder(): Promise<{ order: Order; resumed: boolean }> {
    return this.request('POST', '/api/orders');
  }

  async order(id: string): Promise<Order> {
    return (await this.request<{ order: Order }>('GET', `/api/orders/${encodeURIComponent(id)}`))
      .order;
  }

  /**
   * FR-13: only item ids and quantities go over the wire. Prices and serving
   * counts are the server's to decide.
   */
  setLines(
    orderId: string,
    lines: { itemId: string; qty: number }[],
    baseRevision: number,
  ): Promise<{ order: Order; compliance: ComplianceResult; conflict: string | null }> {
    return this.request('PUT', `/api/orders/${encodeURIComponent(orderId)}/lines`, {
      lines,
      baseRevision,
    });
  }

  finalize(
    orderId: string,
    staffInitials: string,
    overrideReason?: string,
  ): Promise<{ order: Order; compliance: ComplianceResult }> {
    return this.request('POST', `/api/orders/${encodeURIComponent(orderId)}/finalize`, {
      staffInitials,
      overrideReason,
    });
  }

  async plan(orderId: string): Promise<MealPlan | null> {
    return (
      await this.request<{ plan: MealPlan | null }>(
        'GET',
        `/api/orders/${encodeURIComponent(orderId)}/plan`,
      )
    ).plan;
  }

  async generatePlan(orderId: string, seed?: number): Promise<MealPlan> {
    return (
      await this.request<{ plan: MealPlan }>(
        'POST',
        `/api/orders/${encodeURIComponent(orderId)}/plan`,
        seed === undefined ? {} : { seed },
      )
    ).plan;
  }

  // --- staff and admin ----------------------------------------------------

  async accounts(): Promise<Account[]> {
    return (await this.request<{ accounts: Account[] }>('GET', '/api/staff/accounts')).accounts;
  }

  createAccount(payload: Record<string, unknown>): Promise<{ account: Account }> {
    return this.request('POST', '/api/staff/accounts', payload);
  }

  accountAction(
    accountId: string,
    action: 'suspend' | 'reinstate' | 'unlock' | 'assist' | 'reset-password' | 'revoke-sessions',
    payload?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(
      'POST',
      `/api/staff/accounts/${encodeURIComponent(accountId)}/${action}`,
      payload ?? {},
    );
  }

  /** FR-34 */
  async records(query: Record<string, string>): Promise<RecordRow[]> {
    const params = new URLSearchParams(query).toString();
    return (
      await this.request<{ orders: RecordRow[] }>(
        'GET',
        `/api/staff/records${params ? `?${params}` : ''}`,
      )
    ).orders;
  }

  exportRecordsCsv(query: Record<string, string>): Promise<string> {
    const params = new URLSearchParams(query).toString();
    return this.request<string>(
      'GET',
      `/api/admin/records/export${params ? `?${params}` : ''}`,
    );
  }

  async profiles(): Promise<ProgramProfile[]> {
    return (await this.request<{ profiles: ProgramProfile[] }>('GET', '/api/admin/profiles'))
      .profiles;
  }

  saveProfile(profile: ProgramProfile, newVersion: boolean): Promise<{ profile: ProgramProfile }> {
    return this.request('POST', '/api/admin/profiles', { profile, newVersion });
  }

  saveCategory(category: Partial<Category>): Promise<{ category: Category }> {
    return this.request('POST', '/api/admin/categories', { category });
  }

  saveItem(item: Partial<Item>): Promise<{ item: Item }> {
    return this.request('POST', '/api/admin/items', { item });
  }

  /** FR-5: dry run first so the validation report can be shown before commit. */
  importCatalog(
    csv: string,
    options: { commit: boolean; hasHeader?: boolean; mapping?: Record<string, number> },
  ): Promise<{
    created: number;
    updated: number;
    rejected: { line: number; reason: string; raw: string }[];
    committed: boolean;
    mapping: Record<string, number>;
  }> {
    return this.request('POST', '/api/admin/items/import', { csv, ...options });
  }

  exportCatalogCsv(): Promise<string> {
    return this.request<string>('GET', '/api/admin/items/export');
  }

  async audit(): Promise<AuditEvent[]> {
    return (await this.request<{ events: AuditEvent[] }>('GET', '/api/admin/audit')).events;
  }
}
