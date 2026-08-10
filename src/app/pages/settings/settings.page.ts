/**
 * Store settings, storage choice, backup and a few statistics.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';

import { AuthService } from '../../core/auth.service';
import { DataService, messageOf } from '../../core/data.service';
import { SupabaseBackend, readStoredConfig, writeStoredConfig } from '../../core/supabase-backend';
import { ToastService } from '../../core/toast.service';
import type { ClearScope } from '../../core/backend';
import type { AppSettings, LinkedSheet, Snapshot } from '../../core/models';
import { newId } from '../../core/ids';
import { SheetSyncService } from '../../import/sheet-sync.service';
import { LockService } from '../../core/lock.service';
import { demoSnapshot, DEMO_ORDER_TEXT } from '../../seed/demo-data';
import { SelectValue } from '../../ui/select-value';
import { runtimeConfig } from '../../core/runtime-config';
import { prepareLogo } from '../../core/logo-image';

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
          <div class="field">
            <span>Logo</span>
            <div class="logo-row">
              @if (draft().logoUrl) {
                <img class="logo-preview" [src]="draft().logoUrl" alt="Store logo" />
              } @else {
                <div class="logo-preview empty small dim">No logo</div>
              }
              <div class="button-row" style="margin: 0">
                <label class="button" style="margin: 0">
                  {{ draft().logoUrl ? 'Replace' : 'Upload' }}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml,image/webp"
                    hidden
                    [disabled]="busy()"
                    (change)="uploadLogo($event)"
                  />
                </label>
                @if (draft().logoUrl) {
                  <button type="button" class="ghost" (click)="removeLogo()" [disabled]="busy()">
                    Remove
                  </button>
                }
              </div>
            </div>
            <p class="small dim" style="margin: 0.45rem 0 0">
              Shown in the top bar on every page. PNG, JPEG, SVG or WebP; it is resized for you.
              Remember to press Save.
            </p>
            @if (logoMessage()) {
              <p class="small" style="margin: 0.35rem 0 0">{{ logoMessage() }}</p>
            }
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

        <!-- Delete data ------------------------------------------------------ -->
        <div class="card">
          <div class="card-head"><h2>Delete data</h2></div>
          <p class="small muted">
            Each button deletes one kind of data and leaves the rest alone. You will be shown
            exactly what goes and what stays before anything is deleted.
          </p>

          <div class="button-row" style="margin-top: 0.9rem">
            <button type="button" (click)="askClear('items')" [disabled]="busy()">
              Delete products
            </button>
            <button type="button" (click)="askClear('customers')" [disabled]="busy()">
              Delete customers
            </button>
            <button type="button" (click)="askClear('orders')" [disabled]="busy()">
              Delete orders
            </button>
            <span class="spacer"></span>
            <button type="button" class="danger" (click)="askClear('everything')" [disabled]="busy()">
              Erase everything
            </button>
          </div>

          <p class="small dim" style="margin-top: 0.7rem">
            Re-uploading a sheet does not need any of these: an upload updates products it already
            knows and adds the rest. Delete products only when the catalog itself should start
            empty.
          </p>
        </div>

        <!-- Which build this is --------------------------------------------- -->
        <div class="card">
          <div class="card-head"><h2>This version</h2></div>
          <p class="small muted">
            Quote this when a change does not seem to have arrived. It says which build the
            browser is running, which is the difference between a deploy that has not happened
            and a page that came out of the cache.
          </p>
          <table style="margin-top: 0.6rem">
            <tbody>
              <tr>
                <td class="small dim" style="width: 8rem">Build</td>
                <td class="small tabular">{{ buildLabel() }}</td>
              </tr>
              <tr>
                <td class="small dim">Storage</td>
                <td class="small">{{ data.backend.describe }}</td>
              </tr>
            </tbody>
          </table>
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

    @if (clearPlan(); as plan) {
      <div class="modal-backdrop" (click)="cancelClear()">
        <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
          <h2>{{ plan.title }}</h2>

          <p class="small muted">This cannot be undone.</p>

          <h3 class="small" style="margin: 0.9rem 0 0.3rem">Deleted</h3>
          <ul class="consequences gone">
            @for (line of plan.removes; track line) {
              <li>{{ line }}</li>
            }
          </ul>

          @if (plan.keeps.length > 0) {
            <h3 class="small" style="margin: 0.9rem 0 0.3rem">Kept</h3>
            <ul class="consequences kept">
              @for (line of plan.keeps; track line) {
                <li>{{ line }}</li>
              }
            </ul>
          }

          <label class="check" style="margin: 1rem 0 0.4rem">
            <input
              type="checkbox"
              [checked]="backupFirst()"
              (change)="backupFirst.set(!backupFirst())"
            />
            <span>Download a backup first</span>
          </label>

          @if (plan.scope === 'everything') {
            <label class="field" style="margin-top: 0.6rem">
              <span>Type ERASE to confirm</span>
              <input
                type="text"
                autocomplete="off"
                [value]="typed()"
                (input)="typed.set(inputValue($event))"
              />
            </label>
          }

          <div class="button-row" style="margin-top: 1rem">
            <button
              type="button"
              class="danger"
              [disabled]="busy() || !clearAllowed()"
              (click)="confirmClear()"
            >
              {{ plan.action }}
            </button>
            <button type="button" class="ghost" (click)="cancelClear()">Cancel</button>
          </div>
        </div>
      </div>
    }
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

  protected readonly logoMessage = signal('');

  /**
   * Take an uploaded logo and put it somewhere the app can load it from.
   *
   * Supabase Storage when there is a project to hold it, so every device
   * fetches one small file. Otherwise the image itself goes into settings —
   * a store running on browser storage has nowhere to upload to, and it
   * should still get its own logo rather than an error.
   */
  protected async uploadLogo(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file === undefined) return;

    this.busy.set(true);
    this.logoMessage.set('');
    try {
      const prepared = await prepareLogo(file);
      const backend = this.data.backend;

      if (backend instanceof SupabaseBackend) {
        try {
          const url = await backend.uploadLogo(prepared.blob, extensionFor(prepared.blob.type));
          this.patch({ logoUrl: url });
          this.logoMessage.set('Uploaded. Press Save to use it.');
          return;
        } catch (cause) {
          // A missing bucket should not cost someone their logo; keep the
          // image and say where it ended up instead.
          this.patch({ logoUrl: prepared.dataUrl });
          this.logoMessage.set(
            `${messageOf(cause)} Stored with your settings instead — press Save to use it.`,
          );
          return;
        }
      }

      this.patch({ logoUrl: prepared.dataUrl });
      this.logoMessage.set('Ready. Press Save to use it.');
    } catch (cause) {
      this.logoMessage.set(messageOf(cause));
    } finally {
      this.busy.set(false);
    }
  }

  protected removeLogo(): void {
    this.patch({ logoUrl: '' });
    this.logoMessage.set('Removed. Press Save to confirm.');
  }

  /**
   * The build the browser is actually running.
   *
   * A deploy that never happened and a cached page look the same from the
   * outside; this is the one thing that tells them apart.
   */
  protected readonly buildLabel = computed(() => {
    const config = runtimeConfig();
    if (config === null || config.commit === '') {
      return 'Unknown — this copy was built without deploy information.';
    }
    const when = config.builtAt === '' ? '' : new Date(config.builtAt).toLocaleString();
    return [config.commit, config.branch, when].filter((part) => part !== '').join(' · ');
  });

  // -- Deleting data ---------------------------------------------------------

  protected readonly pendingScope = signal<ClearScope | null>(null);
  protected readonly backupFirst = signal(true);
  protected readonly typed = signal('');

  /**
   * Spelled out from the live counts, so the warning cannot drift from what
   * the buttons actually do. The knock-on effects are the important part: the
   * shorthand that disappears with a catalog is exactly the sort of thing
   * people only discover afterwards.
   */
  protected readonly clearPlan = computed(() => {
    const scope = this.pendingScope();
    if (scope === null) return null;

    const items = this.data.items().length;
    const customers = this.data.customers().length;
    const orders = this.data.orders().length;
    const aliases = this.data.aliases();
    const privateAliases = aliases.filter((alias) => alias.customerId !== null).length;
    const globalAliases = aliases.length - privateAliases;
    const plural = (count: number, one: string, many = `${one}s`) =>
      `${count} ${count === 1 ? one : many}`;

    if (scope === 'items') {
      return {
        scope,
        title: 'Delete every product?',
        action: 'Delete products',
        removes: [
          `${plural(items, 'product')} — the whole catalog.`,
          `${plural(aliases.length, 'piece', 'pieces')} of learned shorthand. Shorthand points at a product, so none of it can outlive the catalog.`,
        ],
        keeps: [
          `${plural(customers, 'customer')}.`,
          `${plural(orders, 'order')}, kept as history. Their lines will no longer link to a product.`,
          'The walking order.',
        ],
      };
    }

    if (scope === 'customers') {
      return {
        scope,
        title: 'Delete every customer?',
        action: 'Delete customers',
        removes: [
          `${plural(customers, 'customer')}.`,
          `${plural(privateAliases, 'piece', 'pieces')} of customer shorthand — what each customer means by their own words.`,
        ],
        keeps: [
          `${plural(items, 'product')}.`,
          `${plural(globalAliases, 'piece', 'pieces')} of store-wide shorthand.`,
          `${plural(orders, 'order')}, kept on file with no customer attached.`,
        ],
      };
    }

    if (scope === 'orders') {
      return {
        scope,
        title: 'Delete every order?',
        action: 'Delete orders',
        removes: [`${plural(orders, 'order')} and every line on them.`],
        keeps: [
          `${plural(items, 'product')}.`,
          `${plural(customers, 'customer')}.`,
          `${plural(aliases.length, 'piece', 'pieces')} of learned shorthand.`,
          'The walking order.',
        ],
      };
    }

    return {
      scope,
      title: 'Erase everything?',
      action: 'Erase everything',
      removes: [
        `${plural(items, 'product')}.`,
        `${plural(customers, 'customer')}.`,
        `${plural(orders, 'order')}.`,
        `${plural(aliases.length, 'piece', 'pieces')} of learned shorthand.`,
        'The walking order.',
      ],
      keeps: ['Your settings: store name, linked sheets and where data is stored.'],
    };
  });

  /** The nuclear option asks for the word; the scoped ones do not. */
  protected readonly clearAllowed = computed(
    () => this.pendingScope() !== 'everything' || this.typed().trim().toUpperCase() === 'ERASE',
  );
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

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected askClear(scope: ClearScope): void {
    this.pendingScope.set(scope);
    this.backupFirst.set(true);
    this.typed.set('');
  }

  protected cancelClear(): void {
    this.pendingScope.set(null);
    this.typed.set('');
  }

  protected async confirmClear(): Promise<void> {
    const plan = this.clearPlan();
    if (plan === null || !this.clearAllowed()) return;

    this.busy.set(true);
    try {
      // Saved before the delete, so a mistake is recoverable through
      // "Restore from file" rather than by retyping a customer list.
      if (this.backupFirst()) this.downloadBackup();
      await this.data.clear(plan.scope);
      this.toast.ok(CLEARED_MESSAGE[plan.scope]);
      this.pendingScope.set(null);
      this.typed.set('');
    } catch (cause) {
      this.toast.error(messageOf(cause));
    } finally {
      this.busy.set(false);
    }
  }
}

const CLEARED_MESSAGE: Record<ClearScope, string> = {
  items: 'Catalog deleted. Customers and orders are untouched — upload a sheet to start again.',
  customers: 'Customers deleted. The catalog and past orders are untouched.',
  orders: 'Orders deleted. The catalog, customers and shorthand are untouched.',
  everything: 'Everything erased. Your settings were kept.',
};

/** File extension for an uploaded logo, from its type. */
function extensionFor(mime: string): string {
  if (mime === 'image/svg+xml') return 'svg';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}
