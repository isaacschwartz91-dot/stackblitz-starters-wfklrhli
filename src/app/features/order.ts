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
import type { CategoryStatus } from '../../shared/compliance/engine';

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
      .qty output {
        flex: 1;
        display: grid;
        place-items: center;
        min-width: 44px;
        font-family: var(--mono);
        font-size: 15px;
        font-weight: 700;
        background: var(--surface);
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
    `,
  ],
  template: `
    <a class="skip-link" href="#compliance-panel">{{ t()('skipToPanel') }}</a>

    @if (!state.order()) {
      <div class="main">
        <h1 class="page">{{ t()('buildOrder') }}</h1>
        @if (!state.household()) {
          <p class="sec-note">{{ t()('noHousehold') }}</p>
        } @else if (state.suspended()) {
          <div class="note warn">{{ t()('suspendedNotice') }}</div>
        } @else {
          <p class="sec-note">{{ t()('buildOrderHint') }}</p>
          <button class="btn" type="button" (click)="state.startOrder()" [disabled]="state.busy()">
            {{ t()('startOrder') }}
          </button>
        }
      </div>
    } @else {
      <div class="wrap">
        <main class="main">
          <h1 class="page">{{ t()('buildOrder') }}</h1>
          <p class="sec-note">{{ t()('buildOrderHint') }}</p>

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
                  @if (item.shelfLifeClass === 'fresh' || item.shelfLifeClass === 'refrigerated') {
                    <span class="tag cold">{{ t()('useEarly') }}</span>
                  }
                  @if (item.servingsPerPackageUnits === 0) {
                    <span class="tag">{{ t()('noServings') }}</span>
                  }
                  @for (tag of item.tags.slice(0, 2); track tag) {
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
                  <output [attr.aria-label]="t()('qty') + ' ' + item.name">{{ qtyOf(item.id) }}</output>
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

          <h2 class="sec" style="margin-top:26px">{{ t()('inThisOrder') }}</h2>
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
            <span>{{ t()('requiredServings') }}</span>
            <span aria-hidden="true">{{ collapsed() ? '▴' : '▾' }}</span>
          </button>

          @if (state.compliance(); as result) {
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
  protected readonly collapsed = signal(false);
  protected readonly expanded = signal<string | null>(null);
  protected readonly overrideReason = signal('');
  protected readonly initials = signal('');
  protected readonly scanning = signal(false);
  protected readonly upc = signal('');
  protected readonly scanError = signal(false);

  /** FR-8 (DECIDE): shown only where a scanner is actually present. */
  protected readonly scannerEnabled = signal(true);

  protected readonly money = formatCents;
  protected readonly servings = formatUnits;
  protected readonly abs = Math.abs;

  /** A finalized order, or a suspended account, is read-only. */
  protected readonly readOnly = computed(
    () => this.state.order()?.status !== 'draft' || this.state.suspended(),
  );

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

  protected toggleBreakdown(key: string): void {
    this.expanded.set(this.expanded() === key ? null : key);
  }

  protected bump(item: Item, delta: number): void {
    void this.state.setQuantity(item.id, Math.max(0, this.qtyOf(item.id) + delta));
  }

  protected addSuggestion(itemId: string, qty: number): void {
    void this.state.setQuantity(itemId, this.qtyOf(itemId) + qty);
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
