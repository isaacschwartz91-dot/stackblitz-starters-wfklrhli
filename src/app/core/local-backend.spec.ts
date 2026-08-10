/**
 * The browser backend has no foreign keys, so every cascade the Postgres
 * schema declares is hand-written in `clear()`. These tests pin down that the
 * two stay in step: a button that deletes products must delete exactly the
 * same things whether a store runs on IndexedDB or Supabase.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import { LocalBackend } from './local-backend';
import { DEFAULT_SETTINGS, emptyItem } from './models';
import type { Alias, Customer, Order, OrderLine } from './models';

function alias(id: string, itemId: string, customerId: string | null): Alias {
  return {
    id,
    phrase: id,
    normalizedPhrase: id,
    itemId,
    customerId,
    hits: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'test',
  };
}

function customer(id: string): Customer {
  return { id, name: id, phone: '', email: '', address: '', notes: '', createdAt: '' };
}

function order(id: string, customerId: string | null): Order {
  return {
    id,
    customerId,
    customerName: customerId ?? '',
    deliveryAt: '',
    notes: '',
    status: 'new',
    createdBy: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function line(id: string, orderId: string, itemId: string | null): OrderLine {
  return {
    id,
    orderId,
    position: 0,
    rawText: 'milk',
    phrase: 'milk',
    itemId,
    qty: 1,
    unit: 'each',
    note: '',
    needsReview: false,
    matchSource: 'exact',
    matchScore: 1,
    substituteItemId: null,
    picked: false,
  } as OrderLine;
}

async function seeded(): Promise<LocalBackend> {
  // Each test gets its own database, so one wipe cannot affect the next.
  const backend = new LocalBackend();
  await backend.init();
  await backend.clear('everything');

  await backend.upsertItems([
    { ...emptyItem('sku-1'), name: 'Milk' },
    { ...emptyItem('sku-2'), name: 'Bread' },
  ]);
  await backend.replaceAisles([{ id: '1', name: 'Dairy', sequence: 1 }]);
  await backend.upsertCustomers([customer('cust-1'), customer('cust-2')]);
  await backend.upsertAliases([
    alias('global-1', 'sku-1', null),
    alias('private-1', 'sku-1', 'cust-1'),
    alias('private-2', 'sku-2', 'cust-2'),
  ]);
  await backend.saveOrder(order('order-1', 'cust-1'), [
    line('line-1', 'order-1', 'sku-1'),
    line('line-2', 'order-1', null),
  ]);
  await backend.saveSettings({ ...DEFAULT_SETTINGS, storeName: 'Test Store' });
  return backend;
}

describe('LocalBackend.clear', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    backend = await seeded();
  });

  it('deleting products takes the shorthand with it, because shorthand points at a product', async () => {
    await backend.clear('items');
    const after = await backend.loadAll();

    expect(after.items).toEqual([]);
    expect(after.aliases).toEqual([]);
  });

  it('deleting products keeps orders as history, with the product link cut', async () => {
    await backend.clear('items');
    const after = await backend.loadAll();

    expect(after.orders).toHaveLength(1);
    expect(after.orderLines).toHaveLength(2);
    expect(after.orderLines.every((entry) => entry.itemId === null)).toBe(true);
  });

  it('deleting products leaves customers and the walking order alone', async () => {
    await backend.clear('items');
    const after = await backend.loadAll();

    expect(after.customers).toHaveLength(2);
    expect(after.aisles).toHaveLength(1);
  });

  it('deleting customers keeps store-wide shorthand but drops the private kind', async () => {
    await backend.clear('customers');
    const after = await backend.loadAll();

    expect(after.customers).toEqual([]);
    expect(after.aliases.map((entry) => entry.id)).toEqual(['global-1']);
  });

  it('deleting customers keeps past orders, detached', async () => {
    await backend.clear('customers');
    const after = await backend.loadAll();

    expect(after.orders).toHaveLength(1);
    expect(after.orders[0].customerId).toBeNull();
    // The name was snapshotted onto the order, so history still reads.
    expect(after.orders[0].customerName).toBe('cust-1');
  });

  it('deleting customers leaves the catalog alone', async () => {
    await backend.clear('customers');
    expect((await backend.loadAll()).items).toHaveLength(2);
  });

  it('deleting orders takes their lines and nothing else', async () => {
    await backend.clear('orders');
    const after = await backend.loadAll();

    expect(after.orders).toEqual([]);
    expect(after.orderLines).toEqual([]);
    expect(after.items).toHaveLength(2);
    expect(after.customers).toHaveLength(2);
    expect(after.aliases).toHaveLength(3);
  });

  it('erasing everything leaves no data behind', async () => {
    await backend.clear('everything');
    const after = await backend.loadAll();

    expect(after.items).toEqual([]);
    expect(after.aisles).toEqual([]);
    expect(after.customers).toEqual([]);
    expect(after.aliases).toEqual([]);
    expect(after.orders).toEqual([]);
    expect(after.orderLines).toEqual([]);
  });
});
