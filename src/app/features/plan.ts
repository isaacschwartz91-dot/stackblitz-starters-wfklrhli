/**
 * Meal plan and printed output (FR-24 .. FR-32, FR-35, NFR-15).
 *
 * Two sheets come off this screen:
 *   - the customer sheet: the plan in plain language and large type
 *   - the compliance sheet: what gets filed for reimbursement
 *
 * Everything on the compliance sheet reads from the order's own snapshot, not
 * from the live catalogue, so reprinting a year-old order reproduces it
 * exactly (FR-35).
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { AppState } from '../core/state';
import { I18nService } from '../core/i18n';
import { formatCents, formatUnits } from '../../shared/units';
import type { MealKey, Order } from '../../shared/types';

@Component({
  selector: 'app-plan',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .main {
        padding: 20px;
        max-width: 900px;
      }
      .toolbar {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 16px;
      }
      .days {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .day {
        border: 1px solid var(--line);
        border-radius: var(--r);
        background: var(--surface);
        overflow: hidden;
      }
      .day-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 10px;
        padding: 9px 12px;
        background: var(--surface-2);
        border-bottom: 1px solid var(--line);
      }
      .day-name {
        font-weight: 700;
        font-size: 14px;
      }
      .day-date {
        font-size: 12px;
        color: var(--ink-3);
      }
      .meals {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
      }
      @media (max-width: 640px) {
        .meals {
          grid-template-columns: 1fr;
        }
        .meal {
          border-right: 0 !important;
          border-bottom: 1px solid var(--line);
        }
      }
      .meal {
        padding: 11px 12px;
        border-right: 1px solid var(--line);
      }
      .meal:last-child {
        border-right: 0;
      }
      .meal h4 {
        margin: 0 0 7px;
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--ink-3);
        font-weight: 700;
      }
      .meal ul {
        margin: 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .meal li {
        font-size: 13px;
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      .meal li .amt {
        color: var(--ink-3);
      }
      .meal li.short {
        color: var(--ochre);
        font-weight: 600;
      }
      .early {
        color: var(--spruce);
        font-weight: 700;
      }

      /* --- printed sheets --- */
      .sheet {
        background: var(--surface);
        border: 1px solid var(--line);
        padding: 26px;
        max-width: 760px;
        font-family: var(--serif);
        margin-top: 20px;
      }
      .sheet h1 {
        font-size: 21px;
        margin: 0 0 2px;
      }
      .sheet .sub {
        font-family: var(--sans);
        font-size: 12px;
        color: var(--ink-3);
        margin: 0 0 18px;
      }
      .sheet table {
        font-family: var(--sans);
      }
      .sheet-meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 12px;
        font-family: var(--sans);
        margin-bottom: 18px;
      }
      .sheet-meta dt {
        font-size: 9.5px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--ink-3);
      }
      .sheet-meta dd {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }
      .sign {
        display: flex;
        gap: 30px;
        margin-top: 30px;
        font-family: var(--sans);
        font-size: 11.5px;
        color: var(--ink-3);
      }
      .sign div {
        flex: 1;
        border-top: 1px solid var(--ink);
        padding-top: 5px;
      }
      /* Customer sheet: plain language, large type (FR-32). */
      .customer-sheet {
        font-size: 13pt;
      }
      .customer-sheet .meal li {
        font-size: 12pt;
      }
      .customer-sheet .day-name {
        font-size: 15pt;
      }

      /* Everyday, screen-first meal planning -------------------------------- */
      .main {
        max-width: 1120px;
        padding: 32px clamp(20px, 4vw, 52px) 48px;
      }
      .plan-hero {
        border: 1px solid var(--line);
        border-radius: 18px;
        background:
          radial-gradient(circle at 100% 0, var(--spruce-soft) 0, transparent 42%),
          var(--surface);
        padding: clamp(20px, 4vw, 34px);
        margin-bottom: 22px;
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
      .plan-title {
        font-family: var(--serif);
        font-size: clamp(28px, 3vw, 38px);
        line-height: 1.08;
        letter-spacing: -0.025em;
        margin: 0;
        max-width: 20ch;
      }
      .plan-lede {
        color: var(--ink-2);
        font-size: 16px;
        line-height: 1.55;
        margin: 10px 0 0;
        max-width: 60ch;
      }
      .plan-metrics {
        display: flex;
        flex-wrap: wrap;
        gap: 10px 24px;
        border-top: 1px solid var(--line);
        margin-top: 22px;
        padding-top: 17px;
      }
      .plan-metric {
        display: flex;
        align-items: baseline;
        gap: 6px;
        color: var(--ink-2);
        font-size: 12px;
      }
      .plan-metric b {
        color: var(--ink);
        font-family: var(--mono);
        font-size: 19px;
      }
      .plan-hero .toolbar {
        margin: 20px 0 0;
      }
      .day-navigator {
        display: flex;
        align-items: center;
        gap: 8px;
        overflow-x: auto;
        padding: 2px 0 8px;
        margin: 4px 0 14px;
        scrollbar-width: thin;
      }
      .day-navigator button {
        background: var(--surface);
        border: 1px solid var(--line-2);
        border-radius: 999px;
        color: var(--ink-2);
        flex: 0 0 auto;
        min-height: 40px;
        padding: 0 14px;
        font-size: 12px;
        font-weight: 700;
      }
      .day-navigator button[aria-pressed='true'] {
        background: var(--spruce);
        border-color: var(--spruce);
        color: var(--spruce-ink);
      }
      .focus-day {
        border: 1px solid var(--line);
        border-radius: 16px;
        background: var(--surface);
        overflow: hidden;
        box-shadow: 0 8px 24px rgb(20 32 28 / 6%);
      }
      .focus-day-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 16px;
        background: var(--surface-2);
        border-bottom: 1px solid var(--line);
        padding: 18px 20px;
      }
      .focus-day-head h2 {
        font-family: var(--serif);
        font-size: 24px;
        margin: 0;
      }
      .focus-day-head p {
        color: var(--ink-3);
        font-size: 13px;
        margin: 3px 0 0;
      }
      .focus-meals {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .focus-meal {
        border-right: 1px solid var(--line);
        min-height: 190px;
        padding: 18px;
      }
      .focus-meal:last-child {
        border-right: 0;
      }
      .focus-meal h3 {
        color: var(--spruce);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.1em;
        margin: 0 0 14px;
        text-transform: uppercase;
      }
      .focus-meal ul {
        display: flex;
        flex-direction: column;
        gap: 8px;
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .focus-meal li {
        align-items: baseline;
        display: flex;
        font-size: 14px;
        gap: 9px;
        justify-content: space-between;
      }
      .focus-meal .amt {
        color: var(--ink-3);
        flex: 0 0 auto;
      }
      .focus-meal li.short {
        color: var(--ochre);
        display: block;
        font-weight: 700;
      }
      .all-days-toggle {
        margin-top: 14px;
      }
      .all-days {
        border-top: 1px solid var(--line);
        margin-top: 28px;
        padding-top: 22px;
      }
      .all-days h2 {
        font-family: var(--serif);
        font-size: 21px;
        margin: 0 0 12px;
      }
      .all-days .day {
        border-radius: 12px;
      }
      @media (max-width: 700px) {
        .main {
          padding: 22px 18px 36px;
        }
        .plan-hero {
          border-radius: 14px;
          padding: 20px;
        }
        .focus-day {
          border-radius: 14px;
        }
        .focus-day-head {
          align-items: flex-start;
          flex-direction: column;
          padding: 16px;
        }
        .focus-meals {
          grid-template-columns: 1fr;
        }
        .focus-meal {
          border-bottom: 1px solid var(--line);
          border-right: 0;
          min-height: 0;
          padding: 16px;
        }
        .focus-meal:last-child {
          border-bottom: 0;
        }
      }
    `,
  ],
  template: `
    <div class="main">
      @if (!order()) {
        <h1 class="page">{{ t()('mealPlan') }}</h1>
        <p class="sec-note">{{ t()('noPlanYet') }}</p>
      } @else {
        <section class="plan-hero no-print" aria-labelledby="plan-title">
          <span class="eyebrow">{{ t()('mealPlan') }}</span>
          <h1 class="plan-title" id="plan-title">{{ t()('planOverview') }}</h1>
          <p class="plan-lede">{{ t()('planReady') }}</p>

          @if (plan(); as p) {
            <div class="plan-metrics" aria-live="polite">
              <span class="plan-metric"><b>{{ p.days.length }}</b> {{ t()('days') }}</span>
              <span class="plan-metric"><b>{{ plannedMealCount() }}</b> {{ t()('mealsPlanned') }}</span>
            </div>
          }

          <div class="toolbar">
            <button class="btn" type="button" (click)="state.generatePlan()" [disabled]="state.busy()">
              {{ plan() ? t()('regenerate') : t()('generatePlan') }}
            </button>
            @if (plan()) {
              <button class="btn neutral" type="button" (click)="print()">
                {{ t()('print') }}
              </button>
            }
          </div>
        </section>

        @if (state.planIsStale()) {
          <div class="note warn no-print" style="margin-bottom:14px">{{ t()('planStale') }}</div>
        }

        @if (plan(); as p) {
          @if (!p.complete) {
            <div class="note warn no-print" style="margin-bottom:14px">
              <h4>{{ t()('planIncomplete') }}</h4>
            </div>
          }

          <!-- FR-29 -->
          @if (p.unused.length > 0) {
            <div class="note warn" style="margin-bottom:14px">
              <h4>{{ t()('unusedItems') }}</h4>
              <ul>
                @for (u of p.unused; track u.itemId) {
                  <li>
                    {{ u.itemName }} —
                    @if (u.nonCreditable) {
                      {{ t()('pantryStaple') }}
                    } @else if (u.entirelyUnused) {
                      {{ t()('notUsedAtAll') }}
                    } @else {
                      <!-- Phrased so neither language needs a plural rule -->
                      {{ t()('leftOver') }}: <span class="num">{{ servings(u.leftoverUnits) }}</span>
                      {{ t()('servings').toLowerCase() }}
                    }
                  </li>
                }
              </ul>
            </div>
          }

          <section class="plan-focus no-print" aria-labelledby="selected-day-title">
            <div class="day-navigator" role="group" [attr.aria-label]="t()('selectDay')">
              @for (day of p.days; track day.dayIndex) {
                <button
                  type="button"
                  [attr.aria-pressed]="selectedDayIndex() === day.dayIndex"
                  (click)="selectDay(day.dayIndex)"
                >
                  {{ t()('day') }} {{ day.dayIndex + 1 }}
                </button>
              }
            </div>

            @if (selectedDay(); as day) {
              <article class="focus-day">
                <div class="focus-day-head">
                  <div>
                    <span class="eyebrow">{{ t()('planForDay') }}</span>
                    <h2 id="selected-day-title">{{ t()('day') }} {{ day.dayIndex + 1 }}</h2>
                  </div>
                  <p>{{ formatDate(day.date) }}</p>
                </div>
                <div class="focus-meals">
                  @for (meal of day.meals; track meal.meal) {
                    <section class="focus-meal">
                      <h3>{{ mealLabel(meal.meal) }}</h3>
                      <ul>
                        @for (entry of meal.items; track entry.itemId) {
                          <li>
                            <span>
                              @if (isEarly(entry.itemId)) {
                                <span class="early" aria-hidden="true">●</span>
                              }
                              {{ i18n.localized(entry.itemName, entry.itemNameEs) }}
                            </span>
                            <span class="amt num">{{ servings(entry.units) }}</span>
                          </li>
                        }
                        @for (short of meal.shortfalls; track short.categoryKey) {
                          <li class="short">
                            {{ t()('mealShort') }} — {{ categoryLabel(short.categoryKey) }}
                            <span class="num">{{ servings(short.units) }}</span>
                          </li>
                        }
                      </ul>
                    </section>
                  }
                </div>
              </article>
            }

            <button class="btn ghost small all-days-toggle" type="button" (click)="toggleAllDays()">
              {{ showAllDays() ? t()('hideAllDays') : t()('viewAllDays') }}
            </button>
          </section>

          @if (showAllDays()) {
            <section class="all-days no-print" aria-labelledby="all-days-title">
              <h2 id="all-days-title">{{ t()('allDays') }}</h2>
              <div class="days">
                @for (day of p.days; track day.dayIndex) {
                  <article class="day">
                    <div class="day-head">
                      <span class="day-name">{{ t()('day') }} {{ day.dayIndex + 1 }}</span>
                      <span class="day-date">{{ formatDate(day.date) }}</span>
                    </div>
                    <div class="meals">
                      @for (meal of day.meals; track meal.meal) {
                        <div class="meal">
                          <h4>{{ mealLabel(meal.meal) }}</h4>
                          <ul>
                            @for (entry of meal.items; track entry.itemId) {
                              <li>
                                <span>
                                  @if (isEarly(entry.itemId)) {
                                    <span class="early" aria-hidden="true">●</span>
                                  }
                                  {{ i18n.localized(entry.itemName, entry.itemNameEs) }}
                                </span>
                                <span class="amt num">{{ servings(entry.units) }}</span>
                              </li>
                            }
                            @for (short of meal.shortfalls; track short.categoryKey) {
                              <li class="short">
                                {{ t()('mealShort') }} — {{ categoryLabel(short.categoryKey) }}
                                <span class="num">{{ servings(short.units) }}</span>
                              </li>
                            }
                          </ul>
                        </div>
                      }
                    </div>
                  </article>
                }
              </div>
            </section>
          }

          <!-- ---- customer sheet (FR-32) ---- -->
          <section class="sheet customer-sheet print-only">
            <h1>{{ t()('customerSheet') }}</h1>
            <p class="sub">
              {{ t()('referralId') }}: <span class="num">{{ referralId() }}</span> ·
              {{ t()('members') }}: <span class="num">{{ snapshot().memberCount }}</span>
            </p>

            <div class="days">
              @for (day of p.days; track day.dayIndex) {
                <article class="day">
                  <div class="day-head">
                    <span class="day-name">{{ t()('day') }} {{ day.dayIndex + 1 }}</span>
                    <span class="day-date">{{ formatDate(day.date) }}</span>
                  </div>
                  <div class="meals">
                    @for (meal of day.meals; track meal.meal) {
                      <div class="meal">
                        <h4>{{ mealLabel(meal.meal) }}</h4>
                        <ul>
                          @for (entry of meal.items; track entry.itemId) {
                            <li>
                              <span>
                                @if (isEarly(entry.itemId)) {
                                  <span class="early" aria-hidden="true">●</span>
                                }
                                {{ i18n.localized(entry.itemName, entry.itemNameEs) }}
                              </span>
                              <span class="amt num">{{ servings(entry.units) }}</span>
                            </li>
                          }
                          <!-- FR-28: never a silently thin meal -->
                          @for (short of meal.shortfalls; track short.categoryKey) {
                            <li class="short">
                              {{ t()('mealShort') }} — {{ categoryLabel(short.categoryKey) }}
                              <span class="num">{{ servings(short.units) }}</span>
                            </li>
                          }
                        </ul>
                      </div>
                    }
                  </div>
                </article>
              }
            </div>
          </section>
        }

        <!-- ---- compliance sheet (FR-32, AC-6) ---- -->
        <section class="sheet">
          <h1>{{ t()('complianceSheet') }}</h1>
          <p class="sub">
            {{ snapshot().scnName }} — {{ snapshot().profileName }} v{{ snapshot().profileVersion }}
          </p>

          <dl class="sheet-meta">
            <div>
              <dt>{{ t()('referralId') }}</dt>
              <dd class="num">{{ referralId() }}</dd>
            </div>
            <div>
              <dt>{{ t()('members') }}</dt>
              <dd class="num">{{ snapshot().memberCount }}</dd>
            </div>
            <div>
              <dt>{{ t()('days') }}</dt>
              <dd class="num">{{ snapshot().daysCovered }}</dd>
            </div>
            <div>
              <dt>{{ t()('finalizedOn') }}</dt>
              <dd class="num">{{ order()!.finalizedAt ? formatDate(order()!.finalizedAt!) : '—' }}</dd>
            </div>
            <div>
              <dt>{{ t()('staffInitials') }}</dt>
              <dd class="num">{{ order()!.staffInitials || '—' }}</dd>
            </div>
          </dl>

          <table class="data">
            <thead>
              <tr>
                <th>{{ t()('item') }}</th>
                <th class="r">{{ t()('qty') }}</th>
                <th class="r">{{ t()('servings') }}</th>
                <th class="r">{{ t()('price') }}</th>
                <th class="r">{{ t()('lineTotal') }}</th>
              </tr>
            </thead>
            <tbody>
              @for (line of order()!.lines; track line.id) {
                <tr>
                  <td>
                    {{ line.itemNameSnapshot }}
                    <br />
                    <span style="font-size:11px;color:var(--ink-3)">
                      {{ line.packageSizeSnapshot }} · {{ categoryLabel(line.categorySnapshot) }}
                    </span>
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
                </tr>
              }
            </tbody>
          </table>

          <table class="data" style="margin-top:20px">
            <thead>
              <tr>
                <th>{{ t()('item') }}</th>
                <th class="r">{{ t()('required') }}</th>
                <th class="r">{{ t()('purchased') }}</th>
                <th class="r">{{ t()('result') }}</th>
              </tr>
            </thead>
            <tbody>
              @for (cat of snapshot().categories; track cat.key) {
                <tr>
                  <td>{{ cat.label }} <span style="color:var(--ink-3)">({{ cat.unitLabel }})</span></td>
                  <td class="r num">{{ servings(requiredFor(cat.key)) }}</td>
                  <td class="r num">{{ servings(purchasedFor(cat.key)) }}</td>
                  <td class="r">
                    <b>
                      {{
                        purchasedFor(cat.key) >= requiredFor(cat.key)
                          ? t()('met')
                          : t()('short') + ' ' + servings(requiredFor(cat.key) - purchasedFor(cat.key))
                      }}
                    </b>
                  </td>
                </tr>
              }
            </tbody>
          </table>

          <table class="data" style="margin-top:20px">
            <tbody>
              <tr>
                <td>{{ t()('budgetCap') }} ({{ snapshot().capBasis === 'per_member' ? t()('members') : 'order' }})</td>
                <td class="r num">{{ money(snapshot().capTotalCents) }}</td>
              </tr>
              <tr>
                <td><b>{{ t()('orderTotal') }}</b></td>
                <td class="r num"><b>{{ money(order()!.totalCents) }}</b></td>
              </tr>
              <tr>
                <td>{{ t()('remaining') }}</td>
                <td class="r num">{{ money(snapshot().capTotalCents - order()!.totalCents) }}</td>
              </tr>
            </tbody>
          </table>

          <!-- FR-18: an override is part of the record, not a footnote -->
          @if (order()!.override; as override) {
            <div class="note bad" style="margin-top:18px">
              <h4>{{ t()('overriddenLabel') }}</h4>
              <p>{{ override.reason }}</p>
              <p>
                {{ t()('staffInitials') }}: <b>{{ override.staffInitials }}</b> ·
                <span class="num">{{ formatDate(override.at) }}</span>
              </p>
            </div>
          }

          <div class="sign">
            <div>{{ t()('staffInitialsAndDate') }}</div>
            <div>{{ t()('customerSignature') }}</div>
          </div>
        </section>
      }
    </div>
  `,
})
export class PlanComponent {
  protected readonly state = inject(AppState);
  protected readonly i18n = inject(I18nService);

  protected readonly t = this.i18n.t;
  protected readonly money = formatCents;
  protected readonly servings = formatUnits;

  protected readonly order = this.state.order;
  protected readonly plan = this.state.plan;
  protected readonly selectedDayIndex = signal(0);
  protected readonly showAllDays = signal(false);

  protected readonly selectedDay = computed(() => {
    const days = this.plan()?.days ?? [];
    return days.find((day) => day.dayIndex === this.selectedDayIndex()) ?? days[0] ?? null;
  });

  protected readonly plannedMealCount = computed(
    () => this.plan()?.days.reduce((total, day) => total + day.meals.length, 0) ?? 0,
  );

  protected readonly snapshot = computed(
    () => (this.order() as Order).rulesSnapshot,
  );

  protected readonly referralId = computed(
    () => this.state.household()?.referralId ?? '—',
  );

  protected requiredFor(key: string): number {
    return this.snapshot().requiredUnitsByCategory[key] ?? 0;
  }

  /** Read from the order's own lines, never from the live catalogue. */
  protected purchasedFor(key: string): number {
    const order = this.order();
    if (!order) return 0;
    return order.lines
      .filter((l) => l.categorySnapshot === key)
      .reduce((sum, l) => sum + l.servingsUnitsSnapshot * l.qty, 0);
  }

  protected categoryLabel(key: string): string {
    // The snapshot's label wins, so a later rename cannot rewrite an old sheet.
    return (
      this.snapshot().categories.find((c) => c.key === key)?.label ??
      this.state.categories().find((c) => c.key === key)?.label ??
      key
    );
  }

  protected mealLabel(meal: MealKey): string {
    return this.t()(meal);
  }

  protected selectDay(dayIndex: number): void {
    this.selectedDayIndex.set(dayIndex);
  }

  protected toggleAllDays(): void {
    this.showAllDays.update((shown) => !shown);
  }

  /** FR-27: mark the perishables so the customer eats them first. */
  protected isEarly(itemId: string): boolean {
    const line = this.order()?.lines.find((l) => l.itemId === itemId);
    return line?.shelfLifeClassSnapshot === 'fresh' || line?.shelfLifeClassSnapshot === 'refrigerated';
  }

  protected formatDate(iso: string): string {
    const date = iso.length === 10 ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
    return date.toLocaleDateString(this.i18n.locale(), {
      weekday: iso.length === 10 ? 'long' : undefined,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }

  protected print(): void {
    window.print();
  }
}
