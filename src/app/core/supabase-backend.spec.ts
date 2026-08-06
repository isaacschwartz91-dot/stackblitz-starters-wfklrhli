import { afterEach, describe, expect, it, vi } from 'vitest';

import { SupabaseBackend } from './supabase-backend';

/**
 * A stand-in for PostgREST that enforces `max-rows` the way Supabase does:
 * never more than 1,000 rows, 200 (not an error) when it truncates, and the
 * count reported only in a header nobody is obliged to read.
 */
function fakePostgrest(totalRows: number, maxRows = 1000) {
  const seen: string[] = [];
  const handler = vi.fn(async (url: string, init?: RequestInit) => {
    seen.push(String((init?.headers as Record<string, string>)?.['Range'] ?? 'none'));

    const range = String((init?.headers as Record<string, string>)?.['Range'] ?? '0-');
    const [rawFrom, rawTo] = range.split('-');
    const from = Number(rawFrom);
    const asked = Number(rawTo) - from + 1;

    if (from >= totalRows && totalRows > 0) {
      return new Response('{}', { status: 416 });
    }
    const to = Math.min(totalRows, from + Math.min(asked, maxRows));
    const rows = [];
    for (let i = from; i < to; i += 1) rows.push({ id: `sku-${i}`, name: `Product ${i}` });
    return new Response(JSON.stringify(rows), {
      status: rows.length < totalRows ? 206 : 200,
      headers: { 'Content-Range': `${from}-${to - 1}/*` },
    });
  });
  return { handler, seen };
}

function backend(): SupabaseBackend {
  return new SupabaseBackend({ url: 'https://example.supabase.co', anonKey: 'anon-key' });
}

/** `select` is private on purpose; the paging it does is what we need to pin down. */
function readAll(instance: SupabaseBackend, path: string): Promise<unknown[]> {
  return (instance as unknown as { select(path: string): Promise<unknown[]> }).select(path);
}

describe('SupabaseBackend reads whole tables', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pages past the 1,000-row cap instead of returning a truncated catalog', async () => {
    const { handler } = fakePostgrest(9420);
    vi.stubGlobal('fetch', handler);

    const rows = await readAll(backend(), 'items?select=*&order=name.asc');

    expect(rows).toHaveLength(9420);
    expect(handler).toHaveBeenCalledTimes(10);
  });

  it('asks for each page in turn', async () => {
    const { handler, seen } = fakePostgrest(2500);
    vi.stubGlobal('fetch', handler);

    await readAll(backend(), 'items?select=*');

    expect(seen).toEqual(['0-999', '1000-1999', '2000-2999']);
  });

  it('stops cleanly when the row count is an exact multiple of the page size', async () => {
    const { handler } = fakePostgrest(2000);
    vi.stubGlobal('fetch', handler);

    // The third read runs off the end and PostgREST answers 416; that ends the
    // loop rather than failing the load.
    await expect(readAll(backend(), 'items?select=*')).resolves.toHaveLength(2000);
  });

  it('reads a small table in a single request', async () => {
    const { handler } = fakePostgrest(12);
    vi.stubGlobal('fetch', handler);

    expect(await readAll(backend(), 'aisles?select=*')).toHaveLength(12);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('reads an empty table without looping', async () => {
    const { handler } = fakePostgrest(0);
    vi.stubGlobal('fetch', handler);

    expect(await readAll(backend(), 'customers?select=*')).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('still surfaces a real failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"message":"permission denied"}', { status: 403 })),
    );

    await expect(readAll(backend(), 'items?select=*')).rejects.toThrow();
  });
});
