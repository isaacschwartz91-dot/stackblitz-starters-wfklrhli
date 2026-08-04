import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';

import { DataService, messageOf } from '../../core/data.service';
import { OrderService } from '../../core/order.service';
import { ToastService } from '../../core/toast.service';
import type { Order, OrderStatus } from '../../core/models';
import { ORDER_STATUS_LABEL } from '../../core/models';
import { SelectValue } from '../../ui/select-value';

@Component({
  selector: 'app-orders',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, SelectValue],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Orders</h1>
          <p>Every order is kept. Reopen one to reprint it, or duplicate it as a starting point.</p>
        </div>
        <span class="spacer"></span>
        <a class="button primary" routerLink="/orders/new">New order</a>
      </div>

      <div class="card" style="margin-bottom: 1rem">
        <div class="inline-fields">
          <label class="field" style="margin: 0">
            <span>Search</span>
            <input
              type="search"
              placeholder="Customer name or note…"
              [value]="query()"
              (input)="query.set(value($event))"
            />
          </label>
          <label class="field" style="margin: 0">
            <span>Status</span>
            <select [selectValue]="status()" (change)="status.set(value($event))">
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="ready">Ready to pick</option>
              <option value="picking">Picking</option>
              <option value="complete">Complete</option>
            </select>
          </label>
          <label class="field" style="margin: 0">
            <span>From</span>
            <input type="date" [value]="from()" (change)="from.set(value($event))" />
          </label>
          <label class="field" style="margin: 0">
            <span>To</span>
            <input type="date" [value]="to()" (change)="to.set(value($event))" />
          </label>
        </div>
      </div>

      @if (filtered().length === 0) {
        <div class="card empty">
          <h3>No orders match</h3>
          <p class="muted">Try clearing the filters, or start a new order.</p>
        </div>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Delivery</th>
                <th class="num">Lines</th>
                <th>Status</th>
                <th>Created</th>
                <th style="width: 15rem"></th>
              </tr>
            </thead>
            <tbody>
              @for (order of filtered(); track order.id) {
                <tr>
                  <td>
                    <div class="name">{{ order.customerName || 'Walk-in' }}</div>
                    @if (order.notes) {
                      <div class="small dim">{{ order.notes }}</div>
                    }
                  </td>
                  <td class="small">
                    {{ order.deliveryAt ? (order.deliveryAt | date: 'd MMM, h:mm a') : '—' }}
                  </td>
                  <td class="num tabular">{{ lineCount(order.id) }}</td>
                  <td>
                    <span class="chip" [class.ok]="order.status === 'complete'">
                      {{ label(order.status) }}
                    </span>
                  </td>
                  <td class="small dim">{{ order.createdAt | date: 'd MMM y' }}</td>
                  <td>
                    <div class="button-row" style="gap: 0.25rem; justify-content: flex-end">
                      <a class="button small primary" [routerLink]="['/orders', order.id, 'pick']">
                        Pick list
                      </a>
                      <a class="button small" [routerLink]="['/orders', order.id, 'edit']">Edit</a>
                      <button type="button" class="small" (click)="duplicate(order)">Copy</button>
                      <button type="button" class="small danger" (click)="remove(order)">✕</button>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
})
export class OrdersPage {
  protected readonly data = inject(DataService);
  private readonly orders = inject(OrderService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly query = signal('');
  protected readonly status = signal('');
  protected readonly from = signal('');
  protected readonly to = signal('');

  protected readonly filtered = computed(() => {
    const text = this.query().trim().toLowerCase();
    const status = this.status();
    const from = this.from();
    const to = this.to();

    return this.data
      .orders()
      .filter((order) => {
        if (status !== '' && order.status !== status) return false;
        if (text !== '') {
          const haystack = `${order.customerName} ${order.notes}`.toLowerCase();
          if (!haystack.includes(text)) return false;
        }
        // Filter on the delivery day when there is one, otherwise the order date.
        const day = (order.deliveryAt || order.createdAt).slice(0, 10);
        if (from !== '' && day < from) return false;
        if (to !== '' && day > to) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected label(status: OrderStatus): string {
    return ORDER_STATUS_LABEL[status];
  }

  protected lineCount(orderId: string): number {
    return this.data.linesFor(orderId).length;
  }

  protected async duplicate(order: Order): Promise<void> {
    try {
      const copy = this.orders.newOrder(order.customerId, order.customerName, order.createdBy);
      const lines = this.orders.duplicateLines(order.id, copy.id);
      await this.data.saveOrder({ ...copy, notes: order.notes }, lines);
      await this.router.navigate(['/orders', copy.id, 'edit']);
    } catch (cause) {
      this.toast.error(messageOf(cause));
    }
  }

  protected async remove(order: Order): Promise<void> {
    if (!confirm(`Delete the order for ${order.customerName || 'Walk-in'}? This cannot be undone.`)) {
      return;
    }
    try {
      await this.data.deleteOrder(order.id);
      this.toast.ok('Order deleted.');
    } catch (cause) {
      this.toast.error(messageOf(cause));
    }
  }
}
