/**
 * When a product was last sold.
 *
 * The rules are small but each one is a decision that would be invisible if
 * it were wrong: a draft is not a sale, a substituted line sold the
 * substitute, and a scheduled delivery beats the day the order was keyed in.
 * A wrong date here reads as fact, so it is worth pinning down.
 */

import { describe, expect, it } from 'vitest';

import { lastSoldByItem } from './last-sold';
import type { Order, OrderLine } from './models';

function order(partial: Partial<Order> & { id: string }): Order {
  return {
    customerId: null,
    customerName: '',
    deliveryAt: '',
    notes: '',
    status: 'complete',
    createdBy: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function line(partial: Partial<OrderLine> & { id: string; orderId: string }): OrderLine {
  return {
    position: 0,
    rawText: '',
    phrase: '',
    itemId: null,
    qty: 1,
    unit: 'each',
    note: '',
    needsReview: false,
    matchSource: 'exact',
    matchScore: 1,
    substituteItemId: null,
    picked: false,
    ...partial,
  } as OrderLine;
}

describe('last sold', () => {
  it('reports the most recent order a product appeared on', () => {
    const result = lastSoldByItem(
      [
        order({ id: 'o1', createdAt: '2026-03-01T10:00:00.000Z' }),
        order({ id: 'o2', createdAt: '2026-05-20T10:00:00.000Z' }),
      ],
      [
        line({ id: 'l1', orderId: 'o1', itemId: 'milk' }),
        line({ id: 'l2', orderId: 'o2', itemId: 'milk' }),
      ],
    );

    expect(result.get('milk')).toBe('2026-05-20T10:00:00.000Z');
  });

  it('does not count a draft — nobody has bought anything yet', () => {
    const result = lastSoldByItem(
      [
        order({ id: 'o1', createdAt: '2026-03-01T10:00:00.000Z' }),
        order({ id: 'o2', createdAt: '2026-05-20T10:00:00.000Z', status: 'draft' }),
      ],
      [
        line({ id: 'l1', orderId: 'o1', itemId: 'milk' }),
        line({ id: 'l2', orderId: 'o2', itemId: 'milk' }),
      ],
    );

    expect(result.get('milk')).toBe('2026-03-01T10:00:00.000Z');
  });

  it('counts an order that is only ready or being picked', () => {
    const result = lastSoldByItem(
      [order({ id: 'o1', createdAt: '2026-04-02T10:00:00.000Z', status: 'picking' })],
      [line({ id: 'l1', orderId: 'o1', itemId: 'milk' })],
    );

    expect(result.get('milk')).toBe('2026-04-02T10:00:00.000Z');
  });

  it('credits the substitute, not the product that was asked for', () => {
    const result = lastSoldByItem(
      [order({ id: 'o1', createdAt: '2026-04-02T10:00:00.000Z' })],
      [line({ id: 'l1', orderId: 'o1', itemId: 'milk', substituteItemId: 'oat-milk' })],
    );

    expect(result.get('oat-milk')).toBe('2026-04-02T10:00:00.000Z');
    expect(result.has('milk')).toBe(false);
  });

  it('prefers the delivery date over the day the order was typed', () => {
    const result = lastSoldByItem(
      [
        order({
          id: 'o1',
          createdAt: '2026-04-01T10:00:00.000Z',
          deliveryAt: '2026-04-08T09:00:00.000Z',
        }),
      ],
      [line({ id: 'l1', orderId: 'o1', itemId: 'milk' })],
    );

    expect(result.get('milk')).toBe('2026-04-08T09:00:00.000Z');
  });

  it('leaves an unmatched line out of it', () => {
    const result = lastSoldByItem(
      [order({ id: 'o1' })],
      [line({ id: 'l1', orderId: 'o1', itemId: null })],
    );

    expect(result.size).toBe(0);
  });

  it('says nothing about a product that has never been ordered', () => {
    const result = lastSoldByItem([order({ id: 'o1' })], [line({ id: 'l1', orderId: 'o1', itemId: 'milk' })]);

    expect(result.has('bread')).toBe(false);
  });
});
