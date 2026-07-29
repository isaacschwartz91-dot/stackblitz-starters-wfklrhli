/**
 * A customer's own order history (FR-A8, FR-35).
 *
 * Scoped by the server to the signed-in account — this screen never asks for
 * an order by a guessed id, and would be refused if it did (NFR-3).
 *
 * Reopening a past order loads it read-only and rebuilds its meal plan view,
 * so a reprint reproduces exactly what was filed.
 */

import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { ApiClient } from '../core/api';
import { AppState } from '../core/state';
import { I18nService } from '../core/i18n';
import { formatCents } from '../../shared/units';
import type { Order } from '../../shared/types';

@Component({
  selector: 'app-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .main {
        padding: 20px;
        max-width: 900px;
      }
    `,
  ],
  template: `
    <div class="main">
      <h1 class="page">{{ t()('myOrders') }}</h1>

      @if (state.errorMessage(); as m) {
        <div class="note bad" role="alert" style="margin-bottom:14px">{{ m }}</div>
      }

      @if (state.history().length === 0) {
        <p class="sec-note">{{ t()('noOrders') }}</p>
      } @else {
        <div class="scroll-x">
          <table class="data">
            <thead>
              <tr>
                <th>{{ t()('finalizedOn') }}</th>
                <th>{{ t()('status') }}</th>
                <th class="r">{{ t()('orderTotal') }}</th>
                <th class="r">{{ t()('budgetCap') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (order of state.history(); track order.id) {
                <tr>
                  <td class="num">
                    {{ (order.finalizedAt ?? order.createdAt).slice(0, 10) }}
                  </td>
                  <td>
                    @if (order.status === 'draft') {
                      <span class="chip muted">{{ t()('draft') }}</span>
                    } @else if (order.override) {
                      <span class="chip over">{{ t()('overriddenLabel') }}</span>
                    } @else {
                      <span class="chip ok">{{ t()('final') }}</span>
                    }
                  </td>
                  <td class="r num">{{ money(order.totalCents) }}</td>
                  <td class="r num">{{ money(order.rulesSnapshot.capTotalCents) }}</td>
                  <td class="r">
                    <button
                      class="btn small neutral"
                      type="button"
                      [disabled]="loading()"
                      (click)="open(order)"
                    >
                      {{ order.status === 'draft' ? t()('view') : t()('reprint') }}
                    </button>
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
export class HistoryComponent {
  protected readonly state = inject(AppState);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(ApiClient);

  protected readonly t = this.i18n.t;
  protected readonly money = formatCents;
  protected readonly loading = signal(false);

  constructor() {
    void this.state.refreshHistory();
  }

  /** FR-35: reload the order and its plan exactly as they were stored. */
  protected async open(order: Order): Promise<void> {
    this.loading.set(true);
    try {
      this.state.order.set(await this.api.order(order.id));
      this.state.plan.set(await this.api.plan(order.id));
      this.state.screen.set(order.status === 'draft' ? 'order' : 'plan');
    } catch (error) {
      this.state.errorMessage.set(
        error instanceof Error ? error.message : 'That order could not be opened.',
      );
    } finally {
      this.loading.set(false);
    }
  }
}
