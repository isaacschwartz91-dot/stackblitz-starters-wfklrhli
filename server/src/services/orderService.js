import { config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { generateBarcodeValue, generateTrackingToken, trackingUrl } from '../lib/identifiers.js';
import { parseOrdersCsv } from '../lib/csvImport.js';
import { assertTransitionAllowed } from '../lib/statusMachine.js';
import * as batches from '../repositories/importBatchRepository.js';
import * as orders from '../repositories/orderRepository.js';
import { notifyStatusChange } from './notificationService.js';

/** Barcode/token collisions are astronomically unlikely; retry rather than fail. */
const UNIQUE_RETRY_LIMIT = 5;

function isUniqueViolation(err, constraint) {
  return err?.code === '23505' && (!constraint || err.constraint === constraint);
}

/**
 * Inserts an order, regenerating the barcode value / tracking token if either
 * collides. Wrapped in a savepoint so a retry doesn't abort the caller's
 * transaction (important for CSV imports, where many rows share one).
 */
async function insertWithGeneratedCodes(client, payload) {
  for (let attempt = 1; attempt <= UNIQUE_RETRY_LIMIT; attempt += 1) {
    const savepoint = `order_insert_${attempt}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const order = await orders.insert(client, {
        ...payload,
        barcodeValue: generateBarcodeValue(),
        trackingToken: generateTrackingToken(),
      });
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return order;
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      const collision =
        isUniqueViolation(err, 'orders_barcode_value_key') ||
        isUniqueViolation(err, 'orders_tracking_token_key');
      if (!collision || attempt === UNIQUE_RETRY_LIMIT) throw err;
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new Error('Exhausted barcode generation attempts');
}

/** Adds the derived, non-persisted fields the API exposes on every order. */
export function decorateOrder(order) {
  if (!order) return null;
  return {
    ...order,
    trackingUrl: trackingUrl(config.publicBaseUrl, order.trackingToken),
    labelUrl: `/api/orders/${order.id}/label`,
  };
}

export async function createOrder({ data, actorId, source = 'manual' }) {
  return withTransaction(async (client) => {
    const order = await insertWithGeneratedCodes(client, { ...data, createdById: actorId });
    await orders.recordInitialStatus(client, { orderId: order.id, actorId, source });
    return decorateOrder(order);
  });
}

export async function listOrders(filters) {
  const { orders: rows, total } = await orders.list(filters);
  return {
    orders: rows.map(decorateOrder),
    pagination: {
      total,
      limit: filters.limit,
      offset: filters.offset,
      hasMore: filters.offset + rows.length < total,
    },
  };
}

export async function getOrder(id) {
  const order = await orders.findById(id);
  if (!order) throw notFound('Order not found');
  return decorateOrder(order);
}

export async function getOrderWithHistory(id) {
  const order = await getOrder(id);
  const history = await orders.listStatusEvents(id);
  return { ...order, history };
}

export async function updateOrder(id, patch) {
  return withTransaction(async (client) => {
    const existing = await orders.findByIdForUpdate(client, id);
    if (!existing) throw notFound('Order not found');
    if (existing.status === 'delivered' || existing.status === 'cancelled') {
      throw conflict(`A ${existing.status} order can no longer be edited`, {
        currentStatus: existing.status,
      });
    }
    const updated = await orders.update(client, id, patch);
    return decorateOrder(updated);
  });
}

/**
 * Manual status change (staff correcting an order, cancelling, or re-queueing a
 * failed attempt). Scan-driven changes go through scanService instead, so that
 * they can attach the scan event.
 */
export async function changeOrderStatus({ orderId, toStatus, actorId, notes, source = 'manual' }) {
  const result = await withTransaction(async (client) => {
    const order = await orders.findByIdForUpdate(client, orderId);
    if (!order) throw notFound('Order not found');

    assertTransitionAllowed(order.status, toStatus);

    // Moving to 'assigned' requires a driver; that path is the assignment API.
    if (toStatus === 'assigned' && !order.assignedDriverId) {
      throw badRequest('Assign a driver before moving this order to "assigned"');
    }

    const assignment = toStatus === 'ready_for_delivery' && order.assignedDriverId
      ? null // returning to the dispatcher queue clears the driver
      : undefined;

    const changed = await orders.applyStatusChange(client, {
      order,
      toStatus,
      actorId,
      source,
      notes: notes ?? null,
      assignment,
    });

    return { order: decorateOrder(changed.order), statusEvent: changed.statusEvent };
  });

  // After the commit: a rolled-back transition must never leave a sent SMS behind.
  await notifyStatusChange(result);
  return result;
}

export async function deleteOrder(id) {
  return withTransaction(async (client) => {
    const order = await orders.findByIdForUpdate(client, id);
    if (!order) throw notFound('Order not found');
    // Once a label has been scanned the order is part of the delivery record;
    // cancelling preserves the history, deleting would destroy it.
    if (order.status !== 'created') {
      throw conflict(
        'Only orders that have never been scanned can be deleted — cancel it instead',
        { currentStatus: order.status },
      );
    }
    await orders.remove(client, id);
    return { id, deleted: true };
  });
}

/**
 * Bulk-creates orders from a CSV upload.
 *
 * Row-level failures are collected and reported rather than aborting the whole
 * import, and each row is inserted inside a savepoint so a duplicate order
 * reference only rolls back that row.
 */
export async function importOrdersFromCsv({ content, filename, actorId }) {
  const { rows, errors, unknownHeaders } = parseOrdersCsv(content, { maxRows: config.csvMaxRows });

  if (rows.length === 0) {
    throw badRequest('No valid rows found in the CSV', {
      errors: errors.slice(0, 50),
      errorCount: errors.length,
    });
  }

  return withTransaction(async (client) => {
    const batch = await batches.create(client, {
      filename,
      uploadedById: actorId,
      totalRows: rows.length + new Set(errors.map((e) => e.rowNumber)).size,
    });

    const created = [];
    const rowErrors = [...errors];

    for (const { rowNumber, data } of rows) {
      const savepoint = `csv_row_${rowNumber}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const order = await insertWithGeneratedCodes(client, {
          ...data,
          createdById: actorId,
          importBatchId: batch.id,
        });
        await orders.recordInitialStatus(client, {
          orderId: order.id,
          actorId,
          source: 'import',
        });
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        created.push(decorateOrder(order));
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        rowErrors.push({
          rowNumber,
          field: isUniqueViolation(err, 'orders_order_ref_key') ? 'orderRef' : undefined,
          message: isUniqueViolation(err, 'orders_order_ref_key')
            ? `An order with reference "${data.orderRef}" already exists`
            : err.message,
        });
      }
    }

    const finalised = await batches.finalise(client, batch.id, {
      createdCount: created.length,
      failedCount: rowErrors.length,
      rowErrors,
    });

    return { batch: finalised, created, errors: rowErrors, unknownHeaders };
  });
}
