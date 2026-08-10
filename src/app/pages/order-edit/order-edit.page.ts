/**
 * Take an order and get it matched.
 *
 * Paste the phone call or the forwarded email, and every line comes back with
 * a quantity, a unit and a product. Anything the software is unsure about is
 * flagged; fixing it takes one click, and the fix can be remembered so the
 * same phrase never needs correcting again.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { AuthService } from '../../core/auth.service';
import { DataService, messageOf } from '../../core/data.service';
import { OrderService } from '../../core/order.service';
import { ToastService } from '../../core/toast.service';
import type { Customer, Item, Order, OrderLine } from '../../core/models';
import { MATCH_SOURCE_LABEL, itemDetail } from '../../core/models';
import type { Candidate } from '../../matching/matcher';
import { splitOrderText } from '../../matching/parse-line';
import { aisleKey, aisleLabel } from '../../matching/pick-list';
import { ItemPicker } from '../../ui/item-picker';
import { SelectValue } from '../../ui/select-value';

type Scope = 'none' | 'customer' | 'global';

@Component({
  selector: 'app-order-edit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, ItemPicker, SelectValue],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>{{ isNew() ? 'New order' : 'Edit order' }}</h1>
          <p>Paste what the customer said. One item per line.</p>
        </div>
        <span class="spacer"></span>
        @if (!isNew()) {
          <a class="button" [routerLink]="['/orders', order().id, 'pick']">Open pick list</a>
        }
      </div>

      @if (data.items().length === 0) {
        <div class="notice warn">
          There is no catalog to match against yet.
          <a routerLink="/catalog">Upload your item list</a> or
          <a routerLink="/settings">load the demo store</a> first.
        </div>
      }

      <div class="card" style="margin-bottom: 1rem">
        <div class="inline-fields">
          <label class="field">
            <span>Customer</span>
            <select [selectValue]="order().customerId ?? ''" (change)="changeCustomer($event)">
              <option value="">— Walk-in / no customer —</option>
              @for (customer of sortedCustomers(); track customer.id) {
                <option [value]="customer.id">{{ customer.name }}</option>
              }
              <option value="__new__">+ Add a new customer…</option>
            </select>
          </label>

          <label class="field">
            <span>Delivery date &amp; time</span>
            <input
              type="datetime-local"
              [value]="deliveryLocal()"
              (change)="changeDelivery($event)"
            />
          </label>

          <label class="field">
            <span>Notes for this order</span>
            <input
              type="text"
              [value]="order().notes"
              (input)="patchOrder({ notes: inputValue($event) })"
              placeholder="Leave at the back door, call on arrival…"
            />
          </label>
        </div>

        @if (customerAliasCount() > 0) {
          <p class="small muted" style="margin: 0">
            {{ customerName() }} has {{ customerAliasCount() }} learned shorthand
            {{ customerAliasCount() === 1 ? 'rule' : 'rules' }} — they are applied first.
            <a routerLink="/aliases">Review them</a>
          </p>
        }
        @if (lastOrderId() !== null && isNew()) {
          <button type="button" class="small" (click)="repeatLastOrder()">
            Repeat {{ customerName() }}'s last order
          </button>
        }
      </div>

      <div class="grid two" style="margin-bottom: 1rem">
        <div class="card">
          <div class="card-head">
            <h2>Paste the order</h2>
          </div>
          <textarea
            class="paste-area"
            [value]="pasteText()"
            (input)="pasteText.set(inputValue($event))"
            placeholder="2 milk&#10;dozen eggs&#10;3 lb apples&#10;rye bread"
            aria-label="Paste the order text"
          ></textarea>
          <div class="button-row" style="margin-top: 0.6rem">
            <button
              type="button"
              class="primary"
              (click)="addPasted()"
              [disabled]="pastedLineCount() === 0"
            >
              Add {{ pastedLineCount() }} {{ pastedLineCount() === 1 ? 'line' : 'lines' }}
            </button>
            <button type="button" class="ghost" (click)="pasteText.set('')" [disabled]="!pasteText()">
              Clear
            </button>
          </div>
          <p class="small dim" style="margin: 0.6rem 0 0">
            Quantities are read from the line: <code>2 milk</code>, <code>milk x3</code>,
            <code>3 lb apples</code>, <code>dozen eggs</code>. Email headers and bullets are ignored.
          </p>
        </div>

        <div class="card">
          <div class="card-head"><h2>Or add one product at a time</h2></div>
          <app-item-picker
            placeholder="Start typing a product name…"
            (picked)="addItem($event)"
          />
          <p class="small dim" style="margin: 0.6rem 0 0">
            Searches the catalog as you type. Use ↑ ↓ and Enter.
          </p>

          @if (needsAttentionCount() > 0) {
            <div class="notice warn" style="margin: 0.9rem 0 0">
              <strong>{{ needsAttentionCount() }}</strong> line(s) need a human. They are marked
              below.
            </div>
          }
        </div>
      </div>

      @if (lines().length > 0) {
        <div class="card">
          <div class="card-head">
            <h2>{{ lines().length }} lines</h2>
            <span class="chip ok">{{ matchedCount() }} matched</span>
            @if (needsAttentionCount() > 0) {
              <span class="chip warn">{{ needsAttentionCount() }} to check</span>
            }
            <span class="spacer"></span>
            <button type="button" class="small ghost" (click)="rematchAll()">Re-run matching</button>
            <button type="button" class="small danger" (click)="clearLines()">Remove all</button>
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style="width: 22%">They said</th>
                  <th style="width: 5.5rem">Qty</th>
                  <th style="width: 5.5rem">Unit</th>
                  <th>Matched product</th>
                  <th class="num" style="width: 7rem">Price</th>
                  <th style="width: 9rem">UPC</th>
                  <th style="width: 9rem">Where</th>
                  <th style="width: 7rem"></th>
                </tr>
              </thead>
              <tbody>
                @for (line of lines(); track line.id) {
                  <tr [style.background]="line.needsReview ? 'var(--warn-soft)' : ''">
                    <td>
                      <div>{{ line.rawText }}</div>
                      @if (line.note) {
                        <div class="small dim">note: {{ line.note }}</div>
                      }
                    </td>
                    <td>
                      <input
                        type="number"
                        class="num"
                        min="0"
                        step="0.5"
                        [value]="line.qty"
                        (input)="setQty(line, inputValue($event))"
                        aria-label="Quantity"
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        [value]="line.unit"
                        (input)="patchLine(line, { unit: inputValue($event) })"
                        aria-label="Unit"
                      />
                    </td>
                    <td>
                      @if (itemFor(line); as item) {
                        <div class="name">{{ item.name }}</div>
                        <div class="small dim">
                          {{ detail(item) }}
                          <span class="chip" [class.warn]="line.needsReview">
                            {{ sourceLabel(line) }}
                          </span>
                        </div>
                      } @else {
                        <span class="chip danger">No match</span>
                        <div class="small dim">Pick the right product →</div>
                      }
                    </td>
                    <td class="num small tabular">
                      @if (itemFor(line); as item) {
                        @if (item.price !== null) {
                          <div>{{ money(item.price) }}</div>
                          @if (line.qty !== 1) {
                            <div class="dim">{{ money(item.price * line.qty) }}</div>
                          }
                        } @else {
                          <span class="dim">—</span>
                        }
                      } @else {
                        <span class="dim">—</span>
                      }
                    </td>
                    <td class="small tabular">
                      @if (barcodeOf(line); as code) {
                        {{ code }}
                      } @else {
                        <span class="dim">—</span>
                      }
                    </td>
                    <td class="small dim">{{ where(line) }}</td>
                    <td>
                      <div class="button-row" style="gap: 0.25rem">
                        <button type="button" class="small" (click)="startFix(line)">
                          {{ line.itemId ? 'Change' : 'Fix' }}
                        </button>
                        <button
                          type="button"
                          class="small ghost"
                          (click)="removeLine(line)"
                          aria-label="Remove line"
                        >
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      } @else {
        <div class="card empty">
          <h3>No lines yet</h3>
          <p class="muted">Paste an order above, or search for a product to add it.</p>
        </div>
      }

      <div class="sticky-actions">
        <button type="button" class="primary big" (click)="saveAndPick()" [disabled]="saving() || lines().length === 0">
          {{ saving() ? 'Saving…' : 'Save & open pick list' }}
        </button>
        <button type="button" (click)="save(false)" [disabled]="saving()">Save draft</button>
        <span class="spacer"></span>
        @if (orderTotal(); as sum) {
          @if (sum.priced > 0) {
            <span class="small dim" style="margin-right: 0.8rem">
              {{ money(sum.total) }}
              @if (sum.unpriced > 0) {
                <span>({{ sum.unpriced }} without a price)</span>
              }
            </span>
          }
        }
        <span class="small dim">{{ matchedCount() }}/{{ lines().length }} matched</span>
      </div>
    </div>

    <!-- Fix / teach ------------------------------------------------------- -->
    @if (fixing(); as line) {
      <div class="modal-backdrop" (click)="cancelFix()">
        <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
          <h2>What did they mean by “{{ line.rawText }}”?</h2>
          <p class="muted small">
            Pick the right product. You can save it so this phrase matches on its own next time.
          </p>

          @if (fixCandidates().length > 0) {
            <div class="small muted" style="margin-bottom: 0.3rem">Closest products</div>
            <div class="suggestions" style="position: static; box-shadow: none; margin-bottom: 0.8rem">
              <div class="suggestion-head">
                <span>Product</span>
                <span>Size</span>
                <span>UPC</span>
                <span></span>
              </div>
              @for (candidate of fixCandidates(); track candidate.item.id) {
                <button
                  type="button"
                  class="suggestion"
                  [class.active]="chosen()?.id === candidate.item.id"
                  (click)="chosen.set(candidate.item)"
                >
                  <span>
                    <strong>{{ candidate.item.name }}</strong>
                    @if (candidate.item.brand) {
                      <span class="dim small"> · {{ candidate.item.brand }}</span>
                    }
                  </span>
                  <span class="s-size small dim">{{ candidate.item.size || '—' }}</span>
                  <span class="s-upc small dim tabular">{{ candidate.item.barcode || '—' }}</span>
                  <span class="where">{{ percent(candidate.score) }}</span>
                </button>
              }
            </div>
          }

          <label class="field">
            <span>Or search the whole catalog</span>
            <app-item-picker
              placeholder="Search products…"
              [clearOnPick]="false"
              (picked)="chosen.set($event)"
            />
          </label>

          @if (chosen(); as pick) {
            <div class="notice ok">
              Using <strong>{{ pick.name }}</strong>
              <span class="small"> {{ detail(pick) }}</span>
            </div>

            <fieldset style="border: 1px solid var(--line); border-radius: var(--radius); padding: 0.7rem">
              <legend class="small muted">Remember this?</legend>
              <label class="check" style="display: flex; margin-bottom: 0.3rem">
                <input type="radio" name="scope" value="none" [(ngModel)]="scope" />
                <span>Just this once</span>
              </label>
              @if (order().customerId !== null) {
                <label class="check" style="display: flex; margin-bottom: 0.3rem">
                  <input type="radio" name="scope" value="customer" [(ngModel)]="scope" />
                  <span>
                    Always, for <strong>{{ customerName() }}</strong> — “{{ aliasPhrase() }}” means
                    this
                  </span>
                </label>
              }
              <label class="check" style="display: flex">
                <input type="radio" name="scope" value="global" [(ngModel)]="scope" />
                <span>Always, for everyone — “{{ aliasPhrase() }}” means this</span>
              </label>
            </fieldset>
          }

          <div class="button-row" style="margin-top: 1rem">
            <button type="button" class="primary" (click)="applyFix()" [disabled]="chosen() === null">
              Use this product
            </button>
            <button type="button" class="ghost" (click)="cancelFix()">Cancel</button>
          </div>
        </div>
      </div>
    }

    <!-- New customer ------------------------------------------------------ -->
    @if (addingCustomer()) {
      <div class="modal-backdrop" (click)="addingCustomer.set(false)">
        <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
          <h2>New customer</h2>
          <label class="field">
            <span>Name</span>
            <input type="text" [(ngModel)]="newCustomerName" placeholder="John Cohen" />
          </label>
          <label class="field">
            <span>Phone</span>
            <input type="tel" [(ngModel)]="newCustomerPhone" />
          </label>
          <div class="button-row">
            <button type="button" class="primary" (click)="createCustomer()">Add customer</button>
            <button type="button" class="ghost" (click)="addingCustomer.set(false)">Cancel</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class OrderEditPage {
  protected readonly data = inject(DataService);
  private readonly orders = inject(OrderService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly order = signal<Order>(
    this.orders.newOrder(null, '', this.auth.displayName()),
  );
  protected readonly lines = signal<OrderLine[]>([]);
  protected readonly saving = signal(false);
  protected readonly isNew = signal(true);

  protected readonly pasteText = signal('');

  protected readonly fixing = signal<OrderLine | null>(null);
  protected readonly fixCandidates = signal<Candidate[]>([]);
  protected readonly chosen = signal<Item | null>(null);
  /** Remembering for everyone is the default; `startFix` resets to it each time. */
  protected scope: Scope = 'global';

  protected readonly addingCustomer = signal(false);
  protected newCustomerName = '';
  protected newCustomerPhone = '';

  protected readonly sortedCustomers = computed(() =>
    [...this.data.customers()].sort((a, b) => a.name.localeCompare(b.name)),
  );

  protected readonly matchedCount = computed(
    () => this.lines().filter((line) => line.itemId !== null && !line.needsReview).length,
  );

  protected readonly needsAttentionCount = computed(
    () => this.lines().filter((line) => line.itemId === null || line.needsReview).length,
  );

  protected readonly customerAliasCount = computed(
    () => this.data.aliasesForCustomer(this.order().customerId).length,
  );

  protected readonly lastOrderId = computed(() => {
    const customerId = this.order().customerId;
    if (customerId === null) return null;
    return this.data.lastOrderFor(customerId)?.id ?? null;
  });

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    if (id !== null) {
      const existing = this.data.orderById(id);
      if (existing !== null) {
        this.order.set(existing);
        this.lines.set(this.data.linesFor(id));
        this.isNew.set(false);
      }
    }
  }

  /* ------------------------------------------------------------- helpers -- */

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected itemFor(line: OrderLine): Item | null {
    return line.itemId === null ? null : (this.data.itemsById().get(line.itemId) ?? null);
  }

  protected detail(item: Item): string {
    return itemDetail(item);
  }

  /** Formatted with the store's own currency symbol, set in Settings. */
  protected money(amount: number): string {
    return `${this.data.settings().currencySymbol}${amount.toFixed(2)}`;
  }

  protected barcodeOf(line: OrderLine): string {
    const code = this.itemFor(line)?.barcode.trim() ?? '';
    return code;
  }

  /**
   * What the priced lines come to.
   *
   * A price column is only worth reading if it adds up to something, but a
   * catalog rarely prices everything — so the count of unpriced lines travels
   * with the total rather than being folded into it as zero.
   */
  protected readonly orderTotal = computed(() => {
    let total = 0;
    let priced = 0;
    let unpriced = 0;
    for (const line of this.lines()) {
      const price = this.itemFor(line)?.price ?? null;
      if (price === null) {
        unpriced += 1;
        continue;
      }
      total += price * line.qty;
      priced += 1;
    }
    return { total, priced, unpriced };
  });

  protected sourceLabel(line: OrderLine): string {
    return MATCH_SOURCE_LABEL[line.matchSource];
  }

  protected percent(score: number): string {
    return `${Math.round(score * 100)}% match`;
  }

  protected where(line: OrderLine): string {
    const item = this.itemFor(line);
    if (item === null || item.aisle.trim() === '') return '—';
    const aisle = this.data.aisles().find((entry) => aisleKey(entry.id) === aisleKey(item.aisle));
    return aisleLabel(item.aisle, aisle?.name ?? '');
  }

  protected customerName(): string {
    return this.data.customerById(this.order().customerId)?.name ?? 'this customer';
  }

  protected deliveryLocal(): string {
    const value = this.order().deliveryAt;
    if (value === '') return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    // datetime-local wants local wall-clock time, not UTC.
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  }

  /** How many order lines the pasted text will produce, live as it is typed. */
  protected readonly pastedLineCount = computed(
    () => splitOrderText(this.pasteText(), this.data.settings().splitOnCommas).length,
  );

  /* -------------------------------------------------------------- order -- */

  protected patchOrder(patch: Partial<Order>): void {
    this.order.set({ ...this.order(), ...patch });
  }

  protected changeDelivery(event: Event): void {
    const value = this.inputValue(event);
    this.patchOrder({ deliveryAt: value === '' ? '' : new Date(value).toISOString() });
  }

  protected changeCustomer(event: Event): void {
    const value = this.inputValue(event);
    if (value === '__new__') {
      this.addingCustomer.set(true);
      return;
    }
    const customer = value === '' ? null : (this.data.customerById(value) ?? null);
    this.patchOrder({
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? '',
    });
    // A different customer can mean different shorthand, so re-run matching.
    this.rematchAll(true);
  }

  protected async createCustomer(): Promise<void> {
    const name = this.newCustomerName.trim();
    if (name === '') return;
    try {
      const customer: Customer = await this.data.createCustomer(name, {
        phone: this.newCustomerPhone.trim(),
      });
      this.patchOrder({ customerId: customer.id, customerName: customer.name });
      this.addingCustomer.set(false);
      this.newCustomerName = '';
      this.newCustomerPhone = '';
      this.rematchAll(true);
    } catch (cause) {
      this.toast.error(messageOf(cause));
    }
  }

  protected repeatLastOrder(): void {
    const sourceId = this.lastOrderId();
    if (sourceId === null) return;
    const copied = this.orders.duplicateLines(sourceId, this.order().id);
    this.lines.set([...this.lines(), ...copied]);
    this.toast.ok(`Copied ${copied.length} lines from the last order.`);
  }

  /* -------------------------------------------------------------- lines -- */

  protected addPasted(): void {
    const text = this.pasteText();
    if (text.trim() === '') return;
    const added = this.orders.linesFromText(
      text,
      this.order().id,
      this.order().customerId,
      this.lines().length,
    );
    if (added.length === 0) {
      this.toast.warn('Nothing recognisable in that text.');
      return;
    }
    this.lines.set([...this.lines(), ...added]);
    this.pasteText.set('');
    const unsure = added.filter((line) => line.needsReview || line.itemId === null).length;
    this.toast.show(
      unsure === 0
        ? `Added ${added.length} lines — all matched.`
        : `Added ${added.length} lines · ${unsure} need a check.`,
      unsure === 0 ? 'ok' : 'warn',
    );
  }

  protected addItem(item: Item): void {
    this.lines.set([
      ...this.lines(),
      this.orders.lineFromItem(item, this.order().id, this.lines().length),
    ]);
  }

  protected patchLine(line: OrderLine, patch: Partial<OrderLine>): void {
    this.lines.set(
      this.lines().map((entry) => (entry.id === line.id ? { ...entry, ...patch } : entry)),
    );
  }

  protected setQty(line: OrderLine, value: string): void {
    const qty = Number(value);
    this.patchLine(line, { qty: Number.isFinite(qty) && qty > 0 ? qty : 1 });
  }

  protected removeLine(line: OrderLine): void {
    this.lines.set(this.lines().filter((entry) => entry.id !== line.id));
  }

  protected clearLines(): void {
    if (!confirm('Remove every line from this order?')) return;
    this.lines.set([]);
  }

  protected rematchAll(quiet = false): void {
    this.lines.set(this.orders.rematch(this.lines(), this.order().customerId));
    if (!quiet) this.toast.ok('Matching re-run.');
  }

  /* ---------------------------------------------------------- fix / teach -- */

  protected startFix(line: OrderLine): void {
    this.fixing.set(line);
    this.chosen.set(this.itemFor(line));
    // Teaching the store is the point of correcting a line: the same wording
    // will arrive again, and it should already be known when it does. A
    // one-off is the exception, so it is the thing you opt into.
    this.scope = 'global';
    this.fixCandidates.set(this.orders.candidatesFor(line, this.order().customerId));
  }

  protected cancelFix(): void {
    this.fixing.set(null);
    this.chosen.set(null);
  }

  /** The phrase an alias would be saved under. */
  protected aliasPhrase(): string {
    const line = this.fixing();
    if (line === null) return '';
    return line.phrase.trim() !== '' ? line.phrase : line.rawText;
  }

  protected async applyFix(): Promise<void> {
    const line = this.fixing();
    const item = this.chosen();
    if (line === null || item === null) return;

    this.patchLine(line, {
      itemId: item.id,
      needsReview: false,
      matchSource: 'manual',
      matchScore: 1,
    });

    if (this.scope !== 'none') {
      const customerId = this.scope === 'customer' ? this.order().customerId : null;
      try {
        await this.data.saveAlias({
          phrase: this.aliasPhrase(),
          itemId: item.id,
          customerId,
          createdBy: this.auth.displayName(),
        });
        this.toast.ok(
          this.scope === 'customer'
            ? `Remembered: for ${this.customerName()}, “${this.aliasPhrase()}” means ${item.name}.`
            : `Remembered for everyone: “${this.aliasPhrase()}” means ${item.name}.`,
        );
        // Other lines with the same wording benefit immediately.
        this.lines.set(this.orders.rematch(this.lines(), this.order().customerId));
      } catch (cause) {
        this.toast.error(messageOf(cause));
      }
    }

    this.cancelFix();
  }

  /* --------------------------------------------------------------- save -- */

  protected async save(navigate: boolean): Promise<void> {
    if (this.lines().length === 0 && navigate) return;
    this.saving.set(true);
    try {
      const order: Order = {
        ...this.order(),
        customerName:
          this.data.customerById(this.order().customerId)?.name ?? this.order().customerName,
        status: this.order().status === 'draft' && navigate ? 'ready' : this.order().status,
      };
      await this.data.saveOrder(order, this.lines());
      this.order.set(order);
      this.isNew.set(false);

      const usedAliases = this.orders.aliasesUsedBy(this.lines(), order.customerId);
      void this.data.recordAliasHits(usedAliases);

      if (navigate) {
        await this.router.navigate(['/orders', order.id, 'pick']);
      } else {
        this.toast.ok('Order saved.');
      }
    } catch (cause) {
      this.toast.error(messageOf(cause));
    } finally {
      this.saving.set(false);
    }
  }

  protected saveAndPick(): Promise<void> {
    return this.save(true);
  }
}
