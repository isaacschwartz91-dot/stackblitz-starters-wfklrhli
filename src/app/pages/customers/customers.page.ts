import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DataService, messageOf } from '../../core/data.service';
import { ToastService } from '../../core/toast.service';
import { newId } from '../../core/ids';
import type { Customer } from '../../core/models';
import { SheetImport } from '../../import/sheet-import';

@Component({
  selector: 'app-customers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, SheetImport],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Customers</h1>
          <p>
            Needed for per-customer shorthand, and so a regular's order can be repeated in one click.
          </p>
        </div>
        <span class="spacer"></span>
        <div class="button-row">
          <button type="button" (click)="exportCsv()" [disabled]="data.customers().length === 0">
            Export CSV
          </button>
          <button type="button" (click)="showImport.set(!showImport())">
            {{ showImport() ? 'Hide upload' : 'Upload customer list' }}
          </button>
          <button type="button" class="primary" (click)="startNew()">Add customer</button>
        </div>
      </div>

      @if (showImport() || data.customers().length === 0) {
        <div style="margin-bottom: 1rem"><app-sheet-import /></div>
      }

      <div class="card" style="margin-bottom: 1rem">
        <label class="field" style="margin: 0">
          <span>Search</span>
          <input
            type="search"
            placeholder="Name, phone or email…"
            [value]="query()"
            (input)="query.set(value($event))"
          />
        </label>
      </div>

      @if (filtered().length === 0) {
        <div class="card empty">
          <h3>No customers{{ data.customers().length === 0 ? ' yet' : ' match' }}</h3>
          <p class="muted">Add one when you take their first order.</p>
        </div>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th style="width: 11rem">Phone</th>
                <th style="width: 14rem">Email</th>
                <th style="width: 7rem" class="num">Shorthand</th>
                <th style="width: 6rem" class="num">Orders</th>
                <th style="width: 8rem"></th>
              </tr>
            </thead>
            <tbody>
              @for (customer of filtered(); track customer.id) {
                <tr>
                  <td>
                    <div class="name">{{ customer.name }}</div>
                    @if (customer.address) {
                      <div class="small dim">{{ customer.address }}</div>
                    }
                  </td>
                  <td class="small">{{ customer.phone || '—' }}</td>
                  <td class="small">{{ customer.email || '—' }}</td>
                  <td class="num tabular small">
                    @if (aliasCount(customer.id) > 0) {
                      <a routerLink="/aliases" [queryParams]="{ customer: customer.id }">
                        {{ aliasCount(customer.id) }}
                      </a>
                    } @else {
                      —
                    }
                  </td>
                  <td class="num tabular small">{{ orderCount(customer.id) }}</td>
                  <td>
                    <div class="button-row" style="gap: 0.25rem; justify-content: flex-end">
                      <button type="button" class="small" (click)="edit(customer)">Edit</button>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    @if (editing(); as customer) {
      <div class="modal-backdrop" (click)="editing.set(null)">
        <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
          <h2>{{ isNew() ? 'Add customer' : customer.name }}</h2>

          <label class="field">
            <span>Name</span>
            <input type="text" [value]="customer.name" (input)="patch({ name: value($event) })" />
          </label>
          <div class="inline-fields">
            <label class="field">
              <span>Phone</span>
              <input type="tel" [value]="customer.phone" (input)="patch({ phone: value($event) })" />
            </label>
            <label class="field">
              <span>Email</span>
              <input
                type="email"
                [value]="customer.email"
                (input)="patch({ email: value($event) })"
              />
            </label>
          </div>
          <label class="field">
            <span>Delivery address</span>
            <input
              type="text"
              [value]="customer.address"
              (input)="patch({ address: value($event) })"
            />
          </label>
          <label class="field">
            <span>Notes</span>
            <input
              type="text"
              [value]="customer.notes"
              (input)="patch({ notes: value($event) })"
              placeholder="Ring the bell twice, leave with the doorman…"
            />
          </label>

          <div class="button-row">
            <button type="button" class="primary" (click)="save()" [disabled]="!customer.name.trim()">
              Save
            </button>
            <button type="button" class="ghost" (click)="editing.set(null)">Cancel</button>
            <span class="spacer"></span>
            @if (!isNew()) {
              <button type="button" class="danger" (click)="remove(customer)">Delete</button>
            }
          </div>
        </div>
      </div>
    }
  `,
})
export class CustomersPage {
  protected readonly data = inject(DataService);
  private readonly toast = inject(ToastService);

  protected readonly query = signal('');
  protected readonly showImport = signal(false);
  protected readonly editing = signal<Customer | null>(null);
  protected readonly isNew = signal(false);

  protected readonly filtered = computed(() => {
    const text = this.query().trim().toLowerCase();
    return this.data
      .customers()
      .filter((customer) =>
        text === ''
          ? true
          : `${customer.name} ${customer.phone} ${customer.email}`.toLowerCase().includes(text),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected aliasCount(customerId: string): number {
    return this.data.aliasesForCustomer(customerId).length;
  }

  protected orderCount(customerId: string): number {
    return this.data.orders().filter((order) => order.customerId === customerId).length;
  }

  protected startNew(): void {
    this.editing.set({
      id: newId('cust'),
      name: '',
      phone: '',
      email: '',
      address: '',
      notes: '',
      createdAt: new Date().toISOString(),
    });
    this.isNew.set(true);
  }

  protected edit(customer: Customer): void {
    this.editing.set({ ...customer });
    this.isNew.set(false);
  }

  protected patch(patch: Partial<Customer>): void {
    const current = this.editing();
    if (current === null) return;
    this.editing.set({ ...current, ...patch });
  }

  protected async save(): Promise<void> {
    const customer = this.editing();
    if (customer === null || customer.name.trim() === '') return;
    try {
      await this.data.saveCustomer({ ...customer, name: customer.name.trim() });
      this.toast.ok('Customer saved.');
      this.editing.set(null);
    } catch (cause) {
      this.toast.error(messageOf(cause));
    }
  }

  /** A CSV of the customer list — a backup, and a template to edit and re-upload. */
  protected exportCsv(): void {
    const header = ['customer_id', 'customer_name', 'phone', 'email', 'address', 'notes'];
    const rows = this.data
      .customers()
      .map((customer) => [
        customer.id,
        customer.name,
        customer.phone,
        customer.email,
        customer.address,
        customer.notes,
      ]);
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'customers.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  protected async remove(customer: Customer): Promise<void> {
    const aliases = this.aliasCount(customer.id);
    const warning =
      aliases > 0
        ? `Delete ${customer.name}? Their ${aliases} learned shorthand rule(s) go too. Past orders are kept.`
        : `Delete ${customer.name}? Past orders are kept.`;
    if (!confirm(warning)) return;
    try {
      await this.data.deleteCustomer(customer.id);
      this.toast.ok('Customer deleted.');
      this.editing.set(null);
    } catch (cause) {
      this.toast.error(messageOf(cause));
    }
  }
}
