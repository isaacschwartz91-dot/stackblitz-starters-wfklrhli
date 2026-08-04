/**
 * The pick list — the thing this software exists to produce.
 *
 * One walk from the front of the store to the back: aisles in walking order,
 * items in shelf order within each aisle, big checkboxes, and everything the
 * software could not resolve pulled out into its own section so it can never
 * be silently skipped.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { DataService, messageOf } from '../../core/data.service';
import { OrderService } from '../../core/order.service';
import { ToastService } from '../../core/toast.service';
import type { Item, Order, OrderLine } from '../../core/models';
import { ORDER_STATUS_LABEL, itemDetail } from '../../core/models';
import { buildPickList, UNKNOWN_AISLE_ID, type PickEntry } from '../../matching/pick-list';
import { ItemPicker } from '../../ui/item-picker';

@Component({
  selector: 'app-pick-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, DecimalPipe, ItemPicker],
  template: `
    @if (order() === null) {
      <div class="page">
        <div class="empty">
          <h3>Order not found</h3>
          <p class="muted">It may have been deleted.</p>
          <a class="button" routerLink="/orders">Back to orders</a>
        </div>
      </div>
    } @else {
      <div class="page">
        <div class="page-head no-print">
          <div>
            <h1>Pick list</h1>
            <p>
              {{ order()!.customerName || 'Walk-in' }}
              @if (order()!.deliveryAt) {
                · delivery {{ order()!.deliveryAt | date: 'EEE d MMM, h:mm a' }}
              }
            </p>
          </div>
          <span class="spacer"></span>
          <div class="button-row">
            <a class="button" [routerLink]="['/orders', order()!.id, 'edit']">Edit order</a>
            <button type="button" (click)="duplicate()">Duplicate</button>
            <button type="button" (click)="copyText()">Copy as text</button>
            <button type="button" (click)="email()">Email</button>
            <button type="button" class="primary" (click)="print()">Print</button>
          </div>
        </div>

        <!-- Print header: everything the paper copy needs. -->
        <div class="print-only" style="margin-bottom: 0.8rem">
          <h1 style="margin-bottom: 0.2rem">{{ data.settings().storeName }} — pick list</h1>
          <div>
            <strong>{{ order()!.customerName || 'Walk-in' }}</strong>
            @if (customerPhone()) {
              · {{ customerPhone() }}
            }
          </div>
          @if (order()!.deliveryAt) {
            <div>Delivery: {{ order()!.deliveryAt | date: 'EEE d MMM y, h:mm a' }}</div>
          }
          @if (customerAddress()) {
            <div>{{ customerAddress() }}</div>
          }
          @if (order()!.notes) {
            <div>Notes: {{ order()!.notes }}</div>
          }
          <div class="small">
            {{ pickList().totalItems }} items · printed {{ now | date: 'd MMM y, h:mm a' }}
          </div>
        </div>

        <div class="card no-print" style="margin-bottom: 1rem">
          <div class="card-head">
            <strong class="tabular">{{ pickList().pickedItems }}/{{ pickList().totalItems }}</strong>
            <span class="muted small">picked</span>
            <span class="spacer"></span>
            <span class="chip">{{ statusLabel() }}</span>
            @if (pickList().estimatedTotal > 0) {
              <span class="chip accent">
                Est. {{ data.settings().currencySymbol
                }}{{ pickList().estimatedTotal | number: '1.2-2' }}
              </span>
            }
          </div>
          <div class="progress" [attr.aria-label]="'Picking progress'">
            <div [style.width.%]="progressPercent()"></div>
          </div>
        </div>

        @if (pickList().needsAttention.length > 0) {
          <div class="card" style="border-color: var(--warn); margin-bottom: 1rem">
            <div class="card-head">
              <h2 style="color: var(--warn)">
                Needs attention — {{ pickList().needsAttention.length }}
              </h2>
              <span class="spacer"></span>
              <a class="button small no-print" [routerLink]="['/orders', order()!.id, 'edit']">
                Fix these
              </a>
            </div>
            @for (entry of pickList().needsAttention; track entry.line.id) {
              <div class="pick-row">
                <div class="qty tabular">{{ entry.line.qty }}{{ entry.line.unit ? ' ' + entry.line.unit : '' }}</div>
                <div class="what">
                  <div class="name">{{ entry.line.rawText }}</div>
                  <div class="small dim">
                    @if (entry.item === null) {
                      No product matched — choose one, or pick it by hand.
                    } @else {
                      Best guess: {{ entry.item.name }} — please confirm.
                    }
                    @if (entry.line.note) {
                      · note: {{ entry.line.note }}
                    }
                  </div>
                </div>
              </div>
            }
          </div>
        }

        @if (pickList().groups.length === 0) {
          <div class="card empty">
            <h3>Nothing to pick yet</h3>
            <p class="muted">Add some lines to this order first.</p>
            <a class="button" [routerLink]="['/orders', order()!.id, 'edit']">Edit order</a>
          </div>
        }

        @for (group of pickList().groups; track group.aisleId; let index = $index) {
          <section class="pick-aisle" [class.unknown]="group.aisleId === unknownAisle">
            <header>
              <span class="step" aria-hidden="true">{{ index + 1 }}</span>
              <span>{{ group.aisleName }}</span>
              <span class="spacer"></span>
              <span class="small" style="font-weight: 500">
                {{ group.entries.length }} {{ group.entries.length === 1 ? 'item' : 'items' }}
              </span>
            </header>

            @for (entry of group.entries; track entry.line.id) {
              <div class="pick-row" [class.done]="entry.line.picked">
                <input
                  type="checkbox"
                  [checked]="entry.line.picked"
                  (change)="togglePicked(entry.line)"
                  [attr.aria-label]="'Picked ' + (entry.item?.name ?? '')"
                />
                <div class="qty tabular">
                  {{ entry.line.qty }}{{ entry.line.unit ? ' ' + entry.line.unit : '' }}
                </div>
                <div class="what">
                  <div class="name">{{ displayItem(entry)?.name }}</div>
                  <div class="small dim">
                    @if (entry.substitute !== null) {
                      <span class="chip warn">substituted for {{ entry.item?.name }}</span>
                    }
                    {{ subtitle(entry) }}
                  </div>
                </div>
                <div class="side no-print">
                  <button type="button" class="small ghost" (click)="startSubstitute(entry.line)">
                    {{ entry.line.outOfStock ? 'Change sub' : 'Out of stock' }}
                  </button>
                </div>
              </div>
            }
          </section>
        }

        <div class="sticky-actions no-print">
          <button type="button" class="primary big" (click)="complete()" [disabled]="busy()">
            {{ order()!.status === 'complete' ? 'Reopen order' : 'Mark picked & done' }}
          </button>
          <button type="button" (click)="markAll(true)">Tick all</button>
          <button type="button" class="ghost" (click)="markAll(false)">Clear ticks</button>
          <span class="spacer"></span>
          <a class="button ghost" routerLink="/orders">All orders</a>
        </div>
      </div>
    }

    @if (substituting(); as line) {
      <div class="modal-backdrop" (click)="substituting.set(null)">
        <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
          <h2>Out of stock</h2>
          <p class="muted small">
            {{ itemName(line.itemId) }} — choose a substitute, or mark it out of stock with nothing
            in its place.
          </p>
          <app-item-picker placeholder="Search for a substitute…" (picked)="applySubstitute(line, $event)" />
          <div class="button-row" style="margin-top: 1rem">
            <button type="button" (click)="applySubstitute(line, null)">
              Out of stock, no substitute
            </button>
            @if (line.outOfStock) {
              <button type="button" class="ghost" (click)="clearSubstitute(line)">
                Back in stock
              </button>
            }
            <button type="button" class="ghost" (click)="substituting.set(null)">Cancel</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class PickListPage {
  protected readonly data = inject(DataService);
  private readonly orders = inject(OrderService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly unknownAisle = UNKNOWN_AISLE_ID;
  protected readonly now = new Date();

  private readonly orderId = signal(this.route.snapshot.paramMap.get('id') ?? '');
  protected readonly busy = signal(false);
  protected readonly substituting = signal<OrderLine | null>(null);

  protected readonly order = computed<Order | null>(() => this.data.orderById(this.orderId()));

  protected readonly lines = computed(() => this.data.linesFor(this.orderId()));

  protected readonly pickList = computed(() =>
    buildPickList({
      lines: this.lines(),
      items: this.data.itemsById(),
      aisles: this.data.aisles(),
    }),
  );

  protected readonly progressPercent = computed(() => {
    const list = this.pickList();
    if (list.totalItems === 0) return 0;
    return Math.round((list.pickedItems / list.totalItems) * 100);
  });

  protected statusLabel(): string {
    const order = this.order();
    return order === null ? '' : ORDER_STATUS_LABEL[order.status];
  }

  protected customerPhone(): string {
    return this.data.customerById(this.order()?.customerId ?? null)?.phone ?? '';
  }

  protected customerAddress(): string {
    return this.data.customerById(this.order()?.customerId ?? null)?.address ?? '';
  }

  protected displayItem(entry: PickEntry): Item | null {
    return entry.substitute ?? entry.item;
  }

  protected detail(item: Item | null): string {
    return item === null ? '' : itemDetail(item);
  }

  /**
   * The grey line under a product: its brand and size, the customer's note,
   * and their own wording when it differs from the product name. Built here so
   * the separators never dangle when a part is missing.
   */
  protected subtitle(entry: PickEntry): string {
    const item = this.displayItem(entry);
    const parts: string[] = [];
    const detail = this.detail(item);
    if (detail !== '') parts.push(detail);
    if (entry.line.note !== '') parts.push(`note: ${entry.line.note}`);
    if (entry.line.rawText !== '' && entry.line.rawText !== item?.name) {
      parts.push(`they said \u201C${entry.line.rawText}\u201D`);
    }
    return parts.join(' · ');
  }

  protected itemName(itemId: string | null): string {
    if (itemId === null) return 'This line';
    return this.data.itemsById().get(itemId)?.name ?? 'This line';
  }

  protected print(): void {
    // Printing to PDF is the browser's own "Save as PDF" destination.
    window.print();
  }

  /** The pick list as plain text, in walking order — for email or a message. */
  protected asText(): string {
    const order = this.order();
    const list = this.pickList();
    const lines: string[] = [
      `${this.data.settings().storeName} — pick list`,
      `Customer: ${order?.customerName || 'Walk-in'}`,
    ];
    if (order?.deliveryAt) lines.push(`Delivery: ${new Date(order.deliveryAt).toLocaleString()}`);
    if (order?.notes) lines.push(`Notes: ${order.notes}`);
    lines.push('');

    for (const group of list.groups) {
      lines.push(`-- ${group.aisleName} --`);
      for (const entry of group.entries) {
        const item = this.displayItem(entry);
        const unit = entry.line.unit === '' ? '' : ` ${entry.line.unit}`;
        const detail = this.detail(item);
        lines.push(
          `[ ] ${entry.line.qty}${unit}  ${item?.name ?? ''}${detail === '' ? '' : ` (${detail})`}`,
        );
      }
      lines.push('');
    }

    if (list.needsAttention.length > 0) {
      lines.push('-- Needs attention --');
      for (const entry of list.needsAttention) {
        lines.push(`[?] ${entry.line.qty} ${entry.line.rawText}`);
      }
    }
    return lines.join('\n');
  }

  protected async copyText(): Promise<void> {
    const text = this.asText();
    try {
      await navigator.clipboard.writeText(text);
      this.toast.ok('Pick list copied.');
    } catch {
      // Clipboard access can be blocked; fall back to a download.
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'pick-list.txt';
      link.click();
      URL.revokeObjectURL(url);
      this.toast.show('Downloaded the pick list as a text file.');
    }
  }

  protected email(): void {
    const order = this.order();
    const to = this.data.customerById(order?.customerId ?? null)?.email ?? '';
    const subject = `${this.data.settings().storeName} — order for ${order?.customerName || 'Walk-in'}`;
    const body = this.asText();
    const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(
      subject,
    )}&body=${encodeURIComponent(body)}`;
    // Long lists overflow what a mailto URL can carry, so say so rather than
    // opening a silently truncated draft.
    if (href.length > 1900) {
      this.toast.warn('Too long to email directly — use "Copy as text" and paste it in.');
      return;
    }
    window.location.href = href;
  }

  /* ------------------------------------------------------------ mutation -- */

  private async persist(lines: OrderLine[]): Promise<void> {
    const order = this.order();
    if (order === null) return;
    try {
      await this.data.saveOrder(order, lines);
    } catch (cause) {
      this.toast.error(messageOf(cause));
    }
  }

  protected async togglePicked(line: OrderLine): Promise<void> {
    const updated = this.lines().map((entry) =>
      entry.id === line.id ? { ...entry, picked: !entry.picked } : entry,
    );
    // Ticking the first box means picking has started.
    const order = this.order();
    if (order !== null && order.status === 'ready' && updated.some((entry) => entry.picked)) {
      await this.data.saveOrder({ ...order, status: 'picking' }, updated);
      return;
    }
    await this.persist(updated);
  }

  protected async markAll(picked: boolean): Promise<void> {
    await this.persist(this.lines().map((line) => ({ ...line, picked })));
  }

  protected startSubstitute(line: OrderLine): void {
    this.substituting.set(line);
  }

  protected async applySubstitute(line: OrderLine, item: Item | null): Promise<void> {
    await this.persist(
      this.lines().map((entry) =>
        entry.id === line.id
          ? { ...entry, outOfStock: true, substituteItemId: item?.id ?? null }
          : entry,
      ),
    );
    this.substituting.set(null);
    this.toast.warn(
      item === null
        ? `Marked out of stock: ${this.itemName(line.itemId)}.`
        : `Substituting ${item.name} for ${this.itemName(line.itemId)}.`,
    );
  }

  protected async clearSubstitute(line: OrderLine): Promise<void> {
    await this.persist(
      this.lines().map((entry) =>
        entry.id === line.id ? { ...entry, outOfStock: false, substituteItemId: null } : entry,
      ),
    );
    this.substituting.set(null);
  }

  protected async complete(): Promise<void> {
    const order = this.order();
    if (order === null) return;
    this.busy.set(true);
    try {
      const next = order.status === 'complete' ? 'picking' : 'complete';
      await this.data.setOrderStatus(order.id, next);
      this.toast.ok(next === 'complete' ? 'Order marked complete.' : 'Order reopened.');
    } catch (cause) {
      this.toast.error(messageOf(cause));
    } finally {
      this.busy.set(false);
    }
  }

  protected async duplicate(): Promise<void> {
    const order = this.order();
    if (order === null) return;
    try {
      const copy = this.orders.newOrder(order.customerId, order.customerName, order.createdBy);
      const lines = this.orders.duplicateLines(order.id, copy.id);
      await this.data.saveOrder({ ...copy, notes: order.notes }, lines);
      this.toast.ok('Duplicated. Edit the copy before picking.');
      await this.router.navigate(['/orders', copy.id, 'edit']);
    } catch (cause) {
      this.toast.error(messageOf(cause));
    }
  }
}
