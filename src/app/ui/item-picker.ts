/**
 * Type-ahead product search.
 *
 * Used to add a line to an order, to correct a wrong match, and to choose a
 * substitute for something out of stock. Keyboard-first: type, arrow, Enter.
 */

import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';

import { DataService } from '../core/data.service';
import type { Item } from '../core/models';
import { itemDetail } from '../core/models';
import { searchItems } from '../matching/matcher';
import { aisleKey, aisleLabel } from '../matching/pick-list';

@Component({
  selector: 'app-item-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="typeahead">
      <input
        #box
        type="search"
        [attr.placeholder]="placeholder()"
        [attr.aria-label]="placeholder()"
        [value]="query()"
        autocomplete="off"
        (input)="onInput($event)"
        (keydown)="onKeydown($event)"
        (focus)="open.set(true)"
        (blur)="onBlur()"
      />

      @if (open() && results().length > 0) {
        <div class="suggestions" role="listbox">
          @for (result of results(); track result.item.id; let index = $index) {
            <button
              type="button"
              class="suggestion"
              [class.active]="index === highlighted()"
              (mousedown)="$event.preventDefault()"
              (click)="choose(result.item)"
            >
              <span>
                <strong>{{ result.item.name }}</strong>
                @if (detail(result.item)) {
                  <span class="dim small"> · {{ detail(result.item) }}</span>
                }
              </span>
              <span class="where">{{ where(result.item) }}</span>
            </button>
          }
        </div>
      } @else if (open() && query().trim().length > 1) {
        <div class="suggestions">
          <div class="small dim" style="padding: .5rem">
            Nothing in the catalog matches “{{ query() }}”.
          </div>
        </div>
      }
    </div>
  `,
})
export class ItemPicker {
  private readonly data = inject(DataService);

  readonly placeholder = input('Search products…');
  readonly clearOnPick = input(true);
  readonly picked = output<Item>();

  private readonly box = viewChild<ElementRef<HTMLInputElement>>('box');

  protected readonly query = signal('');
  protected readonly open = signal(false);
  protected readonly highlighted = signal(0);

  protected readonly results = computed(() => {
    const text = this.query().trim();
    if (text.length < 2) return [];
    return searchItems(this.data.matchIndex(), text, 10);
  });

  focus(): void {
    this.box()?.nativeElement.focus();
  }

  protected detail(item: Item): string {
    return itemDetail(item);
  }

  protected where(item: Item): string {
    if (item.aisle.trim() === '') return 'No aisle';
    const named = this.data.aisles().find((aisle) => aisleKey(aisle.id) === aisleKey(item.aisle));
    return aisleLabel(item.aisle, named?.name ?? '');
  }

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.highlighted.set(0);
    this.open.set(true);
  }

  protected onBlur(): void {
    // Let a click on a suggestion land before the list disappears.
    setTimeout(() => this.open.set(false), 120);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const results = this.results();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.open.set(true);
      this.highlighted.set(Math.min(this.highlighted() + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.highlighted.set(Math.max(this.highlighted() - 1, 0));
    } else if (event.key === 'Enter') {
      const chosen = results[this.highlighted()];
      if (chosen !== undefined) {
        event.preventDefault();
        this.choose(chosen.item);
      }
    } else if (event.key === 'Escape') {
      this.open.set(false);
    }
  }

  protected choose(item: Item): void {
    this.picked.emit(item);
    this.open.set(false);
    if (this.clearOnPick()) {
      this.query.set('');
      this.highlighted.set(0);
    } else {
      this.query.set(item.name);
    }
  }
}
