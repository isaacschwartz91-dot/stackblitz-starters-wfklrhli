/**
 * Order lifecycle rules.
 *
 * The transition table is the single source of truth for what may follow what;
 * every writer (manual status change, scan ingestion in phase 2, driver
 * assignment) goes through `assertTransitionAllowed` so the status log can
 * never contain a sequence the reports don't expect.
 */
import { conflict, badRequest } from './errors.js';

export const ORDER_STATUSES = Object.freeze([
  'created',
  'ready_for_delivery',
  'assigned',
  'out_for_delivery',
  'delivered',
  'failed_attempt',
  'cancelled',
]);

export const TRANSITIONS = Object.freeze({
  // A label exists but has never been scanned — nothing is tracked yet.
  created: ['ready_for_delivery', 'cancelled'],
  // The activation scan happened; waiting for a dispatcher.
  ready_for_delivery: ['assigned', 'cancelled'],
  // A driver owns it. Unassigning drops it back into the dispatcher queue.
  assigned: ['out_for_delivery', 'ready_for_delivery', 'cancelled'],
  // Driver scanned at pickup; the next scan is the drop-off.
  out_for_delivery: ['delivered', 'failed_attempt', 'cancelled'],
  // Redelivery: back to the queue, or straight back to the same driver.
  failed_attempt: ['assigned', 'ready_for_delivery', 'cancelled'],
  delivered: [],
  cancelled: [],
});

export const TERMINAL_STATUSES = Object.freeze(
  ORDER_STATUSES.filter((status) => TRANSITIONS[status].length === 0),
);

/** Statuses that mean the parcel is still moving through the system. */
export const OPEN_STATUSES = Object.freeze(
  ORDER_STATUSES.filter((status) => !TERMINAL_STATUSES.includes(status)),
);

export function isValidStatus(status) {
  return ORDER_STATUSES.includes(status);
}

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

export function assertTransitionAllowed(from, to) {
  if (!isValidStatus(to)) {
    throw badRequest(`Unknown order status "${to}"`, { allowed: ORDER_STATUSES });
  }
  if (from === to) {
    throw conflict(`Order is already ${to}`, { currentStatus: from });
  }
  if (!canTransition(from, to)) {
    const allowed = TRANSITIONS[from] ?? [];
    throw conflict(
      allowed.length === 0
        ? `Order is ${from}, which is a final status and cannot change`
        : `Cannot move an order from ${from} to ${to}`,
      { currentStatus: from, allowedTransitions: allowed },
    );
  }
}

/**
 * Which scan type drives a given transition. Phase 2 uses this to decide what a
 * driver's scan should mean without duplicating the lifecycle rules.
 */
export const SCAN_TRANSITIONS = Object.freeze({
  label_activation: { from: ['created'], to: 'ready_for_delivery' },
  pickup: { from: ['assigned'], to: 'out_for_delivery' },
  dropoff: { from: ['out_for_delivery'], to: 'delivered' },
});
