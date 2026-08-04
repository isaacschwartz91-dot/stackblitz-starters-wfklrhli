/**
 * Upload screen for the two spreadsheets.
 *
 * Accepts one file or several, in .xlsx / .xls / .csv. Every sheet inside is
 * detected, given a best-guess role and column mapping, and shown as a preview
 * before anything is written — so a wrong guess costs a dropdown, not a
 * corrupted catalog. Re-importing updates rows by item id; it never duplicates.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { DataService, messageOf } from '../core/data.service';
import { ToastService } from '../core/toast.service';
import { SelectValue } from '../ui/select-value';
import type { Aisle, Customer, Item } from '../core/models';
import {
  AISLE_FIELD_LABELS,
  CUSTOMER_FIELD_LABELS,
  ITEM_FIELD_LABELS,
  buildAisles,
  buildCustomers,
  buildItems,
  guessAisleMapping,
  guessCustomerMapping,
  guessItemMapping,
  guessSheetRole,
  readWorkbook,
  type SheetField,
  type SheetRole,
  type SheetTable,
} from './sheet-parse';

interface SheetPlan {
  id: string;
  fileName: string;
  table: SheetTable;
  role: SheetRole;
  mapping: SheetField[];
  /** Sheet B, Option 2: the rows are already in walking order. */
  rowOrderIsWalkingOrder: boolean;
}

@Component({
  selector: 'app-sheet-import',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SelectValue],
  template: `
    <div class="card">
      <div class="card-head">
        <h2>Upload spreadsheets</h2>
        <span class="spacer"></span>
        @if (plans().length > 0) {
          <button type="button" class="ghost small" (click)="reset()">Start over</button>
        }
      </div>

      @if (plans().length === 0) {
        <p class="muted small">
          Excel (.xlsx / .xls) or CSV. Your master item list and your shelf walking order can be two
          files, two tabs of one workbook, or a single combined sheet — all three work.
        </p>
        <input
          type="file"
          accept=".xlsx,.xls,.csv,.txt"
          multiple
          (change)="onFiles($event)"
          aria-label="Choose spreadsheet files"
        />
        @if (reading()) {
          <p class="small muted" style="margin-top: 0.6rem">Reading…</p>
        }
      } @else {
        @for (plan of plans(); track plan.id) {
          <div
            class="card tight"
            style="margin-bottom: 0.75rem; box-shadow: none; background: var(--surface-2)"
          >
            <div class="card-head">
              <strong>{{ plan.fileName }} → {{ plan.table.name }}</strong>
              <span class="chip">{{ plan.table.rows.length }} rows</span>
              <span class="spacer"></span>
              <label class="field" style="margin: 0; min-width: 190px">
                <span>Treat this sheet as</span>
                <select [selectValue]="plan.role" (change)="setRole(plan, value($event))">
                  <option value="items">Master item list (products)</option>
                  <option value="aisles">Aisle walking order</option>
                  <option value="customers">Customer list</option>
                  <option value="skip">Skip this sheet</option>
                </select>
              </label>
            </div>

            @if (plan.role !== 'skip') {
              @if (plan.role === 'customers') {
                <div class="notice ok" style="margin: 0 0 0.6rem">
                  Customers are matched by name (or by an ID column if the sheet has one), so
                  re-uploading updates the people you already have instead of duplicating them.
                  Their learned shorthand and past orders stay attached.
                </div>
              }
              @if (plan.role === 'items') {
                <div class="notice ok" style="margin: 0 0 0.6rem">
                  {{ orderExplanation(plan) }}
                </div>
                @if (hasSequenceColumn(plan)) {
                  <label class="check" style="margin-bottom: 0.6rem">
                    <input
                      type="checkbox"
                      [checked]="plan.rowOrderIsWalkingOrder"
                      (change)="toggleRowOrder(plan)"
                    />
                    <span>
                      Ignore that column and use <strong>the row order of this sheet</strong> instead
                    </span>
                  </label>
                }
              }

              <div class="table-wrap" style="max-height: 340px; overflow: auto">
                <table>
                  <thead>
                    <tr>
                      @for (header of plan.table.headers; track $index) {
                        <th style="min-width: 9rem">
                          <div class="small" style="text-transform: none; color: var(--ink-2)">
                            {{ header || '(no header)' }}
                          </div>
                          <select
                            [selectValue]="plan.mapping[$index]"
                            (change)="setMapping(plan, $index, value($event))"
                          >
                            @for (option of fieldOptions(plan.role); track option.key) {
                              <option [value]="option.key">{{ option.label }}</option>
                            }
                          </select>
                        </th>
                      }
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of plan.table.rows.slice(0, 5); track $index) {
                      <tr>
                        @for (cell of row; track $index) {
                          <td class="small">{{ cell }}</td>
                        }
                      </tr>
                    }
                  </tbody>
                </table>
              </div>

              @if (planProblem(plan); as problem) {
                <div class="notice danger" style="margin: 0.6rem 0 0">{{ problem }}</div>
              } @else if (planWarning(plan); as warning) {
                <div class="notice warn" style="margin: 0.6rem 0 0">{{ warning }}</div>
              }
            }
          </div>
        }

        <div class="notice">
          <strong>{{ summary() }}</strong>
          <div class="small muted">
            Existing products are updated by item ID; new ones are added. Nothing is duplicated. The
            walking order is replaced by what you upload.
          </div>
        </div>

        <div class="button-row">
          <button type="button" class="primary" (click)="commit()" [disabled]="busy() || !canCommit()">
            {{ busy() ? 'Importing…' : 'Import' }}
          </button>
          <button type="button" class="ghost" (click)="reset()">Cancel</button>
        </div>
      }
    </div>
  `,
})
export class SheetImport {
  private readonly data = inject(DataService);
  private readonly toast = inject(ToastService);

  protected readonly plans = signal<SheetPlan[]>([]);
  protected readonly reading = signal(false);
  protected readonly busy = signal(false);

  protected readonly canCommit = computed(() =>
    this.plans().some((plan) => plan.role !== 'skip' && this.planProblem(plan) === null),
  );

  protected value(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected async onFiles(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    if (files.length === 0) return;

    this.reading.set(true);
    const plans: SheetPlan[] = [];
    try {
      for (const file of files) {
        const workbook = await readWorkbook(file);
        for (const table of workbook.tables) {
          const role = guessSheetRole(table);
          plans.push({
            id: `${workbook.fileName}:${table.name}`,
            fileName: workbook.fileName,
            table,
            role,
            mapping: this.mappingFor(role, table.headers),
            rowOrderIsWalkingOrder: false,
          });
        }
      }
      if (plans.length === 0) this.toast.warn('No readable sheets in that file.');
      this.plans.set(plans);
    } catch (cause) {
      this.toast.error(`Could not read the file: ${messageOf(cause)}`);
    } finally {
      this.reading.set(false);
      input.value = '';
    }
  }

  protected fieldOptions(role: SheetRole): Array<{ key: string; label: string }> {
    const labels =
      role === 'aisles'
        ? AISLE_FIELD_LABELS
        : role === 'customers'
          ? CUSTOMER_FIELD_LABELS
          : ITEM_FIELD_LABELS;
    return Object.entries(labels).map(([key, label]) => ({ key, label }));
  }

  private mappingFor(role: SheetRole, headers: string[]): SheetField[] {
    if (role === 'aisles') return guessAisleMapping(headers);
    if (role === 'customers') return guessCustomerMapping(headers);
    return guessItemMapping(headers);
  }

  private update(plan: SheetPlan, patch: Partial<SheetPlan>): void {
    this.plans.set(this.plans().map((entry) => (entry.id === plan.id ? { ...entry, ...patch } : entry)));
  }

  protected setRole(plan: SheetPlan, role: string): void {
    const next = role as SheetRole;
    this.update(plan, { role: next, mapping: this.mappingFor(next, plan.table.headers) });
  }

  protected setMapping(plan: SheetPlan, column: number, field: string): void {
    const mapping = [...plan.mapping];
    // A field can only come from one column, so clear any previous holder.
    if (field !== 'ignore') {
      for (let index = 0; index < mapping.length; index += 1) {
        if (mapping[index] === field) mapping[index] = 'ignore';
      }
    }
    mapping[column] = field as SheetField;
    this.update(plan, { mapping });
  }

  protected toggleRowOrder(plan: SheetPlan): void {
    this.update(plan, { rowOrderIsWalkingOrder: !plan.rowOrderIsWalkingOrder });
  }

  protected hasSequenceColumn(plan: SheetPlan): boolean {
    return plan.mapping.includes('shelf_sequence');
  }

  /**
   * Plain English for what the pick list will follow. This is the sentence the
   * store owner should be able to read once and stop worrying.
   */
  protected orderExplanation(plan: SheetPlan): string {
    const hasAisle = plan.mapping.includes('aisle');
    const bySequence = this.hasSequenceColumn(plan) && !plan.rowOrderIsWalkingOrder;

    const positions = bySequence
      ? 'Shelf positions come from the sequence column.'
      : `Pick lists will follow this sheet's row order, top to bottom — row 1 is the first stop on the walk.`;
    const grouping = hasAisle
      ? ' Aisles are taken from the aisle column, in the order they first appear here.'
      : ' No aisle column, so the walk is one continuous run with no headings.';

    return positions + grouping;
  }

  /** What blocks this sheet from importing at all, or null when it is ready. */
  protected planProblem(plan: SheetPlan): string | null {
    if (plan.role === 'skip') return null;
    if (plan.role === 'items') {
      return plan.mapping.includes('item_name') ? null : 'Choose which column holds the product name.';
    }
    if (plan.role === 'customers') {
      return plan.mapping.includes('customer_name')
        ? null
        : 'Choose which column holds the customer name.';
    }
    return plan.mapping.includes('aisle') ? null : 'Choose which column holds the aisle code.';
  }

  /** Things worth knowing that do not stop the import. */
  protected planWarning(plan: SheetPlan): string | null {
    if (plan.role !== 'items' || this.planProblem(plan) !== null) return null;
    if (!plan.mapping.includes('aisle')) {
      return 'Want the walk broken into named stretches? Point one column at "Aisle" above — any section or department name will do. Not required.';
    }
    return null;
  }

  protected summary(): string {
    let items = 0;
    let aisles = 0;
    let customers = 0;
    for (const plan of this.plans()) {
      if (plan.role === 'items') items += plan.table.rows.length;
      if (plan.role === 'aisles') aisles += plan.table.rows.length;
      if (plan.role === 'customers') customers += plan.table.rows.length;
    }
    const parts: string[] = [];
    if (items > 0) parts.push(`${items} product rows`);
    if (aisles > 0) parts.push(`${aisles} aisle rows`);
    if (customers > 0) parts.push(`${customers} customer rows`);
    return parts.length === 0 ? 'Nothing selected to import.' : `Ready to import ${parts.join(' and ')}.`;
  }

  protected reset(): void {
    this.plans.set([]);
  }

  protected async commit(): Promise<void> {
    this.busy.set(true);
    try {
      const items: Item[] = [];
      const customers: Customer[] = [];
      let aisles: Aisle[] | null = null;
      let derivedAisles: Aisle[] | null = null;
      let generatedIds = 0;
      let skipped = 0;
      let usedRowOrder = false;

      for (const plan of this.plans()) {
        if (this.planProblem(plan) !== null) continue;
        if (plan.role === 'items') {
          const result = buildItems(plan.table, plan.mapping, {
            rowOrderIsWalkingOrder: plan.rowOrderIsWalkingOrder,
          });
          items.push(...result.items);
          generatedIds += result.generatedIds;
          skipped += result.skipped;
          usedRowOrder = usedRowOrder || result.usedRowOrder;
          if (result.derivedAisles.length > 0) derivedAisles = result.derivedAisles;
        } else if (plan.role === 'aisles') {
          const result = buildAisles(plan.table, plan.mapping);
          aisles = [...(aisles ?? []), ...result.aisles];
          skipped += result.skipped;
        } else if (plan.role === 'customers') {
          const result = buildCustomers(plan.table, plan.mapping, this.data.customers());
          customers.push(...result.customers);
          skipped += result.skipped;
        }
      }

      const before = new Set(this.data.items().map((item) => item.id));
      const customersBefore = new Set(this.data.customers().map((customer) => customer.id));
      if (items.length > 0) await this.data.saveItems(items);
      if (customers.length > 0) await this.data.saveCustomers(customers);

      // An explicit Sheet B always wins over an order derived from row position.
      const finalAisles = aisles ?? derivedAisles;
      if (finalAisles !== null && finalAisles.length > 0) {
        await this.data.replaceAisles(
          finalAisles.map((aisle, position) => ({ ...aisle, sequence: position + 1 })),
        );
      }

      const added = items.filter((item) => !before.has(item.id)).length;
      const updated = items.length - added;
      const newCustomers = customers.filter((customer) => !customersBefore.has(customer.id)).length;
      const notes = [
        added > 0 ? `${added} new products` : '',
        updated > 0 ? `${updated} updated` : '',
        newCustomers > 0 ? `${newCustomers} new customers` : '',
        customers.length - newCustomers > 0 ? `${customers.length - newCustomers} customers updated` : '',
        finalAisles !== null && finalAisles.length > 0 ? `${finalAisles.length} aisles` : '',
        items.length > 0
          ? usedRowOrder
            ? 'walk follows the sheet order'
            : 'walk follows the sequence column'
          : '',
        skipped > 0 ? `${skipped} rows skipped` : '',
      ].filter((note) => note !== '');

      this.toast.ok(`Imported: ${notes.join(' · ')}`);
      this.reset();
    } catch (cause) {
      this.toast.error(`Import failed: ${messageOf(cause)}`);
    } finally {
      this.busy.set(false);
    }
  }
}
