/**
 * The learned shorthand.
 *
 * Every rule the software has been taught: "when the order says X, it means
 * product Y", either for one customer or for everyone. Customer rules always
 * win over global ones when an order is matched.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute } from '@angular/router';

import { AuthService } from '../../core/auth.service';
import { DataService, messageOf } from '../../core/data.service';
import { ToastService } from '../../core/toast.service';
import type { Alias, Item } from '../../core/models';
import { itemDetail } from '../../core/models';
import { ItemPicker } from '../../ui/item-picker';
import { SelectValue } from '../../ui/select-value';

@Component({
  selector: 'app-aliases',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ItemPicker, SelectValue],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Learned shorthand</h1>
          <p>
            {{ data.aliases().length }} rules. A customer's own shorthand is applied before the
            store-wide list.
          </p>
        </div>
        <span class="spacer"></span>
        <button type="button" class="primary" (click)="startNew()">Add a rule</button>
      </div>

      <div class="card" style="margin-bottom: 1rem">
        <div class="inline-fields">
          <label class="field" style="margin: 0; flex: 2 1 240px">
            <span>Search</span>
            <input
              type="search"
              placeholder="Phrase or product…"
              [value]="query()"
              (input)="query.set(value($event))"
            />
          </label>
          <label class="field" style="margin: 0">
            <span>Scope</span>
            <select [selectValue]="scopeFilter()" (change)="scopeFilter.set(value($event))">
              <option value="">Everything</option>
              <option value="__global__">Store-wide only</option>
              @for (customer of data.customers(); track customer.id) {
                <option [value]="customer.id">{{ customer.name }}</option>
              }
            </select>
          </label>
        </div>
      </div>

      @if (filtered().length === 0) {
        <div class="card empty">
          <h3>Nothing learned{{ data.aliases().length === 0 ? ' yet' : ' matches' }}</h3>
          <p class="muted">
            When a match is wrong on an order, fix it and tick “remember this”. The rule shows up
            here.
          </p>
        </div>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th style="width: 16rem">When the order says</th>
                <th>It means</th>
                <th style="width: 13rem">Applies to</th>
                <th style="width: 5rem" class="num">Used</th>
                <th style="width: 8rem">Added</th>
                <th style="width: 8rem"></th>
              </tr>
            </thead>
            <tbody>
              @for (alias of filtered(); track alias.id) {
                <tr>
                  <td><strong>{{ alias.phrase }}</strong></td>
                  <td>
                    @if (itemFor(alias); as item) {
                      <div class="name">{{ item.name }}</div>
                      <div class="small dim">{{ detail(item) }}</div>
                    } @else {
                      <span class="chip danger">product no longer in the catalog</span>
                    }
                  </td>
                  <td>
                    @if (alias.customerId === null) {
                      <span class="chip">Everyone</span>
                    } @else {
                      <span class="chip accent">{{ customerName(alias.customerId) }}</span>
                    }
                  </td>
                  <td class="num tabular small dim">{{ alias.hits }}</td>
                  <td class="small dim">{{ alias.createdAt | date: 'd MMM y' }}</td>
                  <td>
                    <div class="button-row" style="gap: 0.25rem; justify-content: flex-end">
                      <button type="button" class="small" (click)="edit(alias)">Edit</button>
                      <button type="button" class="small danger" (click)="remove(alias)">✕</button>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    @if (editing()) {
      <div class="modal-backdrop" (click)="cancel()">
        <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
          <h2>{{ editingId() === null ? 'New shorthand rule' : 'Edit shorthand rule' }}</h2>

          <label class="field">
            <span>When the order says</span>
            <input
              type="text"
              [value]="phrase()"
              (input)="phrase.set(value($event))"
              placeholder="milk"
            />
          </label>

          <label class="field">
            <span>It means this product</span>
            <app-item-picker
              placeholder="Search products…"
              [clearOnPick]="false"
              (picked)="chosen.set($event)"
            />
          </label>

          @if (chosen(); as item) {
            <div class="notice ok">
              <strong>{{ item.name }}</strong>
              <span class="small"> {{ detail(item) }}</span>
            </div>
          }

          <label class="field">
            <span>Applies to</span>
            <select [selectValue]="scope()" (change)="scope.set(value($event))">
              <option value="__global__">Everyone (store-wide)</option>
              @for (customer of data.customers(); track customer.id) {
                <option [value]="customer.id">{{ customer.name }} only</option>
              }
            </select>
          </label>

          @if (conflict(); as existing) {
            <div class="notice warn">
              There is already a rule for “{{ existing.phrase }}” in this scope. Saving replaces it.
            </div>
          }

          <div class="button-row" style="margin-top: 0.5rem">
            <button
              type="button"
              class="primary"
              (click)="save()"
              [disabled]="chosen() === null || !phrase().trim()"
            >
              Save rule
            </button>
            <button type="button" class="ghost" (click)="cancel()">Cancel</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class AliasesPage {
  protected readonly data = inject(DataService);
  protected readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  protected readonly query = signal('');
  protected readonly scopeFilter = signal(this.route.snapshot.queryParamMap.get('customer') ?? '');

  protected readonly editing = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly phrase = signal('');
  protected readonly chosen = signal<Item | null>(null);
  protected readonly scope = signal('__global__');

  protected readonly filtered = computed(() => {
    const text = this.query().trim().toLowerCase();
    const scope = this.scopeFilter();

    return this.data
      .aliases()
      .filter((alias) => {
        if (scope === '__global__' && alias.customerId !== null) return false;
        if (scope !== '' && scope !== '__global__' && alias.customerId !== scope) return false;
        if (text === '') return true;
        const item = this.itemFor(alias);
        return `${alias.phrase} ${item?.name ?? ''} ${item?.brand ?? ''}`.toLowerCase().includes(text);
      })
      .sort(
        (a, b) =>
          this.customerName(a.customerId).localeCompare(this.customerName(b.customerId)) ||
          a.phrase.localeCompare(b.phrase),
      );
  });

  /** An existing rule the one being edited would overwrite. */
  protected readonly conflict = computed(() => {
    const normalizedPhrase = this.phrase().trim().toLowerCase();
    if (normalizedPhrase === '') return null;
    const customerId = this.scope() === '__global__' ? null : this.scope();
    return (
      this.data
        .aliases()
        .find(
          (alias) =>
            alias.id !== this.editingId() &&
            alias.customerId === customerId &&
            alias.phrase.trim().toLowerCase() === normalizedPhrase,
        ) ?? null
    );
  });

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected itemFor(alias: Alias): Item | null {
    return this.data.itemsById().get(alias.itemId) ?? null;
  }

  protected detail(item: Item): string {
    return itemDetail(item);
  }

  protected customerName(customerId: string | null): string {
    if (customerId === null) return 'Everyone';
    return this.data.customerById(customerId)?.name ?? 'Unknown customer';
  }

  protected startNew(): void {
    this.editingId.set(null);
    this.phrase.set('');
    this.chosen.set(null);
    this.scope.set(this.scopeFilter() === '' ? '__global__' : this.scopeFilter());
    this.editing.set(true);
  }

  protected edit(alias: Alias): void {
    this.editingId.set(alias.id);
    this.phrase.set(alias.phrase);
    this.chosen.set(this.itemFor(alias));
    this.scope.set(alias.customerId ?? '__global__');
    this.editing.set(true);
  }

  protected cancel(): void {
    this.editing.set(false);
    this.editingId.set(null);
    this.chosen.set(null);
  }

  protected async save(): Promise<void> {
    const item = this.chosen();
    if (item === null || this.phrase().trim() === '') return;
    const customerId = this.scope() === '__global__' ? null : this.scope();

    try {
      // Editing a rule's phrase or scope moves it, so drop the old row first.
      const previousId = this.editingId();
      if (previousId !== null) {
        const previous = this.data.aliases().find((alias) => alias.id === previousId);
        const moved =
          previous !== undefined &&
          (previous.customerId !== customerId ||
            previous.phrase.trim().toLowerCase() !== this.phrase().trim().toLowerCase());
        if (moved) await this.data.deleteAliases([previousId]);
      }

      await this.data.saveAlias({
        phrase: this.phrase(),
        itemId: item.id,
        customerId,
        createdBy: this.auth.displayName(),
      });
      this.toast.ok('Rule saved.');
      this.cancel();
    } catch (cause) {
      this.toast.error(messageOf(cause));
    }
  }

  protected async remove(alias: Alias): Promise<void> {
    if (!confirm(`Forget that “${alias.phrase}” means this product?`)) return;
    try {
      await this.data.deleteAliases([alias.id]);
      this.toast.ok('Rule removed.');
    } catch (cause) {
      this.toast.error(messageOf(cause));
    }
  }
}
