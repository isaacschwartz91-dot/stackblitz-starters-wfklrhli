import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthService } from '../../core/auth.service';
import { DataService, messageOf } from '../../core/data.service';
import { ToastService } from '../../core/toast.service';
import { newId } from '../../core/ids';
import type { Item } from '../../core/models';
import { emptyItem } from '../../core/models';
import { searchItems } from '../../matching/matcher';
import { aisleKey, aisleLabel } from '../../matching/pick-list';
import { SheetImport } from '../../import/sheet-import';
import { SelectValue } from '../../ui/select-value';

const PAGE_SIZE = 60;

@Component({
  selector: 'app-catalog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, SheetImport, SelectValue],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Catalog</h1>
          <p>
            {{ data.items().length }} products. Edit anything here — a typo or a wrong aisle does not
            need a re-upload.
          </p>
        </div>
        <span class="spacer"></span>
        <div class="button-row">
          <button type="button" (click)="startNew()">Add product</button>
          <button type="button" (click)="exportCsv()" [disabled]="data.items().length === 0">
            Export CSV
          </button>
          <button type="button" (click)="showImport.set(!showImport())">
            {{ showImport() ? 'Hide upload' : 'Upload sheets' }}
          </button>
        </div>
      </div>

      @if (!auth.isAdmin()) {
        <div class="notice warn">
          You are signed in as staff. Catalog changes are limited to admins.
        </div>
      }

      @if (showImport() || data.items().length === 0) {
        <div style="margin-bottom: 1rem"><app-sheet-import /></div>
      }

      @if (data.unmappedAisles().length > 0) {
        <div class="notice warn">
          These aisle codes are on products but missing from the walking order:
          <strong>{{ data.unmappedAisles().join(', ') }}</strong>. They will be picked last.
          <a routerLink="/aisles">Fix the walking order</a>
        </div>
      }

      <div class="card" style="margin-bottom: 1rem">
        <div class="inline-fields">
          <label class="field" style="margin: 0; flex: 3 1 260px">
            <span>Search products</span>
            <input
              type="search"
              placeholder="Name, brand, size, barcode…"
              [value]="query()"
              (input)="setQuery(value($event))"
            />
          </label>
          <label class="field" style="margin: 0">
            <span>Aisle</span>
            <select [selectValue]="aisleFilter()" (change)="setAisle(value($event))">
              <option value="">All aisles</option>
              <option value="__none__">No aisle set</option>
              @for (aisle of data.sortedAisles(); track aisle.id) {
                <option [value]="aisle.id">{{ label(aisle.id, aisle.name) }}</option>
              }
            </select>
          </label>
          <label class="field" style="margin: 0">
            <span>Department</span>
            <select [selectValue]="departmentFilter()" (change)="setDepartment(value($event))">
              <option value="">All</option>
              @for (department of departments(); track department) {
                <option [value]="department">{{ department }}</option>
              }
            </select>
          </label>
        </div>
      </div>

      @if (filtered().length > 0 && isFiltered()) {
        <p class="small dim" style="margin: -0.4rem 0 0.6rem">
          {{ filtered().length }} of {{ data.items().length }} products match. Showing
          {{ visible().length }}.
        </p>
      }

      @if (filtered().length === 0) {
        <div class="card empty">
          <h3>No products{{ data.items().length === 0 ? ' yet' : ' match' }}</h3>
          <p class="muted">
            {{
              data.items().length === 0
                ? 'Upload your master item list to get started.'
                : 'Try a different search.'
            }}
          </p>
        </div>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th style="width: 8rem">Brand</th>
                <th style="width: 7rem">Size</th>
                <th style="width: 6rem">Aisle</th>
                <th style="width: 6rem" class="num">Shelf</th>
                <th style="width: 6rem" class="num">Price</th>
                <th style="width: 5rem"></th>
              </tr>
            </thead>
            <tbody>
              @for (item of visible(); track item.id) {
                <tr>
                  <td>
                    <div class="name">{{ item.name }}</div>
                    <div class="small dim">{{ item.department }} · {{ item.id }}</div>
                  </td>
                  <td class="small">{{ item.brand }}</td>
                  <td class="small">{{ item.size }}</td>
                  <td class="small">
                    @if (item.aisle) {
                      {{ aisleName(item.aisle) }}
                    } @else if (item.shelfSequence !== null) {
                      <span class="chip">shelf order</span>
                    } @else {
                      <span class="chip warn">none</span>
                    }
                  </td>
                  <td class="num small tabular">{{ item.shelfSequence ?? '—' }}</td>
                  <td class="num small tabular">{{ item.price ?? '—' }}</td>
                  <td>
                    <button type="button" class="small" (click)="edit(item)">Edit</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        @if (filtered().length > visible().length) {
          <div class="button-row" style="margin-top: 0.8rem; justify-content: center">
            <button type="button" (click)="showMore()">
              Show more ({{ filtered().length - visible().length }} left)
            </button>
          </div>
        }
      }
    </div>

    @if (editing(); as item) {
      <div class="modal-backdrop" (click)="editing.set(null)">
        <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
          <h2>{{ isNewItem() ? 'Add product' : 'Edit product' }}</h2>

          <div class="inline-fields">
            <label class="field" style="flex: 2 1 260px">
              <span>Product name</span>
              <input type="text" [value]="item.name" (input)="patch({ name: value($event) })" />
            </label>
            <label class="field">
              <span>Item ID</span>
              <input
                type="text"
                [value]="item.id"
                [disabled]="!isNewItem()"
                (input)="patch({ id: value($event) })"
              />
            </label>
          </div>

          <div class="inline-fields">
            <label class="field">
              <span>Brand</span>
              <input type="text" [value]="item.brand" (input)="patch({ brand: value($event) })" />
            </label>
            <label class="field">
              <span>Size</span>
              <input type="text" [value]="item.size" (input)="patch({ size: value($event) })" />
            </label>
            <label class="field">
              <span>Department</span>
              <input
                type="text"
                [value]="item.department"
                (input)="patch({ department: value($event) })"
              />
            </label>
          </div>

          <div class="inline-fields">
            <label class="field">
              <span>Aisle</span>
              <input type="text" [value]="item.aisle" (input)="patch({ aisle: value($event) })" />
            </label>
            <label class="field">
              <span>Shelf sequence</span>
              <input
                type="number"
                step="0.1"
                [value]="item.shelfSequence ?? ''"
                (input)="patch({ shelfSequence: numberOrNull($event) })"
              />
            </label>
            <label class="field">
              <span>Unit</span>
              <input type="text" [value]="item.unit" (input)="patch({ unit: value($event) })" />
            </label>
          </div>

          <div class="inline-fields">
            <label class="field">
              <span>Price</span>
              <input
                type="number"
                step="0.01"
                [value]="item.price ?? ''"
                (input)="patch({ price: numberOrNull($event) })"
              />
            </label>
            <label class="field">
              <span>Barcode</span>
              <input type="text" [value]="item.barcode" (input)="patch({ barcode: value($event) })" />
            </label>
          </div>

          <label class="check" style="margin-bottom: 1rem">
            <input type="checkbox" [checked]="item.active" (change)="patch({ active: !item.active })" />
            <span>In the catalog (uncheck to hide it from matching)</span>
          </label>

          <div class="button-row">
            <button type="button" class="primary" (click)="save()" [disabled]="!item.name.trim()">
              Save
            </button>
            <button type="button" class="ghost" (click)="editing.set(null)">Cancel</button>
            <span class="spacer"></span>
            @if (!isNewItem()) {
              <button type="button" class="danger" (click)="remove(item)">Delete</button>
            }
          </div>
        </div>
      </div>
    }
  `,
})
export class CatalogPage {
  protected readonly data = inject(DataService);
  protected readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly query = signal('');
  protected readonly aisleFilter = signal('');
  protected readonly departmentFilter = signal('');
  protected readonly limit = signal(PAGE_SIZE);
  protected readonly showImport = signal(false);

  protected readonly editing = signal<Item | null>(null);
  protected readonly isNewItem = signal(false);

  protected readonly departments = computed(() =>
    [...new Set(this.data.items().map((item) => item.department).filter((name) => name !== ''))].sort(),
  );

  protected readonly filtered = computed(() => {
    const text = this.query().trim();
    const aisle = this.aisleFilter();
    const department = this.departmentFilter();

    // Free-text search runs through the same matcher the order screen uses, so
    // what staff find here is what an order line would find. No cap: searching
    // a 9,000-product catalog for "milk" has to return every milk, and the
    // table below pages through them 60 at a time.
    let pool: Item[] =
      text === ''
        ? this.data.items()
        : searchItems(this.data.matchIndex(), text).map((candidate) => candidate.item);

    if (text !== '') {
      const loose = text.toLowerCase();
      const extras = this.data
        .items()
        .filter(
          (item) =>
            item.id.toLowerCase() === loose ||
            (item.barcode !== '' && item.barcode.toLowerCase() === loose),
        );
      pool = [...new Map([...extras, ...pool].map((item) => [item.id, item])).values()];
    }

    if (aisle === '__none__') pool = pool.filter((item) => aisleKey(item.aisle) === '');
    else if (aisle !== '') pool = pool.filter((item) => aisleKey(item.aisle) === aisleKey(aisle));
    if (department !== '') pool = pool.filter((item) => item.department === department);

    return text === ''
      ? [...pool].sort(
          (a, b) =>
            a.aisle.localeCompare(b.aisle, undefined, { numeric: true }) ||
            (a.shelfSequence ?? 0) - (b.shelfSequence ?? 0) ||
            a.name.localeCompare(b.name),
        )
      : pool;
  });

  protected readonly visible = computed(() => this.filtered().slice(0, this.limit()));

  /** True when a search or filter is narrowing the list, so a count is worth showing. */
  protected readonly isFiltered = computed(
    () =>
      this.query().trim() !== '' || this.aisleFilter() !== '' || this.departmentFilter() !== '',
  );

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected numberOrNull(event: Event): number | null {
    const raw = this.value(event).trim();
    if (raw === '') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  protected setQuery(text: string): void {
    this.query.set(text);
    this.limit.set(PAGE_SIZE);
  }

  protected setAisle(aisle: string): void {
    this.aisleFilter.set(aisle);
    this.limit.set(PAGE_SIZE);
  }

  protected setDepartment(department: string): void {
    this.departmentFilter.set(department);
    this.limit.set(PAGE_SIZE);
  }

  protected showMore(): void {
    this.limit.set(this.limit() + PAGE_SIZE * 2);
  }

  protected label(code: string, name: string): string {
    return aisleLabel(code, name);
  }

  protected aisleName(code: string): string {
    const aisle = this.data.aisles().find((entry) => aisleKey(entry.id) === aisleKey(code));
    return aisleLabel(code, aisle?.name ?? '');
  }

  protected startNew(): void {
    this.editing.set(emptyItem(newId('item')));
    this.isNewItem.set(true);
  }

  protected edit(item: Item): void {
    this.editing.set({ ...item });
    this.isNewItem.set(false);
  }

  protected patch(patch: Partial<Item>): void {
    const current = this.editing();
    if (current === null) return;
    this.editing.set({ ...current, ...patch });
  }

  protected async save(): Promise<void> {
    const item = this.editing();
    if (item === null || item.name.trim() === '') return;
    try {
      await this.data.saveItems([item]);
      this.toast.ok(`Saved ${item.name}.`);
      this.editing.set(null);
    } catch (cause) {
      this.toast.error(messageOf(cause));
    }
  }

  protected async remove(item: Item): Promise<void> {
    if (!confirm(`Delete ${item.name} from the catalog?`)) return;
    try {
      await this.data.deleteItems([item.id]);
      this.toast.ok('Product deleted.');
      this.editing.set(null);
    } catch (cause) {
      this.toast.error(messageOf(cause));
    }
  }

  /** A plain CSV of the catalog — a backup, and a template to edit and re-upload. */
  protected exportCsv(): void {
    const header = [
      'item_id',
      'item_name',
      'brand',
      'size',
      'department',
      'aisle',
      'shelf_sequence',
      'unit',
      'price',
      'barcode',
    ];
    const rows = this.data
      .items()
      .map((item) => [
        item.id,
        item.name,
        item.brand,
        item.size,
        item.department,
        item.aisle,
        item.shelfSequence ?? '',
        item.unit,
        item.price ?? '',
        item.barcode,
      ]);

    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'catalog.csv';
    link.click();
    URL.revokeObjectURL(url);
  }
}
