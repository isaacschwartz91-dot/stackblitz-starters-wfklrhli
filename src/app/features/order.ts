/**
 * Order builder (FR-12 .. FR-19, FR-23).
 *
 * Catalogue on the left, a compliance rail on the right that never scrolls
 * away — pinned as a collapsible bottom sheet on a phone, as FR-14 requires.
 * Every number recomputes from the shared engine on each tap (NFR-12).
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ApiClient } from '../core/api';
import { AppState } from '../core/state';
import { I18nService } from '../core/i18n';
import { formatCents, formatUnits } from '../../shared/units';
import type { DietaryTag, Item } from '../../shared/types';
import type { CategoryStatus, Suggestion } from '../../shared/compliance/engine';

@Component({
  selector: 'app-order',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .wrap {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 360px;
        align-items: start;
      }
      .main {
        padding: 20px;
        min-width: 0;
      }
      .rail {
        position: sticky;
        top: 0;
        border-left: 1px solid var(--line);
        background: var(--surface);
        padding: 16px;
        max-height: 100vh;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .rail-handle {
        display: none;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        background: none;
        border: 0;
        padding: 4px 0;
        min-height: var(--tap);
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.07em;
      }
      @media (max-width: 900px) {
        .wrap {
          grid-template-columns: 1fr;
        }
        .rail {
          position: fixed;
          inset: auto 0 0 0;
          top: auto;
          max-height: 56vh;
          border-left: 0;
          border-top: 2px solid var(--spruce);
          z-index: 25;
          box-shadow: 0 -8px 24px rgb(0 0 0 / 13%);
        }
        .rail[data-collapsed='true'] > *:not(.rail-handle) {
          display: none;
        }
        .rail-handle {
          display: flex;
        }
        .main {
          padding-bottom: 220px;
        }
      }

      .toolbar {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .toolbar .input {
        flex: 1 1 220px;
      }
      .filters {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin-bottom: 14px;
      }
      .filters button {
        background: var(--surface);
        border: 1px solid var(--line-2);
        border-radius: 999px;
        padding: 0 14px;
        min-height: 38px;
        font-size: 13px;
        font-weight: 600;
        color: var(--ink-2);
      }
      .filters button[aria-pressed='true'] {
        background: var(--ink);
        color: var(--paper);
        border-color: var(--ink);
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
        gap: 10px;
      }
      .tile {
        border: 1px solid var(--line);
        border-radius: var(--r);
        background: var(--surface);
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .tile.in-cart {
        border-color: var(--spruce);
        box-shadow: inset 3px 0 0 var(--spruce);
      }
      .tile.conflict {
        border-color: var(--ochre);
      }
      .tile-name {
        font-size: 13.5px;
        font-weight: 600;
        line-height: 1.3;
      }
      .tile-sub {
        font-size: 11.5px;
        color: var(--ink-3);
      }
      .tile-stats {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 8px;
        margin-top: auto;
      }
      .price {
        font-size: 15px;
        font-weight: 700;
      }
      .per {
        font-size: 11.5px;
        color: var(--ink-3);
      }
      .tag {
        font-size: 10px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        border: 1px solid var(--line-2);
        border-radius: 2px;
        padding: 1px 5px;
        color: var(--ink-3);
      }
      .tag.cold {
        border-color: var(--spruce);
        color: var(--spruce);
      }
      .tagrow {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
      }

      .qty {
        display: flex;
        border: 1px solid var(--line-2);
        border-radius: var(--r);
        overflow: hidden;
      }
      .qty button {
        background: var(--surface-2);
        border: 0;
        width: var(--tap);
        min-height: var(--tap);
        font-size: 18px;
        font-weight: 700;
      }
      .qty input {
        flex: 1;
        min-width: 44px;
        width: 100%;
        border: 0;
        border-radius: 0;
        appearance: textfield;
        text-align: center;
        font-family: var(--mono);
        font-size: 15px;
        font-weight: 700;
        background: var(--surface);
      }
      .qty input::-webkit-inner-spin-button,
      .qty input::-webkit-outer-spin-button {
        appearance: none;
        margin: 0;
      }
      .qty input:focus-visible {
        outline-offset: -2px;
      }

      .meter {
        border-top: 1px solid var(--line);
        padding: 10px 0 11px;
      }
      .meter:first-of-type {
        border-top: 0;
      }
      .meter-top {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 8px;
      }
      .meter-name {
        font-size: 13.5px;
        font-weight: 600;
      }
      .meter-val {
        font-size: 12.5px;
        color: var(--ink-2);
      }
      .meter-val b {
        color: var(--ink);
      }

      .budget {
        border: 1px solid var(--line);
        border-radius: var(--r);
        padding: 12px;
        background: var(--surface-2);
      }
      .budget-row {
        display: flex;
        justify-content: space-between;
        font-size: 13px;
        padding: 2px 0;
      }
      .budget-row.total {
        font-size: 15px;
        font-weight: 700;
        border-top: 1px solid var(--line-2);
        margin-top: 6px;
        padding-top: 7px;
      }

      .verdict {
        border-radius: var(--r);
        padding: 11px 13px;
        font-size: 13.5px;
        font-weight: 600;
        display: flex;
        gap: 9px;
        align-items: flex-start;
      }
      .verdict.ok {
        background: var(--spruce-soft);
        color: var(--spruce);
      }
      .verdict.no {
        background: var(--ochre-soft);
        color: var(--ochre);
      }
      .verdict .mark {
        font-family: var(--mono);
        font-size: 15px;
      }

      .sug {
        border: 1px solid var(--ochre);
        border-radius: var(--r);
        overflow: hidden;
      }
      .sug.cap {
        border-color: var(--clay);
      }
      .sug-head {
        background: var(--ochre-soft);
        color: var(--ochre);
        padding: 8px 11px;
        font-size: 11.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .sug.cap .sug-head {
        background: var(--clay-soft);
        color: var(--clay);
      }
      .sug-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 9px 11px;
        border-top: 1px solid var(--line);
      }
      .sug-item:first-of-type {
        border-top: 0;
      }
      .sug-body {
        flex: 1;
        min-width: 0;
      }
      .sug-name {
        font-size: 13px;
        font-weight: 600;
      }
      .sug-meta {
        font-size: 11.5px;
        color: var(--ink-3);
      }
      .contrib {
        font-size: 12px;
        color: var(--ink-2);
        margin: 6px 0 0;
        padding-left: 16px;
      }

      /* Customer-first order journey -------------------------------------- */
      .main {
        padding: 32px clamp(20px, 4vw, 52px) 48px;
      }
      .pre-order {
        max-width: 780px;
      }
      .order-intro,
      .pre-order-hero {
        border: 1px solid var(--line);
        border-radius: 18px;
        background:
          radial-gradient(circle at 100% 0, var(--spruce-soft) 0, transparent 42%),
          var(--surface);
        padding: clamp(20px, 4vw, 34px);
        margin-bottom: 26px;
      }
      .pre-order-hero {
        margin-top: 28px;
      }
      .eyebrow {
        display: block;
        color: var(--spruce);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        margin-bottom: 8px;
      }
      .order-title {
        font-family: var(--serif);
        font-size: clamp(28px, 3vw, 38px);
        line-height: 1.08;
        letter-spacing: -0.025em;
        margin: 0;
        max-width: 18ch;
      }
      .order-lede {
        color: var(--ink-2);
        font-size: 16px;
        line-height: 1.55;
        margin: 12px 0 0;
        max-width: 60ch;
      }
      .journey {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
        list-style: none;
        margin: 24px 0 0;
        padding: 0;
      }
      .journey-step {
        border: 1px solid var(--line);
        border-radius: 12px;
        background: color-mix(in srgb, var(--surface) 88%, var(--paper));
        color: var(--ink-3);
        display: flex;
        align-items: center;
        gap: 9px;
        min-height: 56px;
        padding: 9px 10px;
        font-size: 12px;
        font-weight: 700;
      }
      .journey-step.active {
        border-color: var(--spruce);
        background: var(--spruce-soft);
        color: var(--spruce);
      }
      .journey-step.done {
        color: var(--ink-2);
      }
      .step-number {
        display: grid;
        place-items: center;
        flex: 0 0 24px;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: var(--surface-2);
        font-family: var(--mono);
        font-size: 11px;
      }
      .journey-step.active .step-number {
        background: var(--spruce);
        color: var(--spruce-ink);
      }
      .journey-state {
        display: block;
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        margin-top: 1px;
      }
      .order-glance {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px 22px;
        margin-top: 22px;
        padding-top: 18px;
        border-top: 1px solid var(--line);
      }
      .glance-metric {
        display: flex;
        align-items: baseline;
        gap: 6px;
        color: var(--ink-2);
        font-size: 12px;
      }
      .glance-metric b {
        color: var(--ink);
        font-family: var(--mono);
        font-size: 18px;
      }
      .quick-start {
        border: 1px solid color-mix(in srgb, var(--spruce) 38%, var(--line));
        border-radius: 16px;
        background: var(--spruce-soft);
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 18px;
        align-items: center;
        padding: 18px;
        margin-bottom: 28px;
      }
      .quick-start h2,
      .catalogue-heading h2 {
        font-family: var(--serif);
        font-size: 20px;
        margin: 0;
      }
      .quick-start p {
        color: var(--ink-2);
        font-size: 13px;
        margin: 5px 0 0;
        max-width: 62ch;
      }
      .quick-start-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        flex-wrap: wrap;
      }
      .catalogue-heading {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 18px;
        margin-bottom: 14px;
      }
      .catalogue-heading .sec-note {
        margin: 4px 0 0;
      }
      .toolbar {
        margin-bottom: 16px;
      }
      .toolbar .input {
        border-radius: 12px;
        min-height: 48px;
      }
      .filters {
        margin-bottom: 20px;
      }
      .filters button {
        min-height: 40px;
      }
      .grid {
        gap: 14px;
      }
      .tile {
        border-radius: 14px;
        padding: 15px;
        box-shadow: 0 2px 6px rgb(20 32 28 / 4%);
        transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
      }
      .tile:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 20px rgb(20 32 28 / 8%);
      }
      .tile-name {
        font-size: 14.5px;
      }
      .tag.recommended {
        border-color: var(--spruce);
        background: var(--spruce-soft);
        color: var(--spruce);
        font-weight: 800;
      }
      .qty {
        border-radius: 10px;
      }
      .qty button:hover:not(:disabled) {
        background: var(--spruce-soft);
        color: var(--spruce);
      }
      .cart-section {
        border-top: 1px solid var(--line);
        margin-top: 34px;
        padding-top: 26px;
      }
      .cart-section .sec-note {
        margin-bottom: 0;
      }
      .rail {
        background: color-mix(in srgb, var(--surface) 94%, var(--spruce-soft));
        border-left: 1px solid var(--line);
        gap: 18px;
        padding: 24px;
      }
      .rail-summary {
        border-bottom: 1px solid var(--line);
        padding-bottom: 16px;
      }
      .rail-summary .eyebrow {
        margin-bottom: 5px;
      }
      .rail-progress {
        display: flex;
        align-items: baseline;
        gap: 8px;
      }
      .rail-progress b {
        font-family: var(--mono);
        font-size: 28px;
        letter-spacing: -0.05em;
      }
      .rail-progress span {
        color: var(--ink-2);
        font-size: 12px;
        font-weight: 700;
      }
      .verdict {
        border: 1px solid transparent;
        border-radius: 12px;
      }
      .verdict.ok {
        border-color: color-mix(in srgb, var(--spruce) 28%, var(--line));
      }
      .verdict.no {
        border-color: color-mix(in srgb, var(--ochre) 28%, var(--line));
      }
      .budget {
        border-radius: 12px;
      }
      .sug {
        border-radius: 12px;
      }
      .rail-handle-summary {
        color: var(--ink-2);
        font-family: var(--mono);
        font-size: 11px;
        font-weight: 700;
      }
      @media (max-width: 900px) {
        .main {
          padding: 22px 18px 132px;
        }
        .order-intro,
        .pre-order-hero {
          border-radius: 14px;
          padding: 20px;
          margin-bottom: 20px;
        }
        .journey {
          grid-template-columns: 1fr;
          gap: 7px;
        }
        .journey-step {
          min-height: 48px;
        }
        .quick-start {
          grid-template-columns: 1fr;
          gap: 14px;
        }
        .quick-start-actions {
          justify-content: stretch;
        }
        .quick-start-actions .btn {
          flex: 1 1 190px;
        }
        .catalogue-heading {
          align-items: flex-start;
          flex-direction: column;
          gap: 4px;
        }
        .rail {
          border-top-color: var(--spruce);
          padding: 12px 18px 20px;
        }
        .rail-handle {
          gap: 12px;
          text-transform: none;
          letter-spacing: 0;
          font-size: 14px;
        }
      }
      @media (max-width: 600px) {
        .main {
          padding: 16px 14px 96px;
        }
        .order-intro,
        .pre-order-hero {
          padding: 18px;
        }
        .order-title {
          font-size: 30px;
        }
        .toolbar {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 8px;
        }
        .toolbar .input {
          min-width: 0;
        }
        .toolbar .btn {
          padding: 0 12px;
        }
        .filters {
          flex-wrap: nowrap;
          overflow-x: auto;
          padding-bottom: 4px;
          scrollbar-width: thin;
        }
        .filters button {
          flex: 0 0 auto;
        }
        .grid {
          grid-template-columns: 1fr;
          gap: 10px;
        }
        .tile {
          gap: 9px;
          padding: 14px;
        }
        .tile:hover {
          transform: none;
        }
        .tile-name {
          font-size: 16px;
        }
        .qty button {
          width: 52px;
        }
        .qty input {
          font-size: 16px;
        }
        .cart-section {
          margin-top: 26px;
          padding-top: 20px;
        }
        .rail {
          max-height: min(72dvh, 620px);
          padding: 10px 14px 16px;
        }
      }
    `,
  ],
  template: `
    <a class="skip-link" href="#compliance-panel">{{ t()('skipToPanel') }}</a>

    @if (!state.order()) {
      <div class="main pre-order">
        <section class="pre-order-hero" aria-labelledby="order-welcome-title">
          <span class="eyebrow">{{ t()('orderJourney') }}</span>
          <h1 class="order-title" id="order-welcome-title">{{ t()('orderWelcome') }}</h1>
          <p class="order-lede">{{ t()('orderWelcomeBody') }}</p>

          <ol class="journey" [attr.aria-label]="t()('orderJourney')">
            <li class="journey-step active">
              <span class="step-number">1</span>
              <span>
                {{ t()('chooseFoodStep') }}
                <small class="journey-state">{{ t()('currentStep') }}</small>
              </span>
            </li>
            <li class="journey-step">
              <span class="step-number">2</span>
              <span>{{ t()('checkNeedsStep') }}</span>
            </li>
            <li class="journey-step">
              <span class="step-number">3</span>
              <span>{{ t()('finishOrderStep') }}</span>
            </li>
          </ol>

          @if (!state.household()) {
            <p class="sec-note" style="margin-top:22px">{{ t()('noHousehold') }}</p>
          } @else if (state.suspended()) {
            <div class="note warn" style="margin-top:22px">{{ t()('suspendedNotice') }}</div>
          } @else {
            <p class="sec-note" style="margin:22px 0 12px">{{ t()('buildOrderHint') }}</p>
            <button class="btn" type="button" (click)="state.startOrder()" [disabled]="state.busy()">
              {{ t()('startOrder') }}
            </button>
          }
        </section>
      </div>
    } @else {
      <div class="wrap">
        <main class="main">
          <section class="order-intro" aria-labelledby="order-title">
            <span class="eyebrow">{{ t()('orderJourney') }}</span>
            <h1 class="order-title" id="order-title">{{ t()('buildOrder') }}</h1>
            <p class="order-lede">{{ t()('orderWelcomeBody') }}</p>

            <ol class="journey" [attr.aria-label]="t()('orderJourney')">
              <li
                class="journey-step"
                [class.active]="orderStage() === 'choose'"
                [class.done]="orderStage() !== 'choose'"
              >
                <span class="step-number">{{ orderStage() === 'choose' ? '1' : '✓' }}</span>
                <span>
                  {{ t()('chooseFoodStep') }}
                  @if (orderStage() === 'choose') {
                    <small class="journey-state">{{ t()('currentStep') }}</small>
                  }
                </span>
              </li>
              <li
                class="journey-step"
                [class.active]="orderStage() === 'check'"
                [class.done]="orderStage() === 'finish'"
              >
                <span class="step-number">{{ orderStage() === 'finish' ? '✓' : '2' }}</span>
                <span>
                  {{ t()('checkNeedsStep') }}
                  @if (orderStage() === 'check') {
                    <small class="journey-state">{{ t()('currentStep') }}</small>
                  }
                </span>
              </li>
              <li class="journey-step" [class.active]="orderStage() === 'finish'">
                <span class="step-number">3</span>
                <span>
                  {{ t()('finishOrderStep') }}
                  @if (orderStage() === 'finish') {
                    <small class="journey-state">{{ t()('currentStep') }}</small>
                  }
                </span>
              </li>
            </ol>

            @if (state.compliance(); as result) {
              <div class="order-glance" aria-live="polite">
                <span class="glance-metric">
                  <b>{{ itemCount() }}</b> {{ t()('itemsInOrder') }}
                </span>
                <span class="glance-metric">
                  <b>{{ packageCount() }}</b> {{ t()('packagesInOrder') }}
                </span>
                <span class="glance-metric">
                  <b>{{ money(result.totalCents) }}</b> {{ t()('orderTotal') }}
                </span>
              </div>
            }
          </section>

          <!-- FR-6 -->
          @if (state.priceDrift().length > 0) {
            <div class="note warn no-print" style="margin-bottom:14px">
              <h4>{{ t()('priceChanged') }}</h4>
              <ul>
                @for (drift of state.priceDrift(); track drift.lineId) {
                  <li>
                    {{ drift.itemName }} — {{ t()('priceWas') }}
                    <span class="num">{{ money(drift.capturedCents) }}</span>
                    , {{ t()('priceNow') }}
                    <span class="num">{{ money(drift.currentCents) }}</span>
                  </li>
                }
              </ul>
            </div>
          }

          <!-- Section 5: an unsatisfiable contract is not a user error -->
          @if (contractProblem(); as basket) {
            <div class="note bad" style="margin-bottom:14px">
              <h4>{{ t()('contractProblem') }}</h4>
              <p>
                {{ t()('contractProblemHelp') }}
                <b class="num">{{ money(basket.totalCents ?? 0) }}</b
                >, {{ t()('exceedsCapBy') }}
                <b class="num">{{ money(basket.gapCents) }}</b
                >.
              </p>
            </div>
          }
          @for (key of unstockable(); track key) {
            <div class="note bad" style="margin-bottom:14px">
              {{ t()('categoryUnstockable') }}: <b>{{ categoryLabel(key) }}</b>
            </div>
          }

          @if (showQuickStart()) {
            <section class="quick-start no-print" aria-labelledby="quick-start-title">
              <div>
                <span class="eyebrow">{{ t()('recommended') }}</span>
                <h2 id="quick-start-title">{{ t()('quickStartTitle') }}</h2>
                <p>{{ t()('quickStartText') }}</p>
              </div>
              <div class="quick-start-actions">
                <button
                  class="btn"
                  type="button"
                  [disabled]="readOnly() || state.busy()"
                  (click)="addRecommendedBasket()"
                >
                  {{ t()('addRecommendedBasket') }}
                </button>
                <button class="btn ghost small" type="button" (click)="dismissQuickStart()">
                  {{ t()('chooseMyself') }}
                </button>
              </div>
            </section>
          }

          <section class="catalogue-section" aria-labelledby="shopping-title">
            <div class="catalogue-heading">
              <div>
                <h2 id="shopping-title">{{ t()('shoppingTitle') }}</h2>
                <p class="sec-note">{{ t()('shoppingHint') }}</p>
              </div>
            </div>

          <div class="toolbar no-print">
            <label class="sr-only" for="search">{{ t()('searchItems') }}</label>
            <input
              id="search"
              class="input"
              type="search"
              [placeholder]="t()('searchPlaceholder')"
              [ngModel]="query()"
              (ngModelChange)="query.set($event)"
            />
            @if (scannerEnabled()) {
              <button class="btn neutral" type="button" (click)="scanning.set(!scanning())">
                {{ t()('scanBarcode') }}
              </button>
            }
          </div>

          @if (scanning()) {
            <div class="card no-print" style="margin-bottom:14px">
              <div class="field">
                <label for="upc">{{ t()('enterUpc') }}</label>
                <input
                  id="upc"
                  class="input num"
                  type="text"
                  inputmode="numeric"
                  [ngModel]="upc()"
                  (ngModelChange)="upc.set($event)"
                  (keyup.enter)="lookupUpc()"
                />
              </div>
              @if (scanError()) {
                <p class="sec-note" style="margin:8px 0 0">{{ t()('itemNotFound') }}</p>
              }
            </div>
          }

          <div class="filters no-print" role="group" [attr.aria-label]="t()('allCategories')">
            <button
              type="button"
              [attr.aria-pressed]="activeCategory() === 'all'"
              (click)="activeCategory.set('all')"
            >
              {{ t()('allCategories') }}
            </button>
            @for (cat of state.categories(); track cat.key) {
              <button
                type="button"
                [attr.aria-pressed]="activeCategory() === cat.key"
                (click)="activeCategory.set(cat.key)"
              >
                {{ cat.label }}
              </button>
            }
          </div>

          <div class="grid">
            @for (item of visibleItems(); track item.id) {
              <article
                class="tile"
                [class.in-cart]="qtyOf(item.id) > 0"
                [class.conflict]="conflictsFor(item).length > 0"
              >
                <div>
                  <div class="tile-name">{{ i18n.localized(item.name, item.nameEs) }}</div>
                  <div class="tile-sub">
                    {{ item.packageSize }} · {{ categoryLabel(item.categoryKey) }}
                  </div>
                </div>

                <div class="tagrow">
                  @if (isRecommended(item.id)) {
                    <span class="tag recommended">{{ t()('recommended') }}</span>
                  }
                  @if (item.shelfLifeClass === 'fresh' || item.shelfLifeClass === 'refrigerated') {
                    <span class="tag cold">{{ t()('useEarly') }}</span>
                  }
                  @if (item.servingsPerPackageUnits === 0) {
                    <span class="tag">{{ t()('noServings') }}</span>
                  }
                  @for (tag of visibleTags(item); track tag) {
                    <span class="tag">{{ tag }}</span>
                  }
                </div>

                <!-- FR-10: flag mode explains why, rather than hiding silently -->
                @if (conflictsFor(item).length > 0) {
                  <span class="chip short">
                    {{ t()('restrictedItem') }} {{ conflictsFor(item).join(', ') }}
                  </span>
                }

                <div class="tile-stats">
                  <span class="price num">{{ money(item.priceCents) }}</span>
                  <span class="per num">
                    {{ servings(item.servingsPerPackageUnits) }} {{ t()('servings') }}
                  </span>
                </div>

                <div class="qty no-print">
                  <button
                    type="button"
                    [attr.aria-label]="t()('remove') + ' ' + item.name"
                    [disabled]="qtyOf(item.id) === 0 || readOnly()"
                    (click)="bump(item, -1)"
                  >
                    −
                  </button>
                  <label class="sr-only" [for]="'qty-' + item.id">
                    {{ t()('qty') }} {{ i18n.localized(item.name, item.nameEs) }}
                  </label>
                  <input
                    [id]="'qty-' + item.id"
                    class="num"
                    type="number"
                    min="0"
                    step="1"
                    inputmode="numeric"
                    [value]="qtyOf(item.id)"
                    [disabled]="readOnly()"
                    (change)="updateQuantity(item, $any($event.target).value)"
                  />
                  <button
                    type="button"
                    [attr.aria-label]="t()('add') + ' ' + item.name"
                    [disabled]="readOnly()"
                    (click)="bump(item, 1)"
                  >
                    +
                  </button>
                </div>
              </article>
            }
          </div>
          </section>

          <section class="cart-section" aria-labelledby="cart-title">
          <h2 class="sec" id="cart-title">{{ t()('inThisOrder') }}</h2>
          @if (state.order()!.lines.length === 0) {
            <p class="sec-note">{{ t()('emptyOrder') }}</p>
          } @else {
            <div class="scroll-x">
              <table class="data">
                <thead>
                  <tr>
                    <th>{{ t()('item') }}</th>
                    <th class="r">{{ t()('qty') }}</th>
                    <th class="r">{{ t()('servings') }}</th>
                    <th class="r">{{ t()('price') }}</th>
                    <th class="r">{{ t()('lineTotal') }}</th>
                    <th class="no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (line of state.order()!.lines; track line.itemId) {
                    <tr>
                      <td>
                        <b>{{ i18n.localized(line.itemNameSnapshot, line.itemNameEsSnapshot) }}</b>
                        <br />
                        <span class="tile-sub">{{ line.packageSizeSnapshot }}</span>
                      </td>
                      <td class="r num">{{ line.qty }}</td>
                      <td class="r num">
                        {{
                          line.servingsUnitsSnapshot > 0
                            ? servings(line.servingsUnitsSnapshot * line.qty)
                            : '—'
                        }}
                      </td>
                      <td class="r num">{{ money(line.unitPriceCentsSnapshot) }}</td>
                      <td class="r num">{{ money(line.unitPriceCentsSnapshot * line.qty) }}</td>
                      <td class="r no-print">
                        <button
                          class="btn ghost small"
                          type="button"
                          [disabled]="readOnly()"
                          (click)="state.setQuantity(line.itemId, 0)"
                        >
                          {{ t()('remove') }}
                        </button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
          </section>
        </main>

        <!-- ---------------- compliance rail ---------------- -->
        <aside
          class="rail"
          id="compliance-panel"
          [attr.data-collapsed]="collapsed()"
          [attr.aria-label]="t()('progress')"
        >
          <button
            class="rail-handle"
            type="button"
            [attr.aria-expanded]="!collapsed()"
            (click)="collapsed.set(!collapsed())"
          >
            <span>{{ t()('viewProgress') }}</span>
            <span class="rail-handle-summary">
              {{ completedCategoryCount() }}/{{ categoryCount() }} {{ t()('categoriesMet') }}
            </span>
            <span aria-hidden="true">{{ collapsed() ? '▴' : '▾' }}</span>
          </button>

          @if (state.compliance(); as result) {
            <div class="rail-summary">
              <span class="eyebrow">{{ t()('progress') }}</span>
              <div class="rail-progress">
                <b>{{ completedCategoryCount() }}/{{ categoryCount() }}</b>
                <span>{{ t()('categoriesMet') }}</span>
              </div>
            </div>

            <div class="verdict" [class.ok]="result.canFinalize" [class.no]="!result.canFinalize">
              <span class="mark" aria-hidden="true">{{ result.canFinalize ? '✓' : '!' }}</span>
              <span>{{ result.canFinalize ? t()('qualifies') : t()('doesNotQualify') }}</span>
            </div>

            <div>
              <h2 class="label-sm" style="margin:0 0 4px">{{ t()('requiredServings') }}</h2>
              @for (cat of result.categories; track cat.categoryKey) {
                <div class="meter">
                  <div class="meter-top">
                    <span class="meter-name">{{ cat.label }}</span>
                    <span class="meter-val num">
                      <b>{{ servings(cat.inCartUnits) }}</b> {{ t()('of') }}
                      {{ servings(cat.requiredUnits) }}
                    </span>
                  </div>
                  <div
                    class="track"
                    role="meter"
                    aria-valuemin="0"
                    [attr.aria-valuemax]="cat.requiredUnits"
                    [attr.aria-valuenow]="cat.inCartUnits"
                    [attr.aria-label]="meterLabel(cat)"
                  >
                    <div
                      class="fill"
                      [class.short]="cat.shortfallUnits > 0"
                      [class.over]="cat.overMax"
                      [style.width.%]="percent(cat)"
                    ></div>
                  </div>

                  <!-- NFR-14: the status is text, not just a coloured bar -->
                  @if (cat.shortfallUnits > 0) {
                    <span class="chip short">
                      {{ t()('shortBy') }} {{ servings(cat.shortfallUnits) }}
                    </span>
                  } @else if (cat.overMax) {
                    <span class="chip over">{{ t()('overMaximum') }}</span>
                  } @else if (cat.surplusUnits > 0) {
                    <span class="chip ok">{{ t()('overMinimum') }}</span>
                  } @else {
                    <span class="chip ok">{{ t()('met') }}</span>
                  }
                  @if (cat.varietyShortfall > 0) {
                    <span class="chip short" style="margin-left:6px">
                      {{ t()('needsVariety') }}: {{ cat.distinctItems }}/{{ cat.minDistinctItems }}
                      {{ t()('differentItems') }}
                    </span>
                  }

                  <!-- FR-23 -->
                  @if (expanded() === cat.categoryKey) {
                    <ul class="contrib">
                      @for (c of cat.contributions; track c.lineId) {
                        <li>
                          {{ c.itemName }} × {{ c.qty }} {{ t()('contributes') }}
                          <span class="num">{{ servings(c.units) }}</span>
                        </li>
                      }
                    </ul>
                  }
                  @if (cat.contributions.length > 0) {
                    <button
                      class="btn ghost small no-print"
                      type="button"
                      style="margin-top:6px"
                      (click)="toggleBreakdown(cat.categoryKey)"
                    >
                      {{ expanded() === cat.categoryKey ? t()('hideBreakdown') : t()('showBreakdown') }}
                    </button>
                  }
                </div>
              }
            </div>

            <!-- FR-15 -->
            <div class="budget">
              <div class="budget-row">
                <span>{{ t()('orderTotal') }}</span>
                <span class="num">{{ money(result.totalCents) }}</span>
              </div>
              <div class="budget-row">
                <span>{{ t()('budgetCap') }}</span>
                <span class="num">{{ money(result.capTotalCents) }}</span>
              </div>
              <div
                class="track"
                role="meter"
                aria-valuemin="0"
                [attr.aria-valuemax]="result.capTotalCents"
                [attr.aria-valuenow]="result.totalCents"
                [attr.aria-label]="budgetLabel(result.totalCents, result.capTotalCents)"
              >
                <div
                  class="fill"
                  [class.over]="result.overCap"
                  [style.width.%]="budgetPercent(result.totalCents, result.capTotalCents)"
                ></div>
              </div>
              <div class="budget-row total">
                <span>{{ result.overCap ? t()('overBudgetBy') : t()('remaining') }}</span>
                <span class="num">{{ money(abs(result.remainingCents)) }}</span>
              </div>
            </div>

            <!-- FR-17 -->
            @if (state.capRecovery(); as recovery) {
              <div class="sug cap no-print">
                <div class="sug-head">{{ t()('getUnderCap') }}</div>
                @for (cut of recovery.reductions; track cut.lineId) {
                  <div class="sug-item">
                    <div class="sug-body">
                      <div class="sug-name">{{ t()('reduce') }} {{ cut.itemName }} × {{ cut.reducibleQty }}</div>
                      <div class="sug-meta num">{{ t()('saves') }} {{ money(cut.centsSaved) }}</div>
                    </div>
                    <button
                      class="btn ghost small"
                      type="button"
                      [disabled]="readOnly()"
                      (click)="applyReduction(cut.lineId, cut.reducibleQty)"
                    >
                      {{ t()('reduce') }}
                    </button>
                  </div>
                }
                @for (swap of recovery.swaps; track swap.fromLineId) {
                  <div class="sug-item">
                    <div class="sug-body">
                      <div class="sug-name">
                        {{ t()('swapFor') }} {{ swap.toItem.name }} × {{ swap.toQty }}
                      </div>
                      <div class="sug-meta num">{{ t()('saves') }} {{ money(swap.centsSaved) }}</div>
                    </div>
                  </div>
                }
                @if (!recovery.sufficient) {
                  <div class="sug-item">
                    <div class="sug-meta">
                      {{ t()('stillOverBy') }}
                      <b class="num">{{ money(recovery.residualCents) }}</b>
                    </div>
                  </div>
                }
              </div>
            }

            <!-- FR-16 -->
            @for (cat of result.categories; track cat.categoryKey) {
              @if (cat.shortfallUnits > 0) {
                <div class="sug no-print">
                  <div class="sug-head">{{ t()('closeGap') }} — {{ cat.label }}</div>
                  @if (suggestionsFor(cat.categoryKey).length === 0) {
                    <div class="sug-item"><div class="sug-meta">{{ t()('noSuggestions') }}</div></div>
                  }
                  @for (s of suggestionsFor(cat.categoryKey); track s.item.id) {
                    <div class="sug-item">
                      <div class="sug-body">
                        <div class="sug-name">
                          {{ i18n.localized(s.item.name, s.item.nameEs) }} × {{ s.qty }}
                        </div>
                        <div class="sug-meta num">
                          {{ servings(s.unitsAdded) }} {{ t()('servings') }} ·
                          {{ money(s.centsAdded) }} ·
                          {{ s.closesGap ? t()('closesGap') : t()('closesPartially') }}
                        </div>
                      </div>
                      <button
                        class="btn small"
                        type="button"
                        [disabled]="readOnly()"
                        (click)="addSuggestion(s.item.id, s.qty)"
                      >
                        {{ t()('add') }}
                      </button>
                    </div>
                  }
                </div>
              }
            }

            <!-- FR-18 -->
            @if (state.order()!.status === 'draft') {
              @if (result.canFinalize) {
                <button
                  class="btn wide no-print"
                  type="button"
                  [disabled]="state.busy() || readOnly()"
                  (click)="finalize()"
                >
                  {{ t()('finalize') }}
                </button>
                <p class="sec-note" style="margin:0">{{ t()('finalizeHint') }}</p>
              } @else if (state.isStaff()) {
                <div class="card no-print">
                  <h2 class="label-sm" style="margin:0 0 8px">{{ t()('staffOverride') }}</h2>
                  <div class="field" style="margin-bottom:10px">
                    <label for="reason">{{ t()('overrideReason') }}</label>
                    <textarea
                      id="reason"
                      class="input"
                      [ngModel]="overrideReason()"
                      (ngModelChange)="overrideReason.set($event)"
                    ></textarea>
                  </div>
                  <div class="field" style="margin-bottom:10px">
                    <label for="initials">{{ t()('staffInitials') }}</label>
                    <input
                      id="initials"
                      class="input"
                      maxlength="8"
                      [ngModel]="initials()"
                      (ngModelChange)="initials.set($event)"
                    />
                  </div>
                  <button
                    class="btn wide danger"
                    type="button"
                    [disabled]="!overrideReason().trim() || !initials().trim() || state.busy()"
                    (click)="finalize()"
                  >
                    {{ t()('finalizeWithOverride') }}
                  </button>
                </div>
              } @else {
                <p class="sec-note" style="margin:0">
                  {{ t()('cannotFinalize') }} {{ t()('askStaff') }}
                </p>
              }
            } @else {
              <div class="verdict ok">
                <span class="mark" aria-hidden="true">✓</span>
                <span>{{ t()('orderFinalized') }}</span>
              </div>
              <button class="btn wide no-print" type="button" (click)="state.generatePlan()">
                {{ t()('generatePlan') }}
              </button>
            }
          }
        </aside>
      </div>
    }
  `,
})
export class OrderComponent {
  protected readonly state = inject(AppState);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(ApiClient);

  protected readonly t = this.i18n.t;
  protected readonly query = signal('');
  protected readonly activeCategory = signal<string>('all');
  /** On phones the progress sheet starts as a compact, always-visible summary. */
  protected readonly collapsed = signal(true);
  protected readonly expanded = signal<string | null>(null);
  protected readonly overrideReason = signal('');
  protected readonly initials = signal('');
  protected readonly scanning = signal(false);
  protected readonly upc = signal('');
  protected readonly scanError = signal(false);
  protected readonly quickStartDismissed = signal(false);

  /** FR-8 (DECIDE): shown only where a scanner is actually present. */
  protected readonly scannerEnabled = signal(true);

  protected readonly money = formatCents;
  protected readonly servings = formatUnits;
  protected readonly abs = Math.abs;

  /** A finalized order, or a suspended account, is read-only. */
  protected readonly readOnly = computed(
    () => this.state.order()?.status !== 'draft' || this.state.suspended(),
  );

  /** One budget-friendly recommendation per unmet category for a gentle start. */
  protected readonly quickStartSuggestions = computed<Suggestion[]>(() => {
    const result = this.state.compliance();
    const suggestions = this.state.suggestions();
    if (!result) return [];

    const picks: Suggestion[] = [];
    for (const category of result.categories) {
      if (category.shortfallUnits <= 0) continue;
      const choices = suggestions[category.categoryKey] ?? [];
      const pick = choices.find((suggestion) => suggestion.closesGap) ?? choices[0];
      if (pick) picks.push(pick);
    }
    return picks;
  });

  protected readonly recommendedItemIds = computed(
    () => new Set(this.quickStartSuggestions().map((suggestion) => suggestion.item.id)),
  );

  protected readonly showQuickStart = computed(
    () =>
      !this.quickStartDismissed() &&
      (this.state.order()?.lines.length ?? 0) === 0 &&
      this.quickStartSuggestions().length > 0,
  );

  protected readonly itemCount = computed(() => this.state.order()?.lines.length ?? 0);
  protected readonly packageCount = computed(() =>
    (this.state.order()?.lines ?? []).reduce((total, line) => total + line.qty, 0),
  );
  protected readonly categoryCount = computed(() => this.state.compliance()?.categories.length ?? 0);
  protected readonly completedCategoryCount = computed(
    () =>
      this.state
        .compliance()
        ?.categories.filter(
          (category) =>
            category.shortfallUnits === 0 && !category.overMax && category.varietyShortfall === 0,
        ).length ?? 0,
  );
  protected readonly orderStage = computed<'choose' | 'check' | 'finish'>(() => {
    const result = this.state.compliance();
    if (result?.canFinalize) return 'finish';
    return this.itemCount() > 0 ? 'check' : 'choose';
  });

  protected readonly visibleItems = computed(() => {
    const term = this.query().trim().toLowerCase();
    const category = this.activeCategory();
    const hideRestricted = false; // FR-10 (DECIDE): flag rather than hide
    return this.state.activeItems().filter((item) => {
      if (category !== 'all' && item.categoryKey !== category) return false;
      if (hideRestricted && this.conflictsFor(item).length > 0) return false;
      if (!term) return true;
      return `${item.name} ${item.nameEs} ${item.sku} ${item.upc}`.toLowerCase().includes(term);
    });
  });

  protected readonly contractProblem = computed(() => {
    const basket = this.state.cheapestBasket();
    return basket && basket.exceedsCap ? basket : null;
  });

  protected readonly unstockable = computed(
    () => this.state.cheapestBasket()?.impossibleCategories ?? [],
  );

  protected categoryLabel(key: string): string {
    return this.state.categories().find((c) => c.key === key)?.label ?? key;
  }

  protected conflictsFor(item: Item): DietaryTag[] {
    return this.state.conflictsFor(item);
  }

  /** Keep the shopping cards focused on ordering; dietary flags remain enforced in the rules. */
  protected visibleTags(item: Item): DietaryTag[] {
    return item.tags.filter((tag) => tag !== 'halal' && tag !== 'kosher').slice(0, 2);
  }

  protected qtyOf(itemId: string): number {
    return this.state.order()?.lines.find((l) => l.itemId === itemId)?.qty ?? 0;
  }

  protected percent(cat: CategoryStatus): number {
    if (cat.requiredUnits <= 0) return 100;
    return Math.min(100, Math.round((cat.inCartUnits / cat.requiredUnits) * 100));
  }

  protected budgetPercent(total: number, cap: number): number {
    if (cap <= 0) return 0;
    return Math.min(100, Math.round((total / cap) * 100));
  }

  /** NFR-14: the meter announces its state in words to a screen reader. */
  protected meterLabel(cat: CategoryStatus): string {
    const t = this.t();
    const base = `${cat.label}: ${formatUnits(cat.inCartUnits)} ${t('of')} ${formatUnits(
      cat.requiredUnits,
    )} ${t('servings')}`;
    if (cat.shortfallUnits > 0) return `${base}, ${t('shortBy')} ${formatUnits(cat.shortfallUnits)}`;
    return `${base}, ${t('met')}`;
  }

  protected budgetLabel(total: number, cap: number): string {
    const t = this.t();
    return `${t('orderTotal')} ${formatCents(total)} ${t('of')} ${formatCents(cap)}`;
  }

  protected suggestionsFor(categoryKey: string) {
    return this.state.suggestions()[categoryKey] ?? [];
  }

  protected isRecommended(itemId: string): boolean {
    return this.recommendedItemIds().has(itemId);
  }

  protected toggleBreakdown(key: string): void {
    this.expanded.set(this.expanded() === key ? null : key);
  }

  protected bump(item: Item, delta: number): void {
    void this.state.setQuantity(item.id, Math.max(0, this.qtyOf(item.id) + delta));
  }

  /** Commit a typed whole-package quantity when the field is changed or blurred. */
  protected updateQuantity(item: Item, rawQuantity: string): void {
    const quantity = Number(rawQuantity);
    if (!Number.isFinite(quantity)) return;
    void this.state.setQuantity(item.id, Math.max(0, Math.floor(quantity)));
  }

  protected addSuggestion(itemId: string, qty: number): void {
    void this.state.setQuantity(itemId, this.qtyOf(itemId) + qty);
  }

  protected dismissQuickStart(): void {
    this.quickStartDismissed.set(true);
  }

  protected async addRecommendedBasket(): Promise<void> {
    if (this.readOnly() || this.state.busy()) return;

    const recommendations = this.quickStartSuggestions();
    this.quickStartDismissed.set(true);
    for (const suggestion of recommendations) {
      await this.state.setQuantity(suggestion.item.id, this.qtyOf(suggestion.item.id) + suggestion.qty);
    }
  }

  protected applyReduction(lineId: string, by: number): void {
    const line = this.state.order()?.lines.find((l) => l.id === lineId);
    if (!line) return;
    void this.state.setQuantity(line.itemId, Math.max(0, line.qty - by));
  }

  protected async lookupUpc(): Promise<void> {
    this.scanError.set(false);
    const item = await this.api.itemByUpc(this.upc().trim());
    if (!item) {
      this.scanError.set(true);
      return;
    }
    await this.state.setQuantity(item.id, this.qtyOf(item.id) + 1);
    this.upc.set('');
  }

  protected async finalize(): Promise<void> {
    const result = this.state.compliance();
    const needsOverride = result !== null && !result.canFinalize;
    const ok = await this.state.finalize(
      this.initials(),
      needsOverride ? this.overrideReason() : undefined,
    );
    if (ok) await this.state.generatePlan();
  }
}
