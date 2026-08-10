/**
 * Type-ahead product search.
 *
 * Used to add a line to an order, to correct a wrong match, and to choose a
 * substitute for something out of stock. Keyboard-first: type, arrow, Enter.
 */

import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';

import { DataService } from '../core/data.service';
import type { Item } from '../core/models';
import { searchItems } from '../matching/matcher';
import { aisleKey, aisleLabel } from '../matching/pick-list';

/** Rows the dropdown shows at once; anything beyond is counted, never dropped in silence. */
const VISIBLE_SUGGESTIONS = 25;

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
          <div class="suggestion-head">
            <span>Product</span>
            <span>Size</span>
            <span>UPC</span>
            <span>Where</span>
          </div>
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
                @if (result.item.brand) {
                  <span class="dim small"> · {{ result.item.brand }}</span>
                }
              </span>
              <span class="s-size small dim">{{ result.item.size || '—' }}</span>
              <span class="s-upc small dim tabular">{{ result.item.barcode || '—' }}</span>
              <span class="where">{{ where(result.item) }}</span>
            </button>
          }
          @if (hidden() > 0) {
            <div class="suggestion-more small dim">
              {{ hidden() }} more match “{{ query().trim() }}” — keep typing to narrow it down.
            </div>
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

  /**
   * Every match, ranked. Capping the search itself would save nothing — the
   * cost is scoring, not the returned rows — and knowing the true total is
   * what lets the list admit when it is hiding something.
   */
  private readonly allResults = computed(() => {
    const text = this.query().trim();
    if (text.length < 2) return [];
    return searchItems(this.data.matchIndex(), text);
  });

  protected readonly results = computed(() => this.allResults().slice(0, VISIBLE_SUGGESTIONS));
  protected readonly hidden = computed(() => this.allResults().length - this.results().length);

  focus(): void {
    this.box()?.nativeElement.focus();
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
