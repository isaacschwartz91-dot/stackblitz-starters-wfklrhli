/**
 * Store settings, storage choice, backup and a few statistics.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';

import { AuthService } from '../../core/auth.service';
import { DataService, messageOf } from '../../core/data.service';
import { SupabaseBackend, readStoredConfig, writeStoredConfig } from '../../core/supabase-backend';
import { ToastService } from '../../core/toast.service';
import type { AppSettings, LinkedSheet, Snapshot } from '../../core/models';
import { newId } from '../../core/ids';
import { SheetSyncService } from '../../import/sheet-sync.service';
import { LockService } from '../../core/lock.service';
import { demoSnapshot, DEMO_ORDER_TEXT } from '../../seed/demo-data';
import { SelectValue } from '../../ui/select-value';

@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, DatePipe, SelectValue],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Settings</h1>
          <p>Store details, where the data lives, backups and matching behaviour.</p>
        </div>
      </div>

      <div class="grid two">
        <!-- Store ---------------------------------------------------------- -->
        <div class="card">
          <div class="card-head"><h2>Store</h2></div>
          <label class="field">
            <span>Store name</span>
            <input
              type="text"
              [value]="draft().storeName"
              (input)="patch({ storeName: value($event) })"
            />
          </label>
          <div class="inline-fields">
            <label class="field">
              <span>Accent colour</span>
              <input
                type="color"
                style="height: 44px"
                [value]="draft().accentColor"
                (input)="patch({ accentColor: value($event) })"
              />
            </label>
            <label class="field">
              <span>Currency symbol</span>
              <input
                type="text"
                maxlength="3"
                [value]="draft().currencySymbol"
                (input)="patch({ currencySymbol: value($event) })"
              />
            </label>
          </div>
          @if (!auth.requiresLogin()) {
            <label class="field">
              <span>Your name (shown on orders)</span>
              <input
                type="text"
                [value]="auth.displayName()"
                (change)="setName(value($event))"
              />
            </label>
          }
          <div class="button-row">
            <button type="button" class="primary" (click)="saveSettings()" [disabled]="!dirty()">
              Save
            </button>
          </div>
        </div>

        <!-- Matching ------------------------------------------------------- -->
        <div class="card">
          <div class="card-head"><h2>Matching</h2></div>
          <label class="check" style="margin-bottom: 0.9rem">
            <input
              type="checkbox"
              [checked]="draft().splitOnCommas"
              (change)="patch({ splitOnCommas: !draft().splitOnCommas })"
            />
            <span>Also split pasted orders on commas (not just new lines)</span>
          </label>

          <label class="field">
            <span>
              Accept a match automatically at
              <strong>{{ percent(draft().autoAcceptScore) }}</strong> confidence or better
            </span>
            <input
              type="range"
              min="0.6"
              max="1"
              step="0.01"
              [value]="draft().autoAcceptScore"
              (input)="patch({ autoAcceptScore: number($event) })"
            />
          </label>
          <label class="field">
            <span>
              Below <strong>{{ percent(draft().reviewFloorScore) }}</strong> confidence, propose
              nothing
            </span>
            <input
              type="range"
              min="0.2"
              max="0.8"
              step="0.01"
              [value]="draft().reviewFloorScore"
              (input)="patch({ reviewFloorScore: number($event) })"
            />
          </label>
          <p class="small dim">
            Raise the first number if the software guesses too eagerly; lower it if you are
            confirming matches that were obviously right.
          </p>
          <div class="button-row">
            <button type="button" class="primary" (click)="saveSettings()" [disabled]="!dirty()">
              Save
            </button>
          </div>
        </div>

        <!-- Access ---------------------------------------------------------- -->
        <div class="card">
          <div class="card-head">
            <h2>Who can get in</h2>
            <span class="spacer"></span>
            <span class="chip" [class.ok]="accountsRequired()" [class.warn]="!accountsRequired()">
              {{ accountsRequired() ? 'Staff accounts' : 'No accounts' }}
            </span>
          </div>

          @if (!accountsRequired()) {
            <div class="notice warn">
              <strong>Anyone with this web address can open the app.</strong>
              They do <em>not</em> see your data — the catalog, customers and orders live in each
              person's own browser, so a stranger gets an empty copy. But nothing is checking who
              they are, and nothing is stopping someone who picks up this device.
            </div>
            <p class="small muted">
              For real staff accounts — one shared catalog, one order history, and a login that a
              server actually enforces — connect a Supabase project below. That is the only setting
              here that keeps people out of your data rather than out of one device.
            </p>
          } @else {
            <div class="notice ok">
              Staff sign in with an email and password, and the database refuses to hand out any
              row to someone who is not signed in.
            </div>
          }

          <h3 style="margin: 1rem 0 0.4rem">Passcode on this device</h3>
          <p class="small muted">
            Locks the app on this phone, tablet or computer so a passer-by cannot read what is
            stored here. It is per device, and it does not restrict the web address.
          </p>

          @if (!lock.available) {
            <div class="notice warn">
              A passcode needs a secure connection. Open the app over https (or on localhost) to set
              one.
            </div>
          } @else if (lock.enabled()) {
            <div class="notice ok">This device asks for a passcode when the app is opened.</div>
            <label class="field">
              <span>Current passcode</span>
              <input
                type="password"
                autocomplete="current-password"
                [value]="currentPasscode()"
                (input)="currentPasscode.set(value($event))"
              />
            </label>
            <div class="button-row">
              <button type="button" (click)="lock.lockNow()">Lock now</button>
              <button type="button" class="danger" (click)="removePasscode()" [disabled]="busy()">
                Remove passcode
              </button>
            </div>
          } @else {
            <div class="inline-fields">
              <label class="field">
                <span>New passcode</span>
                <input
                  type="password"
                  autocomplete="new-password"
                  [value]="newPasscode()"
                  (input)="newPasscode.set(value($event))"
                />
              </label>
              <label class="field">
                <span>Repeat it</span>
                <input
                  type="password"
                  autocomplete="new-password"
                  [value]="repeatPasscode()"
                  (input)="repeatPasscode.set(value($event))"
                />
              </label>
            </div>
            <div class="button-row">
              <button type="button" class="primary" (click)="setPasscode()" [disabled]="busy()">
                Set passcode
              </button>
            </div>
            <p class="small dim" style="margin: 0.6rem 0 0">
              It is never stored — only a one-way hash of it is. If it is forgotten there is no
              recovery; clearing the browser's data for this site removes the lock and the store
              data on this device together.
            </p>
          }

          @if (lockMessage()) {
            <div class="notice" style="margin-top: 0.7rem">{{ lockMessage() }}</div>
          }
        </div>

        <!-- Storage -------------------------------------------------------- -->
        <div class="card">
          <div class="card-head">
            <h2>Where the data lives</h2>
            <span class="spacer"></span>
            <span class="chip" [class.ok]="data.backendKind === 'supabase'">
              {{ data.backendKind === 'supabase' ? 'Cloud' : 'This browser' }}
            </span>
          </div>

          @if (data.backendKind === 'local') {
            <p class="small muted">
              Everything is stored in this browser only. That is fine for one person on one machine —
              but for several staff sharing one catalog and one order history, connect a Supabase
              project below.
            </p>
          } @else {
            <p class="small muted">
              Connected to <code>{{ supabaseUrl() }}</code
              >. Every signed-in member of staff sees the same data.
            </p>
          }

          <label class="field">
            <span>Supabase project URL</span>
            <input
              type="url"
              placeholder="https://xxxxxxxx.supabase.co"
              [value]="supabaseUrl()"
              (input)="supabaseUrl.set(value($event))"
            />
          </label>
          <label class="field">
            <span>Supabase anon public key</span>
            <input
              type="text"
              placeholder="eyJhbGciOi…"
              [value]="supabaseKey()"
              (input)="supabaseKey.set(value($event))"
            />
          </label>
          <p class="small dim">
            Run <code>supabase/schema.sql</code> in the Supabase SQL editor first — it creates the
            tables, the staff/admin roles and the access rules. Use the <em>anon public</em> key,
            never the service-role key.
          </p>

          <div class="button-row">
            <button type="button" (click)="testSupabase()" [disabled]="busy()">Test connection</button>
            <button type="button" class="primary" (click)="connectSupabase()" [disabled]="busy()">
              Connect
            </button>
            @if (data.backendKind === 'supabase') {
              <button type="button" class="danger" (click)="disconnectSupabase()">Disconnect</button>
            }
          </div>
          @if (storageMessage()) {
            <div class="notice" style="margin-top: 0.8rem">{{ storageMessage() }}</div>
          }
        </div>

        <!-- Linked sheets --------------------------------------------------- -->
        <div class="card">
          <div class="card-head">
            <h2>Sheets that update themselves</h2>
            <span class="spacer"></span>
            @if (sync.lastSyncAt()) {
              <span class="chip">last read {{ sync.lastSyncAt() | date: 'd MMM, h:mm a' }}</span>
            }
          </div>
          <p class="small muted">
            Point the app at a spreadsheet that lives online and it re-reads it every time the app
            opens — keep editing that one sheet and the software follows. Paste a Google Sheets
            address (use <em>File → Share → Publish to web → CSV</em>), or any link that returns an
            .xlsx or .csv file.
          </p>

          @for (link of draft().linkedSheets; track link.id) {
            <div
              class="card tight"
              style="box-shadow: none; background: var(--surface-2); margin-bottom: 0.6rem"
            >
              <div class="inline-fields">
                <label class="field" style="margin: 0; flex: 3 1 260px">
                  <span>Link</span>
                  <input
                    type="url"
                    placeholder="https://docs.google.com/spreadsheets/…"
                    [value]="link.url"
                    (input)="patchLink(link.id, { url: value($event) })"
                  />
                </label>
                <label class="field" style="margin: 0">
                  <span>Holds</span>
                  <select
                    [selectValue]="link.role"
                    (change)="patchLink(link.id, { role: linkRole($event) })"
                  >
                    <option value="items">Products</option>
                    <option value="aisles">Aisle walking order</option>
                    <option value="customers">Customers</option>
                  </select>
                </label>
              </div>
              <div class="button-row">
                @if (link.role === 'items') {
                  <label class="check">
                    <input
                      type="checkbox"
                      [checked]="link.retireMissing"
                      (change)="patchLink(link.id, { retireMissing: !link.retireMissing })"
                    />
                    <span class="small">
                      Hide products that have been taken off the sheet (orders keep them)
                    </span>
                  </label>
                }
                <span class="spacer"></span>
                <button type="button" class="small danger" (click)="removeLink(link.id)">
                  Remove
                </button>
              </div>
            </div>
          }

          <div class="button-row">
            <button type="button" (click)="addLink()">Add a sheet link</button>
            <button
              type="button"
              class="primary"
              (click)="syncNow()"
              [disabled]="sync.syncing() || draft().linkedSheets.length === 0 || dirty()"
            >
              {{ sync.syncing() ? 'Reading…' : 'Read them now' }}
            </button>
          </div>
          @if (dirty() && draft().linkedSheets.length > 0) {
            <p class="small" style="color: var(--warn); margin: 0.5rem 0 0">
              Save first, then read.
            </p>
          }

          <label class="check" style="margin-top: 0.7rem">
            <input
              type="checkbox"
              [checked]="draft().autoSyncOnOpen"
              (change)="patch({ autoSyncOnOpen: !draft().autoSyncOnOpen })"
            />
            <span>Re-read them automatically whenever the app opens</span>
          </label>

          @for (outcome of sync.lastOutcomes(); track outcome.label) {
            <div class="notice" [class.warn]="!outcome.ok" style="margin: 0.6rem 0 0">
              <strong>{{ outcome.label }}:</strong> {{ outcome.message }}
            </div>
          }

          <div class="button-row" style="margin-top: 0.8rem">
            <button type="button" class="primary" (click)="saveSettings()" [disabled]="!dirty()">
              Save
            </button>
          </div>
        </div>

        <!-- Backup --------------------------------------------------------- -->
        <div class="card">
          <div class="card-head"><h2>Backup &amp; demo data</h2></div>
          <p class="small muted">
            A backup is a single JSON file holding the catalog, walking order, customers, learned
            shorthand and every order.
          </p>
          <div class="button-row" style="margin-bottom: 0.9rem">
            <button type="button" (click)="downloadBackup()">Download backup</button>
            <label class="button" style="margin: 0">
              Restore from file
              <input type="file" accept=".json" hidden (change)="restoreBackup($event)" />
            </label>
          </div>

          <div class="button-row">
            <button type="button" (click)="loadDemo()" [disabled]="busy()">Load demo store</button>
            <button type="button" class="danger" (click)="wipe()" [disabled]="busy()">
              Erase everything
            </button>
          </div>
          <p class="small dim" style="margin-top: 0.6rem">
            The demo store has {{ demoItemCount }} products across 8 aisles, three customers and
            some ready-made shorthand — enough to try a real order end to end.
          </p>

          @if (data.items().length > 0) {
            <details style="margin-top: 0.8rem">
              <summary class="small muted" style="cursor: pointer">Example orders to paste</summary>
              <pre
                class="small"
                style="white-space: pre-wrap; background: var(--surface-2); padding: 0.6rem; border-radius: var(--radius-sm); margin-top: 0.5rem"
                >{{ demoOrders }}</pre
              >
            </details>
          }
        </div>

        <!-- Stats ---------------------------------------------------------- -->
        <div class="card">
          <div class="card-head"><h2>At a glance</h2></div>
          <div class="grid three" style="gap: 0.6rem">
            <div class="stat">
              <span class="value tabular">{{ data.items().length }}</span>
              <span class="label">Products</span>
            </div>
            <div class="stat">
              <span class="value tabular">{{ data.orders().length }}</span>
              <span class="label">Orders</span>
            </div>
            <div class="stat">
              <span class="value tabular">{{ data.aliases().length }}</span>
              <span class="label">Shorthand rules</span>
            </div>
          </div>

          @if (topItems().length > 0) {
            <h3 style="margin: 1rem 0 0.4rem">Most ordered</h3>
            <table>
              <tbody>
                @for (row of topItems(); track row.name) {
                  <tr>
                    <td>{{ row.name }}</td>
                    <td class="num tabular small dim">{{ row.count | number }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }

          @if (busiestDays().length > 0) {
            <h3 style="margin: 1rem 0 0.4rem">Busiest delivery days</h3>
            <table>
              <tbody>
                @for (row of busiestDays(); track row.day) {
                  <tr>
                    <td>{{ row.day }}</td>
                    <td class="num tabular small dim">{{ row.count }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </div>
      </div>
    </div>
  `,
})
export class SettingsPage {
  protected readonly data = inject(DataService);
  protected readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly sync = inject(SheetSyncService);
  protected readonly lock = inject(LockService);

  protected readonly newPasscode = signal('');
  protected readonly repeatPasscode = signal('');
  protected readonly currentPasscode = signal('');
  protected readonly lockMessage = signal('');

  /** True when a server, not this device, decides who gets in. */
  protected readonly accountsRequired = computed(() => this.auth.requiresLogin());

  protected readonly draft = signal<AppSettings>({ ...this.data.settings() });
  protected readonly busy = signal(false);
  protected readonly storageMessage = signal('');

  protected readonly supabaseUrl = signal(readStoredConfig()?.url ?? '');
  protected readonly supabaseKey = signal(readStoredConfig()?.anonKey ?? '');

  protected readonly demoItemCount = demoSnapshot().items.length;
  protected readonly demoOrders = [
    '— Phoned in —',
    DEMO_ORDER_TEXT.phone,
    '',
    '— Forwarded email —',
    DEMO_ORDER_TEXT.email,
    '',
    '— Typed in a hurry (typos on purpose) —',
    DEMO_ORDER_TEXT.messy,
  ].join('\n');

  protected readonly dirty = computed(
    () => JSON.stringify(this.draft()) !== JSON.stringify(this.data.settings()),
  );

  /** Which products get ordered most, counted across every saved order. */
  protected readonly topItems = computed(() => {
    const counts = new Map<string, number>();
    for (const line of this.data.orderLines()) {
      if (line.itemId === null) continue;
      counts.set(line.itemId, (counts.get(line.itemId) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([itemId, count]) => ({
        name: this.data.itemsById().get(itemId)?.name ?? 'Unknown product',
        count,
      }));
  });

  protected readonly busiestDays = computed(() => {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const counts = new Map<string, number>();
    for (const order of this.data.orders()) {
      const when = order.deliveryAt || order.createdAt;
      const date = new Date(when);
      if (Number.isNaN(date.getTime())) continue;
      const day = names[date.getDay()];
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([day, count]) => ({ day, count }));
  });

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected number(event: Event): number {
    return Number(this.value(event));
  }

  protected percent(score: number): string {
    return `${Math.round(score * 100)}%`;
  }

  protected patch(patch: Partial<AppSettings>): void {
    this.draft.set({ ...this.draft(), ...patch });
  }

  /* ---------------------------------------------------------------- lock -- */

  protected async setPasscode(): Promise<void> {
    this.lockMessage.set('');
    if (this.newPasscode() !== this.repeatPasscode()) {
      this.lockMessage.set('The two passcodes do not match.');
      return;
    }
    this.busy.set(true);
    try {
      await this.lock.setPasscode(this.newPasscode());
      this.newPasscode.set('');
      this.repeatPasscode.set('');
      this.toast.ok('Passcode set. This device will ask for it from now on.');
    } catch (cause) {
      this.lockMessage.set(messageOf(cause));
    } finally {
      this.busy.set(false);
    }
  }

  protected async removePasscode(): Promise<void> {
    this.lockMessage.set('');
    this.busy.set(true);
    try {
      const removed = await this.lock.remove(this.currentPasscode());
      this.currentPasscode.set('');
      if (removed) this.toast.ok('Passcode removed.');
      else this.lockMessage.set('That passcode does not match, so nothing was changed.');
    } finally {
      this.busy.set(false);
    }
  }

  /* -------------------------------------------------------- linked sheets -- */

  protected linkRole(event: Event): LinkedSheet['role'] {
    return this.value(event) as LinkedSheet['role'];
  }

  protected addLink(): void {
    const link: LinkedSheet = {
      id: newId('link'),
      url: '',
      role: 'items',
      label: '',
      retireMissing: true,
    };
    this.patch({ linkedSheets: [...this.draft().linkedSheets, link] });
  }

  protected patchLink(id: string, patch: Partial<LinkedSheet>): void {
    this.patch({
      linkedSheets: this.draft().linkedSheets.map((link) =>
        link.id === id ? { ...link, ...patch } : link,
      ),
    });
  }

  protected removeLink(id: string): void {
    this.patch({ linkedSheets: this.draft().linkedSheets.filter((link) => link.id !== id) });
  }

  protected async syncNow(): Promise<void> {
    const outcomes = await this.sync.syncAll();
    const failed = outcomes.filter((outcome) => !outcome.ok).length;
    if (failed === 0) this.toast.ok('Sheets read. Everything is up to date.');
    else this.toast.warn(`${failed} of ${outcomes.length} links could not be read — see below.`);
  }

  protected setName(name: string): void {
    this.auth.setLocalUser(name, 'admin');
  }

  protected async saveSettings(): Promise<void> {
    try {
      await this.data.saveSettings(this.draft());
      this.toast.ok('Settings saved.');
    } catch (cause) {
      this.toast.error(messageOf(cause));
    }
  }

  /* ------------------------------------------------------------- storage -- */

  private buildSupabase(): SupabaseBackend | null {
    const url = this.supabaseUrl().trim();
    const key = this.supabaseKey().trim();
    if (url === '' || key === '') {
      this.storageMessage.set('Enter both the project URL and the anon key.');
      return null;
    }
    return new SupabaseBackend({ url: url.replace(/\/+$/, ''), anonKey: key });
  }

  protected async testSupabase(): Promise<void> {
    const backend = this.buildSupabase();
    if (backend === null) return;
    this.busy.set(true);
    try {
      this.storageMessage.set(await backend.testConnection());
    } catch (cause) {
      this.storageMessage.set(
        `${messageOf(cause)} — check the URL and key, and that schema.sql has been run.`,
      );
    } finally {
      this.busy.set(false);
    }
  }

  protected async connectSupabase(): Promise<void> {
    const backend = this.buildSupabase();
    if (backend === null) return;
    if (
      !confirm(
        'Switch to the Supabase database? Data saved in this browser stays here — download a backup first if you want to move it.',
      )
    ) {
      return;
    }
    writeStoredConfig({ url: this.supabaseUrl().trim(), anonKey: this.supabaseKey().trim() });
    location.reload();
  }

  protected async disconnectSupabase(): Promise<void> {
    if (!confirm('Disconnect from Supabase and go back to this browser only?')) return;
    writeStoredConfig(null);
    location.reload();
  }

  /* -------------------------------------------------------------- backup -- */

  protected downloadBackup(): void {
    const snapshot = this.data.snapshot();
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `grocery-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  protected async restoreBackup(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file === undefined) return;
    if (!confirm('Restoring replaces everything currently stored. Continue?')) return;

    this.busy.set(true);
    try {
      const parsed = JSON.parse(await file.text()) as Partial<Snapshot>;
      if (!Array.isArray(parsed.items) || !Array.isArray(parsed.aisles)) {
        throw new Error('That file does not look like a backup.');
      }
      await this.data.restore({
        items: parsed.items,
        aisles: parsed.aisles,
        customers: parsed.customers ?? [],
        aliases: parsed.aliases ?? [],
        orders: parsed.orders ?? [],
        orderLines: parsed.orderLines ?? [],
        settings: { ...this.data.settings(), ...(parsed.settings ?? {}) },
      });
      this.draft.set({ ...this.data.settings() });
      this.toast.ok('Backup restored.');
    } catch (cause) {
      this.toast.error(messageOf(cause));
    } finally {
      this.busy.set(false);
    }
  }

  protected async loadDemo(): Promise<void> {
    if (!confirm('Load the demo store? This replaces everything currently stored.')) return;
    this.busy.set(true);
    try {
      await this.data.restore(demoSnapshot());
      this.draft.set({ ...this.data.settings() });
      this.toast.ok('Demo store loaded. Try pasting one of the example orders.');
    } catch (cause) {
      this.toast.error(messageOf(cause));
    } finally {
      this.busy.set(false);
    }
  }

  protected async wipe(): Promise<void> {
    if (!confirm('Erase the catalog, customers, shorthand and every order? This cannot be undone.')) {
      return;
    }
    this.busy.set(true);
    try {
      await this.data.clearAll();
      this.toast.ok('Everything erased.');
    } catch (cause) {
      this.toast.error(messageOf(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
