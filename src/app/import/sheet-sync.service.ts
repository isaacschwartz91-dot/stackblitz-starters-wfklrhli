/**
 * Keeps the app in step with spreadsheets that live at a URL.
 *
 * The store edits one sheet; the app re-reads it — on open, or on demand — and
 * applies exactly what a manual upload would. Nothing is ever deleted: a
 * product that has disappeared from the sheet is retired from matching, so past
 * orders still show what was picked.
 */

import { Injectable, inject, signal } from '@angular/core';

import { DataService, messageOf } from '../core/data.service';
import type { LinkedSheet } from '../core/models';
import {
  buildAisles,
  buildCustomers,
  buildItems,
  guessAisleMapping,
  guessCustomerMapping,
  guessItemMapping,
  readWorkbookBuffer,
  type SheetTable,
} from './sheet-parse';

const LAST_SYNC_KEY = 'grocery-picker.last-sync';

export interface SyncOutcome {
  label: string;
  ok: boolean;
  message: string;
}

/**
 * Turn a link a person would actually copy into one that returns a file.
 *
 * A Google Sheets address from the browser bar points at the editor, not at
 * any data, so it is rewritten to the CSV export of the tab being viewed.
 */
export function normalizeSheetUrl(input: string): string {
  const url = input.trim();
  const google = /^https?:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(url);
  if (google === null) return url;
  // Already a published or export link — leave it alone.
  if (/\/pub|output=csv|format=csv|\/gviz\//.test(url)) return url;
  const gid = /[#&?]gid=(\d+)/.exec(url)?.[1] ?? '0';
  return `https://docs.google.com/spreadsheets/d/${google[1]}/export?format=csv&gid=${gid}`;
}

@Injectable({ providedIn: 'root' })
export class SheetSyncService {
  private readonly data = inject(DataService);

  readonly syncing = signal(false);
  readonly lastSyncAt = signal<string>(localStorage.getItem(LAST_SYNC_KEY) ?? '');
  readonly lastOutcomes = signal<SyncOutcome[]>([]);

  /** Re-read every linked sheet. Returns one outcome per link. */
  async syncAll(): Promise<SyncOutcome[]> {
    const links = this.data.settings().linkedSheets;
    if (links.length === 0) return [];

    this.syncing.set(true);
    const outcomes: SyncOutcome[] = [];
    try {
      for (const link of links) {
        outcomes.push(await this.syncOne(link));
      }
      const stamp = new Date().toISOString();
      this.lastSyncAt.set(stamp);
      localStorage.setItem(LAST_SYNC_KEY, stamp);
    } finally {
      this.syncing.set(false);
      this.lastOutcomes.set(outcomes);
    }
    return outcomes;
  }

  async syncOne(link: LinkedSheet): Promise<SyncOutcome> {
    const label = link.label !== '' ? link.label : link.role;
    // A blank link would resolve against the app's own address and hand back
    // the page's HTML, which fails much later and much more confusingly.
    if (link.url.trim() === '') {
      return { label, ok: false, message: 'No address filled in for this link yet.' };
    }
    try {
      const table = await this.firstTable(link);
      if (table === null) return { label, ok: false, message: 'That link returned no readable rows.' };

      if (link.role === 'items') return { label, ok: true, message: await this.applyItems(table, link) };
      if (link.role === 'aisles') return { label, ok: true, message: await this.applyAisles(table) };
      return { label, ok: true, message: await this.applyCustomers(table) };
    } catch (cause) {
      return { label, ok: false, message: describe(cause) };
    }
  }

  /** Fetch the link and read its first usable sheet. */
  private async firstTable(link: LinkedSheet): Promise<SheetTable | null> {
    const url = normalizeSheetUrl(link.url);
    const response = await fetch(url, { redirect: 'follow', cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`The link answered ${response.status} ${response.statusText}.`);
    }
    const workbook = readWorkbookBuffer(await response.arrayBuffer(), url);
    return workbook.tables.find((table) => table.rows.length > 0) ?? null;
  }

  private async applyItems(table: SheetTable, link: LinkedSheet): Promise<string> {
    const mapping = guessItemMapping(table.headers);
    if (!mapping.includes('item_name')) {
      throw new Error('No product-name column in that sheet.');
    }
    const result = buildItems(table, mapping);
    const before = new Set(this.data.items().map((item) => item.id));
    await this.data.saveItems(result.items);

    if (result.derivedAisles.length > 0 && !this.hasLinkedAisleSheet()) {
      await this.data.replaceAisles(result.derivedAisles);
    }

    let retired = 0;
    if (link.retireMissing) {
      const stillListed = new Set(result.items.map((item) => item.id));
      const gone = this.data
        .items()
        .filter((item) => item.active && !stillListed.has(item.id))
        .map((item) => ({ ...item, active: false }));
      if (gone.length > 0) {
        await this.data.saveItems(gone);
        retired = gone.length;
      }
    }

    const added = result.items.filter((item) => !before.has(item.id)).length;
    return [
      `${added} new`,
      `${result.items.length - added} updated`,
      retired > 0 ? `${retired} retired` : '',
    ]
      .filter((part) => part !== '')
      .join(', ');
  }

  private async applyAisles(table: SheetTable): Promise<string> {
    const mapping = guessAisleMapping(table.headers);
    if (!mapping.includes('aisle')) throw new Error('No aisle column in that sheet.');
    const result = buildAisles(table, mapping);
    await this.data.replaceAisles(result.aisles);
    return `${result.aisles.length} aisles`;
  }

  private async applyCustomers(table: SheetTable): Promise<string> {
    const mapping = guessCustomerMapping(table.headers);
    if (!mapping.includes('customer_name')) {
      throw new Error('No customer-name column in that sheet.');
    }
    const known = this.data.customers();
    const result = buildCustomers(table, mapping, known);
    const before = new Set(known.map((customer) => customer.id));
    await this.data.saveCustomers(result.customers);
    const added = result.customers.filter((customer) => !before.has(customer.id)).length;
    return `${added} new, ${result.customers.length - added} updated`;
  }

  /** An explicit walking-order link always beats one derived from the items. */
  private hasLinkedAisleSheet(): boolean {
    return this.data.settings().linkedSheets.some((link) => link.role === 'aisles');
  }
}

/** Turn fetch's famously unhelpful failures into something actionable. */
function describe(cause: unknown): string {
  const message = messageOf(cause);
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return 'The browser could not read that link. Most often the host does not allow other sites to fetch it — in Google Sheets use File → Share → Publish to web → CSV, and paste that address.';
  }
  return message;
}
