/**
 * Driver assignment: one parcel at a time, or a whole zone in one go.
 */
import { query, withTransaction } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { canTransition } from '../lib/statusMachine.js';
import * as orders from '../repositories/orderRepository.js';
import * as users from '../repositories/userRepository.js';
import { decorateOrder } from './orderService.js';

/** Statuses from which a parcel may be handed to (or taken from) a driver. */
const ASSIGNABLE_STATUSES = ['ready_for_delivery', 'assigned', 'failed_attempt'];

async function loadDriver(driverId) {
  const driver = await users.findById(driverId);
  if (!driver) throw notFound('Driver not found');
  if (driver.role !== 'driver') throw badRequest(`${driver.fullName} is not a driver`);
  if (!driver.isActive) throw badRequest(`${driver.fullName}'s account is inactive`);
  return driver;
}

async function recordAssignmentEvent(client, { orderId, fromDriverId, toDriverId, assignedById, method, notes }) {
  if (fromDriverId === toDriverId) return;
  await client.query(
    `INSERT INTO order_assignment_events
       (order_id, from_driver_id, to_driver_id, assigned_by_id, method, notes)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [orderId, fromDriverId, toDriverId, assignedById, method, notes ?? null],
  );
}

/**
 * Assigns (or, with driverId null, unassigns) a single order.
 *
 * Assigning moves ready_for_delivery / failed_attempt -> assigned. Re-assigning
 * an already-assigned parcel changes the driver without touching the status,
 * because its lifecycle stage has not changed.
 */
async function assignWithin(client, { orderId, driverId, actorId, method = 'manual', notes }) {
  const order = await orders.findByIdForUpdate(client, orderId);
  if (!order) throw notFound('Order not found');

  if (!ASSIGNABLE_STATUSES.includes(order.status)) {
    throw conflict(
      order.status === 'created'
        ? 'Scan the label before assigning this order to a driver'
        : `An order that is ${order.status} cannot be assigned`,
      { currentStatus: order.status },
    );
  }

  if (driverId === null) {
    if (!order.assignedDriverId) {
      throw conflict('This order is not assigned to anyone', { currentStatus: order.status });
    }
    // Returning to the queue is a real lifecycle move: assigned -> ready.
    const result = canTransition(order.status, 'ready_for_delivery')
      ? await orders.applyStatusChange(client, {
          order,
          toStatus: 'ready_for_delivery',
          actorId,
          source: 'manual',
          notes: notes ?? 'Returned to the dispatch queue',
          assignment: null,
        })
      : { order: await orders.setAssignment(client, { orderId, driverId: null, assignedById: null }) };

    await recordAssignmentEvent(client, {
      orderId,
      fromDriverId: order.assignedDriverId,
      toDriverId: null,
      assignedById: actorId,
      method,
      notes,
    });
    return decorateOrder(result.order);
  }

  const driver = await loadDriver(driverId);

  // Re-sending the same driver is only a no-op when the parcel is already sitting
  // in their queue. After a failed attempt it is a genuine re-queue for another
  // try, and the status really does change (failed_attempt -> assigned).
  if (order.assignedDriverId === driver.id && order.status === 'assigned') {
    throw conflict(`This order is already assigned to ${driver.fullName}`, {
      currentStatus: order.status,
    });
  }

  const assignment = { driverId: driver.id, assignedById: actorId };

  // A parcel that is already 'assigned' stays 'assigned' — only the driver changes.
  const updated = order.status === 'assigned'
    ? await orders.setAssignment(client, { orderId, driverId: driver.id, assignedById: actorId })
    : (await orders.applyStatusChange(client, {
        order,
        toStatus: 'assigned',
        actorId,
        source: 'manual',
        notes: notes ?? `Assigned to ${driver.fullName}`,
        assignment,
      })).order;

  await recordAssignmentEvent(client, {
    orderId,
    fromDriverId: order.assignedDriverId,
    toDriverId: driver.id,
    assignedById: actorId,
    method,
    notes,
  });

  return decorateOrder(updated);
}

export async function assignOrder({ orderId, driverId, actorId, notes }) {
  return withTransaction((client) =>
    assignWithin(client, { orderId, driverId, actorId, method: 'manual', notes }));
}

/**
 * Auto-batch: hands the unassigned, ready parcels in a zone to one or more
 * drivers, dealt round-robin so a two-driver batch splits evenly.
 *
 * Per-order failures are reported rather than aborting the batch — one parcel
 * grabbed by a driver mid-batch should not stop the other forty.
 */
export async function autoBatchByZone({ zone, driverIds, limit, actorId }) {
  if (!driverIds?.length) throw badRequest('Choose at least one driver');

  const drivers = [];
  for (const id of driverIds) drivers.push(await loadDriver(id));

  return withTransaction(async (client) => {
    // FOR UPDATE SKIP LOCKED: if a dispatcher is batching the same zone at the
    // same moment, each gets a disjoint set instead of blocking or double-assigning.
    const { rows } = await client.query(
      `SELECT id FROM orders
        WHERE assigned_driver_id IS NULL
          AND status = 'ready_for_delivery'
          AND ($1::text IS NULL OR lower(delivery_zone) = lower($1))
        ORDER BY ready_at ASC NULLS LAST, created_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [zone ?? null, limit ?? 200],
    );

    const assigned = [];
    const failures = [];

    for (const [index, row] of rows.entries()) {
      const driver = drivers[index % drivers.length];
      try {
        await client.query(`SAVEPOINT batch_${index}`);
        const order = await assignWithin(client, {
          orderId: row.id,
          driverId: driver.id,
          actorId,
          method: 'auto_batch',
          notes: `Auto-batched for zone ${zone ?? 'all'}`,
        });
        await client.query(`RELEASE SAVEPOINT batch_${index}`);
        assigned.push(order);
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT batch_${index}`);
        failures.push({ orderId: row.id, message: err.message });
      }
    }

    const perDriver = drivers.map((driver) => ({
      driverId: driver.id,
      driverName: driver.fullName,
      count: assigned.filter((o) => o.assignedDriverId === driver.id).length,
    }));

    return { zone: zone ?? null, assignedCount: assigned.length, orders: assigned, perDriver, failures };
  });
}

/** Unassigned, ready-to-go work grouped by zone — the dispatcher's landing view. */
export async function dispatchQueue() {
  const { rows } = await query(
    `SELECT COALESCE(delivery_zone, 'UNZONED') AS zone,
            count(*)::bigint AS waiting,
            min(ready_at) AS oldest_ready_at
       FROM orders
      WHERE assigned_driver_id IS NULL AND status = 'ready_for_delivery'
      GROUP BY COALESCE(delivery_zone, 'UNZONED')
      ORDER BY waiting DESC, zone ASC`,
  );

  return rows.map((row) => ({
    zone: row.zone,
    waiting: row.waiting,
    oldestReadyAt: row.oldest_ready_at,
  }));
}

/** A driver's own queue, ordered the way they will work it. */
export async function driverQueue(driverId) {
  const { orders: rows } = await orders.list({
    driverId,
    status: ['assigned', 'out_for_delivery', 'failed_attempt'],
    limit: 100,
    offset: 0,
    sort: 'ready_at',
    direction: 'asc',
  });

  const decorated = rows.map(decorateOrder);
  return {
    orders: decorated,
    counts: {
      assigned: decorated.filter((o) => o.status === 'assigned').length,
      outForDelivery: decorated.filter((o) => o.status === 'out_for_delivery').length,
      failed: decorated.filter((o) => o.status === 'failed_attempt').length,
    },
  };
}

export async function listAssignmentHistory(orderId) {
  const { rows } = await query(
    `SELECT e.*, f.full_name AS from_driver_name, t.full_name AS to_driver_name,
            a.full_name AS assigned_by_name
       FROM order_assignment_events e
       LEFT JOIN users f ON f.id = e.from_driver_id
       LEFT JOIN users t ON t.id = e.to_driver_id
       LEFT JOIN users a ON a.id = e.assigned_by_id
      WHERE e.order_id = $1
      ORDER BY e.created_at ASC`,
    [orderId],
  );
  return rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    fromDriverId: row.from_driver_id,
    fromDriverName: row.from_driver_name,
    toDriverId: row.to_driver_id,
    toDriverName: row.to_driver_name,
    assignedById: row.assigned_by_id,
    assignedByName: row.assigned_by_name,
    method: row.method,
    notes: row.notes,
    createdAt: row.created_at,
  }));
}
