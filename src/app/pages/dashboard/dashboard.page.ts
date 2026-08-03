import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { DataService } from '../../core/data.service';
import { ORDER_STATUS_LABEL } from '../../core/models';

@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>{{ data.settings().storeName }}</h1>
          <p>Paste an order, and it comes back sorted in shelf walking order.</p>
        </div>
        <span class="spacer"></span>
        <a class="button primary big" routerLink="/orders/new">New order</a>
      </div>

      @if (data.items().length === 0) {
        <div class="notice warn">
          <strong>No catalog yet.</strong> Upload your master item list and shelf walking order to
          get started — or load the demo store to try it straight away.
          <div class="button-row" style="margin-top: 0.6rem">
            <a class="button" routerLink="/catalog">Upload item list</a>
            <a class="button" routerLink="/settings">Load demo store</a>
          </div>
        </div>
      }

      <div class="grid three" style="margin-bottom: 1rem">
        <div class="card stat">
          <span class="value tabular">{{ data.items().length }}</span>
          <span class="label">Products in the catalog</span>
        </div>
        <div class="card stat">
          <span class="value tabular">{{ data.aisles().length }}</span>
          <span class="label">Aisles in the walking order</span>
        </div>
        <div class="card stat">
          <span class="value tabular">{{ data.aliases().length }}</span>
          <span class="label">Shorthand rules learned</span>
        </div>
        <div class="card stat">
          <span class="value tabular">{{ openOrders().length }}</span>
          <span class="label">Orders still to pick</span>
        </div>
      </div>

      @if (problems().length > 0) {
        <div class="notice warn">
          <strong>Worth a look:</strong>
          <ul style="margin: 0.4rem 0 0; padding-left: 1.1rem">
            @for (problem of problems(); track problem) {
              <li>{{ problem }}</li>
            }
          </ul>
        </div>
      }

      <div class="grid two">
        <div class="card">
          <div class="card-head">
            <h2>To pick</h2>
            <span class="spacer"></span>
            <a class="button small" routerLink="/orders">All orders</a>
          </div>

          @if (openOrders().length === 0) {
            <p class="muted small">Nothing waiting. Start a new order when the phone rings.</p>
          } @else {
            @for (order of openOrders().slice(0, 8); track order.id) {
              <div class="pick-row" style="padding-left: 0; padding-right: 0">
                <div class="what">
                  <div class="name">{{ order.customerName || 'Walk-in' }}</div>
                  <div class="small dim">
                    {{ lineCount(order.id) }} lines ·
                    @if (order.deliveryAt) {
                      delivery {{ order.deliveryAt | date: 'EEE d MMM, h:mm a' }}
                    } @else {
                      no delivery time
                    }
                  </div>
                </div>
                <div class="side">
                  <span class="chip">{{ statusLabel(order.status) }}</span>
                  <a class="button small primary" [routerLink]="['/orders', order.id, 'pick']">Pick</a>
                </div>
              </div>
            }
          }
        </div>

        <div class="card">
          <div class="card-head"><h2>Recently finished</h2></div>
          @if (doneOrders().length === 0) {
            <p class="muted small">Completed orders will show up here.</p>
          } @else {
            @for (order of doneOrders().slice(0, 8); track order.id) {
              <div class="pick-row" style="padding-left: 0; padding-right: 0">
                <div class="what">
                  <div class="name">{{ order.customerName || 'Walk-in' }}</div>
                  <div class="small dim">{{ order.updatedAt | date: 'EEE d MMM, h:mm a' }}</div>
                </div>
                <div class="side">
                  <a class="button small" [routerLink]="['/orders', order.id, 'pick']">Open</a>
                </div>
              </div>
            }
          }
        </div>
      </div>
    </div>
  `,
})
export class DashboardPage {
  protected readonly data = inject(DataService);

  protected readonly openOrders = computed(() =>
    this.data
      .orders()
      .filter((order) => order.status !== 'complete')
      .sort((a, b) => (a.deliveryAt || a.createdAt).localeCompare(b.deliveryAt || b.createdAt)),
  );

  protected readonly doneOrders = computed(() =>
    this.data
      .orders()
      .filter((order) => order.status === 'complete')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );

  /** Data problems that would quietly spoil a pick list. */
  protected readonly problems = computed(() => {
    const notes: string[] = [];
    const unmapped = this.data.unmappedAisles();
    if (unmapped.length > 0) {
      notes.push(
        `${unmapped.length} aisle code(s) on products are missing from the walking order: ${unmapped
          .slice(0, 6)
          .join(', ')}${unmapped.length > 6 ? '…' : ''}. They will be picked last.`,
      );
    }
    const unlocated = this.data.itemsWithoutLocation();
    if (unlocated > 0) {
      notes.push(`${unlocated} product(s) have no aisle, so they land in "Location unknown".`);
    }
    if (this.data.items().length > 0 && this.data.aisles().length === 0) {
      notes.push('No walking order uploaded yet — the pick list will sort by aisle number only.');
    }
    return notes;
  });

  protected lineCount(orderId: string): number {
    return this.data.linesFor(orderId).length;
  }

  protected statusLabel(status: keyof typeof ORDER_STATUS_LABEL): string {
    return ORDER_STATUS_LABEL[status];
  }
}
