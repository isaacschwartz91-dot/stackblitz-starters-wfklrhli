/**
 * Re-sorts a matched order into the order a picker physically walks the store.
 *
 * Sort key: (aisle walking order) then (shelf_sequence within the aisle) then
 * (item name). Anything without a location lands in a clearly labelled
 * "Location unknown" group at the very end, and anything unmatched or
 * ambiguous is pulled out into "Needs attention" so it never silently
 * disappears from the walk.
 */

import type { Aisle, Item, OrderLine } from '../core/models';

export const UNKNOWN_AISLE_ID = '__unknown__';

export interface PickEntry {
  line: OrderLine;
  item: Item | null;
  /** Set when the line was marked out of stock and a substitute chosen. */
  substitute: Item | null;
}

export interface PickGroup {
  aisleId: string;
  aisleName: string;
  sequence: number;
  entries: PickEntry[];
}

export interface PickList {
  groups: PickGroup[];
  /** Unmatched or low-confidence lines, surfaced separately. */
  needsAttention: PickEntry[];
  totalItems: number;
  pickedItems: number;
  estimatedTotal: number;
}

/**
 * Walking position of an aisle.
 *
 * Aisles listed in Sheet B use their given sequence. An aisle that appears on
 * an item but not in Sheet B still sorts sensibly — numerically if it is a
 * number, alphabetically otherwise — but always after every known aisle, so an
 * incomplete Sheet B degrades gracefully instead of scrambling the walk.
 */
export function aisleOrderMap(aisles: Aisle[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const aisle of aisles) {
    map.set(aisleKey(aisle.id), aisle.sequence);
  }
  return map;
}

/** Aisle codes are compared case- and whitespace-insensitively. */
export function aisleKey(aisle: string): string {
  return String(aisle ?? '')
    .trim()
    .toLowerCase();
}

const UNKNOWN_BASE = 1_000_000;

function sequenceFor(aisle: string, order: Map<string, number>): number {
  const key = aisleKey(aisle);
  if (key === '') return Number.MAX_SAFE_INTEGER;
  const known = order.get(key);
  if (known !== undefined) return known;
  const numeric = Number(key.replace(/[^0-9.]/g, ''));
  return UNKNOWN_BASE + (Number.isFinite(numeric) && numeric > 0 ? numeric : UNKNOWN_BASE);
}

export interface BuildPickListInput {
  lines: OrderLine[];
  items: Map<string, Item>;
  aisles: Aisle[];
}

export function buildPickList({ lines, items, aisles }: BuildPickListInput): PickList {
  const order = aisleOrderMap(aisles);
  const aisleNames = new Map<string, string>();
  for (const aisle of aisles) aisleNames.set(aisleKey(aisle.id), aisle.name || `Aisle ${aisle.id}`);

  const needsAttention: PickEntry[] = [];
  const groups = new Map<string, PickGroup>();
  let pickedItems = 0;
  let estimatedTotal = 0;

  const sorted = [...lines].sort((a, b) => a.position - b.position);

  for (const line of sorted) {
    const item = line.itemId === null ? null : (items.get(line.itemId) ?? null);
    const substitute =
      line.substituteItemId === null ? null : (items.get(line.substituteItemId) ?? null);
    const entry: PickEntry = { line, item, substitute };

    if (item === null || line.needsReview) {
      needsAttention.push(entry);
      continue;
    }

    if (line.picked) pickedItems += 1;
    const priceSource = substitute ?? item;
    if (priceSource.price !== null) estimatedTotal += priceSource.price * line.qty;

    // Picking follows the shelf the *substitute* sits on when there is one.
    const located = substitute ?? item;
    const key = aisleKey(located.aisle);
    const groupId = key === '' ? UNKNOWN_AISLE_ID : key;
    let group = groups.get(groupId);
    if (group === undefined) {
      group = {
        aisleId: groupId,
        aisleName:
          groupId === UNKNOWN_AISLE_ID
            ? 'Location unknown — fix me'
            : (aisleNames.get(key) ?? `Aisle ${located.aisle}`),
        sequence: groupId === UNKNOWN_AISLE_ID ? Number.MAX_SAFE_INTEGER : sequenceFor(located.aisle, order),
        entries: [],
      };
      groups.set(groupId, group);
    }
    group.entries.push(entry);
  }

  const orderedGroups = [...groups.values()].sort(
    (a, b) => a.sequence - b.sequence || a.aisleName.localeCompare(b.aisleName),
  );

  for (const group of orderedGroups) {
    group.entries.sort((a, b) => {
      const aItem = a.substitute ?? a.item;
      const bItem = b.substitute ?? b.item;
      const aSequence = aItem?.shelfSequence ?? Number.MAX_SAFE_INTEGER;
      const bSequence = bItem?.shelfSequence ?? Number.MAX_SAFE_INTEGER;
      if (aSequence !== bSequence) return aSequence - bSequence;
      return (aItem?.name ?? '').localeCompare(bItem?.name ?? '');
    });
  }

  const totalItems = orderedGroups.reduce((sum, group) => sum + group.entries.length, 0);

  return {
    groups: orderedGroups,
    needsAttention,
    totalItems,
    pickedItems,
    estimatedTotal: Math.round(estimatedTotal * 100) / 100,
  };
}
