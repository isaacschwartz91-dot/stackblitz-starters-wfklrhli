/**
 * Turns raw order text into matched order lines, and keeps them matched as the
 * customer or the learned shorthand changes.
 */

import { Injectable, inject } from '@angular/core';

import { DataService } from './data.service';
import { newId } from './ids';
import type { Item, Order, OrderLine } from './models';
import type { Candidate, MatchOptions } from '../matching/matcher';
import { matchPhrase } from '../matching/matcher';
import { normalize } from '../matching/normalize';
import { parseLine, splitOrderText } from '../matching/parse-line';

@Injectable({ providedIn: 'root' })
export class OrderService {
  private readonly data = inject(DataService);

  private options(customerId: string | null): MatchOptions {
    const settings = this.data.settings();
    return {
      customerId,
      autoAcceptScore: settings.autoAcceptScore,
      reviewFloorScore: settings.reviewFloorScore,
    };
  }

  /** Split a pasted block and match every line. */
  linesFromText(
    text: string,
    orderId: string,
    customerId: string | null,
    startPosition = 0,
  ): OrderLine[] {
    const raws = splitOrderText(text, this.data.settings().splitOnCommas);
    return raws.map((raw, offset) =>
      this.lineFromRaw(raw, orderId, customerId, startPosition + offset),
    );
  }

  lineFromRaw(raw: string, orderId: string, customerId: string | null, position: number): OrderLine {
    const parsed = parseLine(raw);
    // The untouched line is offered as an alternate spelling so size words the
    // quantity parser stripped can still earn the match.
    const match = matchPhrase(this.data.matchIndex(), parsed.phrase, this.options(customerId), [
      parsed.raw,
    ]);

    return {
      id: newId('line'),
      orderId,
      position,
      rawText: parsed.raw,
      phrase: parsed.phrase,
      itemId: match.itemId,
      qty: parsed.qty,
      unit: parsed.unit,
      note: parsed.note,
      needsReview: match.needsReview,
      matchSource: match.source,
      matchScore: match.score,
      picked: false,
      outOfStock: false,
      substituteItemId: null,
    };
  }

  /** A line for a product the staff picked from the type-ahead box. */
  lineFromItem(item: Item, orderId: string, position: number, qty = 1): OrderLine {
    return {
      id: newId('line'),
      orderId,
      position,
      rawText: item.name,
      phrase: item.name,
      itemId: item.id,
      qty,
      unit: item.unit,
      note: '',
      needsReview: false,
      matchSource: 'manual',
      matchScore: 1,
      picked: false,
      outOfStock: false,
      substituteItemId: null,
    };
  }

  /**
   * Re-run matching over existing lines — after the customer changes, or after
   * a new alias is taught. Lines a human already fixed are left alone.
   */
  rematch(lines: OrderLine[], customerId: string | null): OrderLine[] {
    const index = this.data.matchIndex();
    const options = this.options(customerId);
    return lines.map((line) => {
      if (line.matchSource === 'manual') return line;
      const match = matchPhrase(index, line.phrase, options, [line.rawText]);
      return {
        ...line,
        itemId: match.itemId,
        needsReview: match.needsReview,
        matchSource: match.source,
        matchScore: match.score,
      };
    });
  }

  /** The "did you mean…" list for one line. */
  candidatesFor(line: OrderLine, customerId: string | null): Candidate[] {
    const match = matchPhrase(
      this.data.matchIndex(),
      line.phrase,
      { ...this.options(customerId), maxCandidates: 8 },
      [line.rawText],
    );
    return match.candidates;
  }

  /** Which alias rows a set of lines used, so their hit counters can be bumped. */
  aliasesUsedBy(lines: OrderLine[], customerId: string | null): string[] {
    const used = new Set<string>();
    for (const line of lines) {
      const wantedScope =
        line.matchSource === 'customer-alias'
          ? customerId
          : line.matchSource === 'global-alias'
            ? null
            : undefined;
      if (wantedScope === undefined) continue;

      const keys = new Set([normalize(line.phrase), normalize(line.rawText)]);
      const hit = this.data
        .aliases()
        .find(
          (alias) =>
            alias.customerId === wantedScope &&
            alias.itemId === line.itemId &&
            keys.has(alias.normalizedPhrase),
        );
      if (hit !== undefined) used.add(hit.id);
    }
    return [...used];
  }

  /** Copy an order's lines into a fresh order — "duplicate" and "repeat last". */
  duplicateLines(sourceOrderId: string, targetOrderId: string): OrderLine[] {
    return this.data.linesFor(sourceOrderId).map((line, position) => ({
      ...line,
      id: newId('line'),
      orderId: targetOrderId,
      position,
      picked: false,
      outOfStock: false,
      substituteItemId: null,
    }));
  }

  newOrder(customerId: string | null, customerName: string, createdBy: string): Order {
    const now = new Date().toISOString();
    return {
      id: newId('order'),
      customerId,
      customerName,
      deliveryAt: '',
      notes: '',
      status: 'draft',
      createdBy,
      createdAt: now,
      updatedAt: now,
    };
  }
}
