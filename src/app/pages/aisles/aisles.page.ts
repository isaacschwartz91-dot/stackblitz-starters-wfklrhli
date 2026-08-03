/**
 * The shelf walking order — the physical path a picker takes through the store.
 * Everything on the pick list is sorted by this.
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';

import { DataService, messageOf } from '../../core/data.service';
import { ToastService } from '../../core/toast.service';
import type { Aisle } from '../../core/models';
import { aisleKey } from '../../matching/pick-list';
import { SheetImport } from '../../import/sheet-import';

@Component({
  selector: 'app-aisles',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SheetImport],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Walking order</h1>
          <p>
            Top to bottom is the order a picker walks the store. Every pick list is sorted by this,
            then by each product's shelf sequence.
          </p>
        </div>
        <span class="spacer"></span>
        <div class="button-row">
          <button type="button" (click)="addRow()">Add aisle</button>
          <button type="button" (click)="showImport.set(!showImport())">
            {{ showImport() ? 'Hide upload' : 'Upload sheet' }}
          </button>
        </div>
      </div>

      @if (showImport() || data.aisles().length === 0) {
        <div style="margin-bottom: 1rem"><app-sheet-import /></div>
      }

      @if (missing().length > 0) {
        <div class="notice warn">
          <strong>{{ missing().length }} aisle code(s) used by products are not in this list:</strong>
          {{ missing().join(', ') }}. They sort after every known aisle.
          <div class="button-row" style="margin-top: 0.5rem">
            <button type="button" class="small" (click)="addMissing()">Add them to the end</button>
          </div>
        </div>
      }

      @if (draft().length === 0) {
        <div class="card empty">
          <h3>No walking order yet</h3>
          <p class="muted">
            Upload your Sheet B, or add aisles by hand in the order you walk them.
          </p>
          <button type="button" class="primary" (click)="addRow()">Add the first aisle</button>
        </div>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th style="width: 5rem" class="num">Step</th>
                <th style="width: 9rem">Aisle code</th>
                <th>Aisle name</th>
                <th style="width: 7rem" class="num">Products</th>
                <th style="width: 10rem"></th>
              </tr>
            </thead>
            <tbody>
              @for (aisle of draft(); track aisle.id + '@' + $index; let index = $index) {
                <tr>
                  <td class="num tabular">{{ index + 1 }}</td>
                  <td>
                    <input
                      type="text"
                      [value]="aisle.id"
                      (input)="patch(index, { id: value($event) })"
                      aria-label="Aisle code"
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      [value]="aisle.name"
                      (input)="patch(index, { name: value($event) })"
                      placeholder="Produce, Bakery, Dairy…"
                      aria-label="Aisle name"
                    />
                  </td>
                  <td class="num tabular small dim">{{ productCount(aisle.id) }}</td>
                  <td>
                    <div class="button-row" style="gap: 0.2rem; justify-content: flex-end">
                      <button
                        type="button"
                        class="small"
                        (click)="move(index, -1)"
                        [disabled]="index === 0"
                        aria-label="Move earlier"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        class="small"
                        (click)="move(index, 1)"
                        [disabled]="index === draft().length - 1"
                        aria-label="Move later"
                      >
                        ↓
                      </button>
                      <button type="button" class="small danger" (click)="removeRow(index)">✕</button>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        <div class="sticky-actions">
          <button type="button" class="primary" (click)="save()" [disabled]="!dirty() || saving()">
            {{ saving() ? 'Saving…' : 'Save walking order' }}
          </button>
          <button type="button" class="ghost" (click)="reset()" [disabled]="!dirty()">
            Discard changes
          </button>
          <span class="spacer"></span>
          @if (dirty()) {
            <span class="small" style="color: var(--warn)">Unsaved changes</span>
          }
        </div>
      }
    </div>
  `,
})
export class AislesPage {
  protected readonly data = inject(DataService);
  private readonly toast = inject(ToastService);

  protected readonly showImport = signal(false);
  protected readonly saving = signal(false);
  protected readonly draft = signal<Aisle[]>(this.data.sortedAisles().map((aisle) => ({ ...aisle })));
  private readonly baseline = signal(JSON.stringify(this.data.sortedAisles()));

  protected readonly dirty = computed(
    () => JSON.stringify(this.normalized()) !== this.baseline(),
  );

  /** Aisle codes that products use but the walking order does not list. */
  protected readonly missing = computed(() => {
    const known = new Set(this.draft().map((aisle) => aisleKey(aisle.id)));
    const codes = new Set<string>();
    for (const item of this.data.items()) {
      const key = aisleKey(item.aisle);
      if (key !== '' && !known.has(key)) codes.add(item.aisle.trim());
    }
    return [...codes].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  });

  constructor() {
    // An upload from the panel above changes the stored aisles under us. Adopt
    // the new list, but never over the top of edits that are not saved yet.
    effect(() => {
      const latest = JSON.stringify(this.data.sortedAisles());
      if (latest === this.baseline() || this.dirty()) return;
      this.draft.set(this.data.sortedAisles().map((aisle) => ({ ...aisle })));
      this.baseline.set(latest);
    });
  }

  private normalized(): Aisle[] {
    return this.draft().map((aisle, index) => ({ ...aisle, sequence: index + 1 }));
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected productCount(code: string): number {
    const key = aisleKey(code);
    return this.data.items().filter((item) => aisleKey(item.aisle) === key).length;
  }

  protected patch(index: number, patch: Partial<Aisle>): void {
    this.draft.set(
      this.draft().map((aisle, position) => (position === index ? { ...aisle, ...patch } : aisle)),
    );
  }

  protected addRow(): void {
    this.draft.set([...this.draft(), { id: '', sequence: this.draft().length + 1, name: '' }]);
  }

  protected addMissing(): void {
    const added = this.missing().map((code, offset) => ({
      id: code,
      sequence: this.draft().length + offset + 1,
      name: '',
    }));
    this.draft.set([...this.draft(), ...added]);
  }

  protected removeRow(index: number): void {
    this.draft.set(this.draft().filter((_aisle, position) => position !== index));
  }

  protected move(index: number, delta: number): void {
    const next = [...this.draft()];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    this.draft.set(next);
  }

  protected reset(): void {
    this.draft.set(this.data.sortedAisles().map((aisle) => ({ ...aisle })));
  }

  protected async save(): Promise<void> {
    const rows = this.normalized().filter((aisle) => aisle.id.trim() !== '');
    const codes = new Set<string>();
    for (const aisle of rows) {
      const key = aisleKey(aisle.id);
      if (codes.has(key)) {
        this.toast.error(`Aisle code "${aisle.id}" appears twice. Codes must be unique.`);
        return;
      }
      codes.add(key);
    }

    this.saving.set(true);
    try {
      await this.data.replaceAisles(rows);
      this.draft.set(this.data.sortedAisles().map((aisle) => ({ ...aisle })));
      this.baseline.set(JSON.stringify(this.data.sortedAisles()));
      this.toast.ok('Walking order saved.');
    } catch (cause) {
      this.toast.error(messageOf(cause));
    } finally {
      this.saving.set(false);
    }
  }
}
