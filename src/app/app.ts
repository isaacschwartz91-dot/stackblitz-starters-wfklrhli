/**
 * Application shell.
 *
 * Carries the persistent chrome: who is signed in, the assist-mode banner
 * (FR-A6), the connection state (NFR-11), the language switch (NFR-13), and
 * a sign-out button visible on every screen (FR-A5).
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { AppState, type Screen } from './core/state';
import { I18nService } from './core/i18n';
import { OrderComponent } from './features/order';
import { PlanComponent } from './features/plan';
import { SignInComponent } from './features/sign-in';
import { StaffComponent } from './features/staff';
import { formatCents } from '../shared/units';

@Component({
  selector: 'app-root',
  imports: [SignInComponent, OrderComponent, PlanComponent, StaffComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .topbar {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 9px 20px;
        background: var(--surface);
        border-bottom: 1px solid var(--line);
        flex-wrap: wrap;
        position: sticky;
        top: 0;
        z-index: 30;
      }
      .wordmark {
        font-family: var(--serif);
        font-size: 18px;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      .spacer {
        flex: 1 1 auto;
      }
      .hh {
        display: flex;
        border: 1px solid var(--line);
        border-radius: var(--r);
        background: var(--surface-2);
        overflow: hidden;
      }
      .hh div {
        padding: 4px 11px;
        border-right: 1px solid var(--line);
      }
      .hh div:last-child {
        border-right: 0;
      }
      .hh dt {
        font-size: 9.5px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--ink-3);
        margin: 0;
      }
      .hh dd {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
      }
      nav.tabs {
        display: flex;
        gap: 2px;
        padding: 0 20px;
        background: var(--surface);
        border-bottom: 1px solid var(--line);
        overflow-x: auto;
      }
      nav.tabs button {
        background: none;
        border: 0;
        border-bottom: 2px solid transparent;
        padding: 11px 14px;
        min-height: var(--tap);
        font-size: 13.5px;
        font-weight: 600;
        color: var(--ink-3);
        white-space: nowrap;
      }
      nav.tabs button[aria-current='page'] {
        color: var(--ink);
        border-bottom-color: var(--spruce);
      }
      .seg {
        display: flex;
        border: 1px solid var(--line-2);
        border-radius: var(--r);
        overflow: hidden;
      }
      .seg button {
        background: var(--surface);
        border: 0;
        border-right: 1px solid var(--line-2);
        padding: 0 12px;
        min-height: 36px;
        font-size: 12px;
        font-weight: 600;
        color: var(--ink-2);
      }
      .seg button:last-child {
        border-right: 0;
      }
      .seg button[aria-pressed='true'] {
        background: var(--spruce);
        color: var(--spruce-ink);
      }
      .strip {
        padding: 8px 20px;
        font-size: 13px;
        font-weight: 600;
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      .strip.assist {
        background: var(--spruce-soft);
        color: var(--spruce);
      }
      .strip.offline {
        background: var(--ochre-soft);
        color: var(--ochre);
      }
      .strip.suspended {
        background: var(--clay-soft);
        color: var(--clay);
      }
      .boot {
        display: grid;
        place-items: center;
        min-height: 60vh;
        color: var(--ink-3);
      }
    `,
  ],
  template: `
    @if (state.booting()) {
      <div class="boot">{{ t()('loading') }}</div>
    } @else if (!state.signedIn()) {
      <app-sign-in />
    } @else {
      <header class="topbar no-print">
        <span class="wordmark">{{ t()('appName') }}</span>

        @if (state.household(); as household) {
          <dl class="hh">
            <div>
              <dt>{{ t()('referralId') }}</dt>
              <dd class="num">{{ household.referralId }}</dd>
            </div>
            <div>
              <dt>{{ t()('members') }}</dt>
              <dd class="num">{{ household.memberCount }}</dd>
            </div>
            @if (capLabel(); as cap) {
              <div>
                <dt>{{ t()('budgetCap') }}</dt>
                <dd class="num">{{ cap }}</dd>
              </div>
            }
          </dl>
        }

        <span class="spacer"></span>

        <div class="seg" role="group" [attr.aria-label]="t()('language')">
          <button
            type="button"
            [attr.aria-pressed]="i18n.language() === 'en'"
            (click)="i18n.setLanguage('en')"
          >
            {{ t()('english') }}
          </button>
          <button
            type="button"
            [attr.aria-pressed]="i18n.language() === 'es'"
            (click)="i18n.setLanguage('es')"
          >
            {{ t()('spanish') }}
          </button>
        </div>

        <button class="btn ghost small" type="button" (click)="state.signOut()">
          {{ t()('signOut') }}
        </button>
      </header>

      <!-- FR-A6: assist mode is never invisible -->
      @if (state.assistMode()) {
        <div class="strip assist no-print" role="status">
          <span>
            {{ t()('assisting') }}:
            <b>{{ state.actingAs()?.displayName || state.actingAs()?.email }}</b>
          </span>
          <button class="btn ghost small" type="button" (click)="state.endAssist()">
            {{ t()('endAssist') }}
          </button>
        </div>
      }

      <!-- NFR-11 -->
      @if (!state.online()) {
        <div class="strip offline no-print" role="status">{{ t()('offline') }}</div>
      } @else if (state.hasPendingEdits()) {
        <div class="strip offline no-print" role="status">{{ t()('pendingSync') }}</div>
      }

      <!-- FR-A7 -->
      @if (state.suspended()) {
        <div class="strip suspended no-print" role="status">{{ t()('suspendedNotice') }}</div>
      }

      @if (state.banner(); as message) {
        <div class="strip offline no-print" role="status">
          {{ message }}
          <button class="btn ghost small" type="button" (click)="state.banner.set(null)">
            {{ t()('close') }}
          </button>
        </div>
      }

      <nav class="tabs no-print" [attr.aria-label]="t()('appName')">
        @for (item of visibleTabs(); track item.screen) {
          <button
            type="button"
            [attr.aria-current]="state.screen() === item.screen ? 'page' : null"
            (click)="state.screen.set(item.screen)"
          >
            {{ t()(item.key) }}
          </button>
        }
      </nav>

      @switch (state.screen()) {
        @case ('order') {
          <app-order />
        }
        @case ('plan') {
          <app-plan />
        }
        @case ('accounts') {
          <app-staff />
        }
        @default {
          <app-order />
        }
      }
    }
  `,
})
export class App {
  protected readonly state = inject(AppState);
  protected readonly i18n = inject(I18nService);
  protected readonly t = this.i18n.t;

  protected readonly capLabel = computed(() => {
    const order = this.state.order();
    return order ? formatCents(order.rulesSnapshot.capTotalCents) : null;
  });

  /** Staff see the customer list; customers never do (NFR-5, AC-11). */
  protected readonly visibleTabs = computed(() => {
    const tabs: { screen: Screen; key: 'navOrder' | 'navPlan' | 'navAccounts' }[] = [];
    if (!this.state.isStaff() || this.state.assistMode()) {
      tabs.push({ screen: 'order', key: 'navOrder' });
      tabs.push({ screen: 'plan', key: 'navPlan' });
    }
    if (this.state.isStaff()) {
      tabs.push({ screen: 'accounts', key: 'navAccounts' });
    }
    return tabs;
  });

  constructor() {
    void this.state.boot();
  }
}
