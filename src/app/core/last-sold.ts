/**
 * When each product last went out of the door.
 *
 * Three judgements are baked in, and each would be invisible if it were
 * wrong. A draft is somebody part-way through typing an order and may never
 * become one, so it is not a sale. When a line was substituted, the
 * substitute is what left the shelf and the product originally asked for did
 * not. And a scheduled delivery date beats the date the order was keyed in,
 * because that is when the goods actually go.
 */

import type { Order, OrderLine } from './models';

/** item id -> ISO date it was last sold on. */
export function lastSoldByItem(orders: Order[], lines: OrderLine[]): Map<string, string> {
  const soldOn = new Map<string, string>();
  for (const order of orders) {
    if (order.status === 'draft') continue;
    soldOn.set(order.id, order.deliveryAt !== '' ? order.deliveryAt : order.createdAt);
  }

  const latest = new Map<string, string>();
  for (const line of lines) {
    const when = soldOn.get(line.orderId);
    if (when === undefined || when === '') continue;
    const itemId = line.substituteItemId ?? line.itemId;
    if (itemId === null) continue;
    // ISO dates sort as text, so the later one is just the larger string.
    const known = latest.get(itemId);
    if (known === undefined || when > known) latest.set(itemId, when);
  }
  return latest;
}
