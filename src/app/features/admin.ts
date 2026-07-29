/**
 * Admin: program rules and catalogue (FR-1 .. FR-4, FR-25).
 *
 * The numbers the SCN contract dictates live here as data. Nothing in this
 * screen is a constant in code — that is the whole point of section 1.
 *
 * FR-2: editing the arithmetic of a live profile creates a new version rather
 * than mutating it, so orders already completed keep their meaning.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ApiClient } from '../core/api';
import { AppState } from '../core/state';
import { I18nService } from '../core/i18n';
import {
  centsToPlain,
  formatUnits,
  parseMoneyToCents,
  parseServingsToUnits,
  unitsToServings,
} from '../../shared/units';
import { validateProfile } from '../../shared/validation';
import { DIETARY_TAGS, MEAL_KEYS, SHELF_LIFE_CLASSES } from '../../shared/types';
import type {
  Category,
  DietaryTag,
  Item,
  MealKey,
  ProgramProfile,
  ShelfLifeClass,
} from '../../shared/types';

type Pane = 'rules' | 'categories' | 'items';

@Component({
  selector: 'app-admin',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .main {
        padding: 20px;
        max-width: 1000px;
      }
      .tabs {
        display: flex;
        gap: 2px;
        border-bottom: 1px solid var(--line);
        margin-bottom: 18px;
        overflow-x: auto;
      }
      .tabs button {
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
      .tabs button[aria-selected='true'] {
        color: var(--ink);
        border-bottom-color: var(--spruce);
      }
      .grid-form {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: 12px;
      }
      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 16px;
      }
      .req-row td {
        vertical-align: middle;
      }
      .req-row input {
        max-width: 110px;
      }
      .split-cell {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .split-cell input {
        max-width: 74px;
      }
      .total-bad {
        color: var(--clay);
        font-weight: 700;
      }
      .total-ok {
        color: var(--spruce);
        font-weight: 700;
      }
      .versions {
        font-size: 12px;
        color: var(--ink-3);
      }
      .tagpick {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .tagpick label {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border: 1px solid var(--line-2);
        border-radius: 999px;
        padding: 0 12px;
        min-height: 38px;
        font-size: 12.5px;
      }
    `,
  ],
  template: `
    <div class="main">
      <h1 class="page">{{ t()('navAdmin') }}</h1>

      <nav class="tabs" role="tablist">
        <button type="button" role="tab" [attr.aria-selected]="pane() === 'rules'" (click)="pane.set('rules')">
          {{ t()('adminRules') }}
        </button>
        <button type="button" role="tab" [attr.aria-selected]="pane() === 'categories'" (click)="pane.set('categories')">
          Categories
        </button>
        <button type="button" role="tab" [attr.aria-selected]="pane() === 'items'" (click)="pane.set('items')">
          {{ t()('adminCatalog') }}
        </button>
      </nav>

      @if (message(); as m) {
        <div class="note" role="status" style="margin-bottom:14px">{{ m }}</div>
      }
      @if (error(); as m) {
        <div class="note bad" role="alert" style="margin-bottom:14px">{{ m }}</div>
      }

      <!-- =================== program rules (FR-1, FR-2, FR-25) =========== -->
      @if (pane() === 'rules') {
        <div class="field" style="max-width:420px;margin-bottom:16px">
          <label for="prof">{{ t()('programProfile') }}</label>
          <select id="prof" class="input" [ngModel]="selectedId()" (ngModelChange)="select($event)">
            @for (p of profiles(); track p.id) {
              <option [value]="p.id">{{ p.name }} — v{{ p.version }}{{ p.effectiveTo ? ' (superseded)' : '' }}</option>
            }
          </select>
          <span class="hint versions">
            Effective from {{ draft().effectiveFrom }}{{ draft().effectiveTo ? ' to ' + draft().effectiveTo : '' }}
          </span>
        </div>

        <form class="card" (ngSubmit)="saveProfile()">
          <div class="grid-form">
            <div class="field">
              <label for="p-name">Profile name</label>
              <input id="p-name" class="input" name="name" [(ngModel)]="draft().name" required />
            </div>
            <div class="field">
              <label for="p-scn">SCN lead entity</label>
              <input id="p-scn" class="input" name="scnName" [(ngModel)]="draft().scnName" />
            </div>
            <div class="field">
              <label for="p-days">{{ t()('days') }}</label>
              <input id="p-days" class="input num" name="days" type="number" min="1" step="1" [(ngModel)]="draft().daysCovered" />
            </div>
            <div class="field">
              <label for="p-cap">Cap amount</label>
              <input id="p-cap" class="input num" name="cap" [ngModel]="capText()" (ngModelChange)="capText.set($event)" />
              <span class="hint">Dollars, e.g. 95.00</span>
            </div>
            <div class="field">
              <label for="p-basis">Cap applies</label>
              <select id="p-basis" class="input" name="basis" [(ngModel)]="draft().capBasis">
                <option value="per_member">per member</option>
                <option value="per_order">per order</option>
              </select>
            </div>
            <div class="field">
              <label for="p-eff">Effective from</label>
              <input id="p-eff" class="input" name="eff" type="date" [(ngModel)]="draft().effectiveFrom" />
            </div>
          </div>

          <h2 class="sec" style="margin-top:22px">Servings per member per day</h2>
          <p class="sec-note">
            A 3-member household over {{ draft().daysCovered }} days needs the totals in the last column.
          </p>

          <div class="scroll-x">
            <table class="data">
              <thead>
                <tr>
                  <th>Category</th>
                  <th class="r">Required / member / day</th>
                  <th class="r">Maximum (optional)</th>
                  <th class="r">Min. distinct items</th>
                  <th class="r">Total for 3 members</th>
                </tr>
              </thead>
              <tbody>
                @for (req of draft().requirements; track req.categoryKey) {
                  <tr class="req-row">
                    <td>{{ categoryLabel(req.categoryKey) }}</td>
                    <td class="r">
                      <input
                        class="input num"
                        [ngModel]="servingsText(req.servingsPerMemberPerDayUnits)"
                        [ngModelOptions]="{ standalone: true }"
                        (ngModelChange)="setRequired(req.categoryKey, $event)"
                      />
                    </td>
                    <td class="r">
                      <input
                        class="input num"
                        placeholder="none"
                        [ngModel]="req.maxServingsPerMemberPerDayUnits === null ? '' : servingsText(req.maxServingsPerMemberPerDayUnits)"
                        [ngModelOptions]="{ standalone: true }"
                        (ngModelChange)="setMax(req.categoryKey, $event)"
                      />
                    </td>
                    <td class="r">
                      <input
                        class="input num"
                        type="number"
                        min="0"
                        placeholder="none"
                        [ngModel]="req.minDistinctItems"
                        [ngModelOptions]="{ standalone: true }"
                        (ngModelChange)="setVariety(req.categoryKey, $event)"
                      />
                    </td>
                    <td class="r num">
                      {{ servingsText(req.servingsPerMemberPerDayUnits * 3 * draft().daysCovered) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>

          <h2 class="sec" style="margin-top:22px">Meal splits</h2>
          <p class="sec-note">
            Each category's three meals must total 100%. Fractions round to the nearest quarter
            serving and carry the remainder forward, so the daily total stays exact.
          </p>

          <div class="scroll-x">
            <table class="data">
              <thead>
                <tr>
                  <th>Category</th>
                  @for (meal of meals; track meal) {
                    <th class="r">{{ t()(meal) }}</th>
                  }
                  <th class="r">Total</th>
                </tr>
              </thead>
              <tbody>
                @for (req of draft().requirements; track req.categoryKey) {
                  <tr class="req-row">
                    <td>{{ categoryLabel(req.categoryKey) }}</td>
                    @for (meal of meals; track meal) {
                      <td class="r">
                        <div class="split-cell" style="justify-content:flex-end">
                          <input
                            class="input num"
                            type="number"
                            min="0"
                            max="100"
                            step="0.5"
                            [ngModel]="splitPercent(req.categoryKey, meal)"
                            [ngModelOptions]="{ standalone: true }"
                            (ngModelChange)="setSplit(req.categoryKey, meal, $event)"
                          />
                          <span>%</span>
                        </div>
                      </td>
                    }
                    <td class="r num" [class.total-ok]="splitTotal(req.categoryKey) === 100" [class.total-bad]="splitTotal(req.categoryKey) !== 100">
                      {{ splitTotal(req.categoryKey) }}%
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>

          <h2 class="sec" style="margin-top:22px">Handling</h2>
          <div class="grid-form">
            <div class="field">
              <label>
                <input type="checkbox" [(ngModel)]="draft().allowNonCreditableItems" name="nonCred" />
                Allow items that credit no servings
              </label>
              <span class="hint">Cooking oil, spices. They count against the budget only.</span>
            </div>
            @for (cls of shelfClasses; track cls) {
              <div class="field">
                <label [attr.for]="'h-' + cls">Use {{ cls.replace('_', ' ') }} by day</label>
                <input
                  [id]="'h-' + cls"
                  class="input num"
                  type="number"
                  min="0"
                  placeholder="any day"
                  [ngModel]="draft().shelfLifeHorizonDays[cls]"
                  [ngModelOptions]="{ standalone: true }"
                  (ngModelChange)="setHorizon(cls, $event)"
                />
              </div>
            }
          </div>

          @if (issues().length > 0) {
            <div class="note bad" style="margin-top:16px">
              <h4>This profile cannot be saved yet</h4>
              <ul>
                @for (issue of issues(); track issue.field) {
                  <li>{{ issue.message }}</li>
                }
              </ul>
            </div>
          }

          <!-- FR-2 -->
          <div class="note warn" style="margin-top:16px">
            <h4>Changing the arithmetic creates a new version</h4>
            <p>
              Orders already completed keep the version they were built against. Their totals,
              requirements and printed records do not move.
            </p>
          </div>

          <div class="actions">
            <button class="btn" type="submit" [disabled]="issues().length > 0 || busy()">
              Save as new version
            </button>
            <button class="btn neutral" type="button" [disabled]="busy()" (click)="saveProfile(false)">
              Save name and dates only
            </button>
          </div>
        </form>
      }

      <!-- =================== categories (FR-3) =========================== -->
      @if (pane() === 'categories') {
        <p class="sec-note">
          Renaming a category is safe at any time. The key is what completed orders reference,
          so it cannot change once it has been used.
        </p>

        <div class="scroll-x">
          <table class="data">
            <thead>
              <tr>
                <th>Key</th>
                <th>Label</th>
                <th>Unit</th>
                <th class="r">Order</th>
                <th>Active</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (cat of categoryDrafts(); track cat.id) {
                <tr class="req-row">
                  <td class="num">{{ cat.key }}</td>
                  <td><input class="input" [(ngModel)]="cat.label" [ngModelOptions]="{ standalone: true }" /></td>
                  <td><input class="input" [(ngModel)]="cat.unitLabel" [ngModelOptions]="{ standalone: true }" /></td>
                  <td class="r">
                    <input class="input num" type="number" style="max-width:80px" [(ngModel)]="cat.sortOrder" [ngModelOptions]="{ standalone: true }" />
                  </td>
                  <td>
                    <input type="checkbox" [(ngModel)]="cat.active" [ngModelOptions]="{ standalone: true }" />
                  </td>
                  <td>
                    <button class="btn small" type="button" (click)="saveCategory(cat)">{{ t()('save') }}</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }

      <!-- =================== catalogue items (FR-4, FR-6, FR-7) ========== -->
      @if (pane() === 'items') {
        <div class="actions" style="margin-bottom:14px;margin-top:0">
          <button class="btn" type="button" (click)="newItem()">Add item</button>
          <input
            class="input"
            style="max-width:280px"
            type="search"
            placeholder="Filter items"
            [ngModel]="itemFilter()"
            (ngModelChange)="itemFilter.set($event)"
          />
        </div>

        @if (editing(); as item) {
          <form class="card" style="margin-bottom:18px" (ngSubmit)="saveItem()">
            <h2 class="sec">{{ item.id ? 'Edit item' : 'New item' }}</h2>
            <div class="grid-form">
              <div class="field">
                <label for="i-name">Name</label>
                <input id="i-name" class="input" name="iname" [(ngModel)]="item.name" required />
              </div>
              <div class="field">
                <label for="i-nameEs">Name (Spanish)</label>
                <input id="i-nameEs" class="input" name="inameEs" [(ngModel)]="item.nameEs" />
              </div>
              <div class="field">
                <label for="i-pkg">Package size</label>
                <input id="i-pkg" class="input" name="ipkg" [(ngModel)]="item.packageSize" />
              </div>
              <div class="field">
                <label for="i-cat">Category</label>
                <select id="i-cat" class="input" name="icat" [(ngModel)]="item.categoryKey">
                  @for (cat of state.categories(); track cat.key) {
                    <option [value]="cat.key">{{ cat.label }}</option>
                  }
                </select>
              </div>
              <div class="field">
                <label for="i-price">Price</label>
                <input id="i-price" class="input num" name="iprice" [ngModel]="itemPriceText()" (ngModelChange)="itemPriceText.set($event)" />
              </div>
              <div class="field">
                <label for="i-serv">Creditable servings per package</label>
                <input id="i-serv" class="input num" name="iserv" [ngModel]="itemServingsText()" (ngModelChange)="itemServingsText.set($event)" />
                <span class="hint">0 is allowed — it counts against the budget only.</span>
              </div>
              <div class="field">
                <label for="i-sku">SKU</label>
                <input id="i-sku" class="input num" name="isku" [(ngModel)]="item.sku" />
              </div>
              <div class="field">
                <label for="i-upc">UPC</label>
                <input id="i-upc" class="input num" name="iupc" [(ngModel)]="item.upc" />
              </div>
              <div class="field">
                <label for="i-shelf">Shelf life</label>
                <select id="i-shelf" class="input" name="ishelf" [(ngModel)]="item.shelfLifeClass">
                  @for (cls of shelfClasses; track cls) {
                    <option [value]="cls">{{ cls.replace('_', ' ') }}</option>
                  }
                </select>
              </div>
            </div>

            <div class="field" style="margin-top:12px">
              <span class="label-sm">Tags</span>
              <div class="tagpick">
                @for (tag of tags; track tag) {
                  <label>
                    <input type="checkbox" [checked]="item.tags.includes(tag)" (change)="toggleItemTag(tag)" />
                    {{ tag }}
                  </label>
                }
              </div>
            </div>

            <div class="field" style="margin-top:12px">
              <label>
                <input type="checkbox" [(ngModel)]="item.active" name="iactive" />
                Active
              </label>
              <!-- FR-7 -->
              <span class="hint">
                Items are deactivated, never deleted, because completed orders reference them.
              </span>
            </div>

            <div class="actions">
              <button class="btn" type="submit" [disabled]="busy()">{{ t()('save') }}</button>
              <button class="btn neutral" type="button" (click)="editing.set(null)">{{ t()('cancel') }}</button>
            </div>
          </form>
        }

        <div class="scroll-x">
          <table class="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th class="r">Price</th>
                <th class="r">Servings</th>
                <th>Active</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (item of filteredItems(); track item.id) {
                <tr>
                  <td>{{ item.name }}<br /><span class="versions">{{ item.packageSize }}</span></td>
                  <td>{{ categoryLabel(item.categoryKey) }}</td>
                  <td class="r num">{{ '$' + centsText(item.priceCents) }}</td>
                  <td class="r num">{{ servingsText(item.servingsPerPackageUnits) }}</td>
                  <td>
                    @if (item.active) {
                      <span class="chip ok">{{ t()('active') }}</span>
                    } @else {
                      <span class="chip muted">off</span>
                    }
                  </td>
                  <td><button class="btn small neutral" type="button" (click)="edit(item)">Edit</button></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
})
export class AdminComponent {
  protected readonly state = inject(AppState);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(ApiClient);

  protected readonly t = this.i18n.t;
  protected readonly meals = MEAL_KEYS;
  protected readonly shelfClasses = SHELF_LIFE_CLASSES;
  protected readonly tags = DIETARY_TAGS;
  protected readonly servingsText = (units: number) => formatUnits(units);
  protected readonly centsText = centsToPlain;

  protected readonly pane = signal<Pane>('rules');
  protected readonly profiles = signal<ProgramProfile[]>([]);
  protected readonly selectedId = signal('');
  protected readonly draft = signal<ProgramProfile>(emptyProfile());
  protected readonly capText = signal('');
  protected readonly message = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly categoryDrafts = signal<Category[]>([]);
  protected readonly editing = signal<Item | null>(null);
  protected readonly itemPriceText = signal('');
  protected readonly itemServingsText = signal('');
  protected readonly itemFilter = signal('');

  protected readonly filteredItems = computed(() => {
    const term = this.itemFilter().trim().toLowerCase();
    const items = this.state.items();
    if (!term) return items;
    return items.filter((i) => `${i.name} ${i.sku} ${i.upc}`.toLowerCase().includes(term));
  });

  /** FR-25 and section 5 validation, run against the same shared rules. */
  protected readonly issues = computed(() => {
    const profile = this.draft();
    const capCents = parseMoneyToCents(this.capText());
    return validateProfile({
      name: profile.name,
      daysCovered: Number(profile.daysCovered),
      capAmountCents: capCents ?? 0,
      requirements: profile.requirements,
      mealSplits: profile.mealSplits,
    });
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const profiles = await this.api.profiles();
      this.profiles.set(profiles);
      const current = profiles.find((p) => !p.effectiveTo) ?? profiles[0];
      if (current) this.select(current.id);
      this.categoryDrafts.set(this.state.categories().map((c) => ({ ...c })));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not load rules.');
    }
  }

  protected select(id: string): void {
    const profile = this.profiles().find((p) => p.id === id);
    if (!profile) return;
    this.selectedId.set(id);
    // Deep copy: editing must never mutate the loaded record in place.
    this.draft.set(JSON.parse(JSON.stringify(profile)) as ProgramProfile);
    this.capText.set(centsToPlain(profile.capAmountCents));
  }

  protected categoryLabel(key: string): string {
    return this.state.categories().find((c) => c.key === key)?.label ?? key;
  }

  // --- requirement editing ------------------------------------------------

  private patchRequirement(key: string, patch: Partial<ProgramProfile['requirements'][number]>): void {
    this.draft.update((p) => ({
      ...p,
      requirements: p.requirements.map((r) => (r.categoryKey === key ? { ...r, ...patch } : r)),
    }));
  }

  protected setRequired(key: string, text: string): void {
    const units = parseServingsToUnits(text);
    if (units === null) return;
    this.patchRequirement(key, { servingsPerMemberPerDayUnits: units });
  }

  protected setMax(key: string, text: string): void {
    if (!text.trim()) {
      this.patchRequirement(key, { maxServingsPerMemberPerDayUnits: null });
      return;
    }
    const units = parseServingsToUnits(text);
    if (units === null) return;
    this.patchRequirement(key, { maxServingsPerMemberPerDayUnits: units });
  }

  protected setVariety(key: string, value: number | null | string): void {
    const n = value === '' || value === null ? null : Number(value);
    this.patchRequirement(key, {
      minDistinctItems: n === null || !Number.isFinite(n) ? null : Math.max(0, Math.trunc(n)),
    });
  }

  // --- meal splits (FR-25) -------------------------------------------------

  protected splitPercent(categoryKey: string, meal: MealKey): number {
    const split = this.draft().mealSplits.find(
      (s) => s.categoryKey === categoryKey && s.meal === meal,
    );
    return split ? split.fractionBp / 100 : 0;
  }

  protected splitTotal(categoryKey: string): number {
    const total = this.draft()
      .mealSplits.filter((s) => s.categoryKey === categoryKey)
      .reduce((sum, s) => sum + s.fractionBp, 0);
    return Math.round(total / 100);
  }

  protected setSplit(categoryKey: string, meal: MealKey, percent: number | string): void {
    const value = Number(percent);
    if (!Number.isFinite(value) || value < 0) return;
    // Stored as integer basis points so the allocator stays integer-only.
    const bp = Math.round(value * 100);
    this.draft.update((p) => {
      const exists = p.mealSplits.some((s) => s.categoryKey === categoryKey && s.meal === meal);
      return {
        ...p,
        mealSplits: exists
          ? p.mealSplits.map((s) =>
              s.categoryKey === categoryKey && s.meal === meal ? { ...s, fractionBp: bp } : s,
            )
          : [...p.mealSplits, { categoryKey, meal, fractionBp: bp }],
      };
    });
  }

  protected setHorizon(cls: ShelfLifeClass, value: number | string | null): void {
    const n = value === '' || value === null ? null : Number(value);
    this.draft.update((p) => ({
      ...p,
      shelfLifeHorizonDays: {
        ...p.shelfLifeHorizonDays,
        [cls]: n === null || !Number.isFinite(n) ? null : Math.max(0, Math.trunc(n)),
      },
    }));
  }

  // --- saving --------------------------------------------------------------

  protected async saveProfile(newVersion = true): Promise<void> {
    const capCents = parseMoneyToCents(this.capText());
    if (capCents === null) {
      this.error.set('Cap amount is not a valid dollar figure.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const payload: ProgramProfile = {
        ...this.draft(),
        capAmountCents: capCents,
        daysCovered: Number(this.draft().daysCovered),
      };
      const result = await this.api.saveProfile(payload, newVersion);
      this.message.set(
        newVersion
          ? `Saved as version ${result.profile.version}. Completed orders are unaffected.`
          : 'Saved.',
      );
      this.profiles.set(await this.api.profiles());
      this.select(result.profile.id);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not save.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async saveCategory(category: Category): Promise<void> {
    try {
      await this.api.saveCategory(category);
      this.message.set(`Saved ${category.label}.`);
      this.state.categories.update((list) =>
        list.map((c) => (c.id === category.id ? { ...category } : c)),
      );
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not save the category.');
    }
  }

  protected newItem(): void {
    const firstCategory = this.state.categories()[0]?.key ?? '';
    this.editing.set({
      id: '',
      name: '',
      nameEs: '',
      packageSize: '',
      categoryKey: firstCategory,
      priceCents: 0,
      servingsPerPackageUnits: 0,
      sku: '',
      upc: '',
      tags: [],
      shelfLifeClass: 'shelf_stable',
      active: true,
      updatedAt: '',
    });
    this.itemPriceText.set('');
    this.itemServingsText.set('');
  }

  protected edit(item: Item): void {
    this.editing.set({ ...item, tags: [...item.tags] });
    this.itemPriceText.set(centsToPlain(item.priceCents));
    this.itemServingsText.set(String(unitsToServings(item.servingsPerPackageUnits)));
  }

  protected toggleItemTag(tag: DietaryTag): void {
    this.editing.update((item) =>
      item === null
        ? null
        : {
            ...item,
            tags: item.tags.includes(tag)
              ? item.tags.filter((x) => x !== tag)
              : [...item.tags, tag],
          },
    );
  }

  protected async saveItem(): Promise<void> {
    const item = this.editing();
    if (!item) return;

    const priceCents = parseMoneyToCents(this.itemPriceText());
    const servings = parseServingsToUnits(this.itemServingsText());
    if (priceCents === null || priceCents < 0) {
      this.error.set('Price is not a valid dollar figure.');
      return;
    }
    if (servings === null || servings < 0) {
      this.error.set('Servings per package is not a valid number.');
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await this.api.saveItem({
        ...item,
        id: item.id || undefined,
        priceCents,
        servingsPerPackageUnits: servings,
      });
      // FR-6: the change applies to new orders only. Orders in progress keep
      // the price they captured, which is why nothing here touches them.
      this.message.set(`Saved ${result.item.name}. New orders will use this price.`);
      this.editing.set(null);
      this.state.items.set(await this.api.items());
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not save the item.');
    } finally {
      this.busy.set(false);
    }
  }
}

function emptyProfile(): ProgramProfile {
  return {
    id: '',
    familyId: '',
    version: 1,
    name: '',
    scnName: '',
    effectiveFrom: new Date().toISOString().slice(0, 10),
    effectiveTo: null,
    daysCovered: 7,
    capAmountCents: 0,
    capBasis: 'per_member',
    requirements: [],
    mealSplits: [],
    allowNonCreditableItems: true,
    shelfLifeHorizonDays: { fresh: 2, refrigerated: 4, frozen: null, shelf_stable: null },
    archived: false,
    createdAt: '',
  };
}
