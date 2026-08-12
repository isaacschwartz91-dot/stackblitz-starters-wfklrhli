import { query as poolQuery } from '../db/pool.js';

/**
 * Column list shared by every order read, so the API shape can't drift between
 * "list" and "get by id".
 */
const ORDER_COLUMNS = `
  o.id, o.order_ref, o.barcode_value, o.tracking_token, o.status,
  o.customer_name, o.customer_phone, o.customer_email,
  o.address_line1, o.address_line2, o.city, o.region, o.postal_code, o.country,
  o.delivery_zone, o.delivery_notes,
  o.assigned_driver_id, o.assigned_by_id, o.assigned_at,
  o.ready_at, o.picked_up_at, o.delivered_at, o.attempt_count,
  o.created_by_id, o.import_batch_id, o.created_at, o.updated_at
`;

const ORDER_SELECT = `
  SELECT ${ORDER_COLUMNS},
         d.full_name AS assigned_driver_name,
         d.phone     AS assigned_driver_phone
    FROM orders o
    LEFT JOIN users d ON d.id = o.assigned_driver_id
`;

export function mapOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderRef: row.order_ref,
    barcodeValue: row.barcode_value,
    trackingToken: row.tracking_token,
    status: row.status,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    country: row.country,
    deliveryZone: row.delivery_zone,
    deliveryNotes: row.delivery_notes,
    assignedDriverId: row.assigned_driver_id,
    assignedDriverName: row.assigned_driver_name ?? null,
    assignedDriverPhone: row.assigned_driver_phone ?? null,
    assignedById: row.assigned_by_id,
    assignedAt: row.assigned_at,
    readyAt: row.ready_at,
    pickedUpAt: row.picked_up_at,
    deliveredAt: row.delivered_at,
    attemptCount: row.attempt_count,
    createdById: row.created_by_id,
    importBatchId: row.import_batch_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapStatusEvent(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorId: row.actor_id,
    actorName: row.actor_name ?? null,
    source: row.source,
    scanEventId: row.scan_event_id,
    notes: row.notes,
    latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
    longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
    createdAt: row.created_at,
  };
}

const run = (client, text, params) => (client ?? { query: poolQuery }).query(text, params);

export async function findById(id, client) {
  const { rows } = await run(client, `${ORDER_SELECT} WHERE o.id = $1`, [id]);
  return mapOrder(rows[0]);
}

/**
 * Locks the order row for the duration of the transaction. Every status change
 * goes through this: without it, two drivers scanning the same parcel at the
 * same moment could both pass the transition check.
 */
export async function findByIdForUpdate(client, id) {
  const { rows } = await client.query(
    'SELECT id FROM orders WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (rows.length === 0) return null;
  return findById(id, client);
}

export async function findByBarcode(barcodeValue, client) {
  const { rows } = await run(client, `${ORDER_SELECT} WHERE o.barcode_value = $1`, [barcodeValue]);
  return mapOrder(rows[0]);
}

export async function findByBarcodeForUpdate(client, barcodeValue) {
  const { rows } = await client.query(
    'SELECT id FROM orders WHERE barcode_value = $1 FOR UPDATE',
    [barcodeValue],
  );
  if (rows.length === 0) return null;
  return findById(rows[0].id, client);
}

export async function findByTrackingToken(token) {
  const { rows } = await poolQuery(`${ORDER_SELECT} WHERE o.tracking_token = $1`, [token]);
  return mapOrder(rows[0]);
}

export async function findByOrderRef(orderRef, client) {
  const { rows } = await run(client, `${ORDER_SELECT} WHERE lower(o.order_ref) = lower($1)`, [orderRef]);
  return mapOrder(rows[0]);
}

/** Escapes LIKE wildcards in user input so a search for "100%" isn't a wildcard. */
function likeParam(value) {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export async function list(filters = {}) {
  const {
    status,
    driverId,
    zone,
    q,
    createdFrom,
    createdTo,
    limit = 25,
    offset = 0,
    sort = 'created_at',
    direction = 'desc',
  } = filters;

  const where = [];
  const params = [];
  const push = (value) => `$${params.push(value)}`;

  if (status?.length) where.push(`o.status = ANY(${push(status)}::order_status[])`);

  if (driverId === 'unassigned') where.push('o.assigned_driver_id IS NULL');
  else if (driverId) where.push(`o.assigned_driver_id = ${push(driverId)}`);

  if (zone) where.push(`lower(o.delivery_zone) = lower(${push(zone)})`);
  if (createdFrom) where.push(`o.created_at >= ${push(createdFrom)}`);
  if (createdTo) where.push(`o.created_at <= ${push(createdTo)}`);

  if (q) {
    const term = push(likeParam(q));
    where.push(`(
      o.order_ref ILIKE ${term} OR
      o.customer_name ILIKE ${term} OR
      o.barcode_value ILIKE ${term} OR
      o.customer_phone ILIKE ${term} OR
      o.address_line1 ILIKE ${term}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Whitelisted, never interpolated from raw input.
  const sortColumns = {
    created_at: 'o.created_at',
    ready_at: 'o.ready_at',
    order_ref: 'o.order_ref',
    status: 'o.status',
  };
  const sortColumn = sortColumns[sort] ?? sortColumns.created_at;
  const sortDirection = direction === 'asc' ? 'ASC' : 'DESC';
  const nulls = sortDirection === 'ASC' ? 'NULLS FIRST' : 'NULLS LAST';

  const limitParam = push(limit);
  const offsetParam = push(offset);

  const { rows } = await poolQuery(
    `${ORDER_SELECT} ${whereSql}
     ORDER BY ${sortColumn} ${sortDirection} ${nulls}, o.id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  );

  // Count without the limit/offset params.
  const { rows: countRows } = await poolQuery(
    `SELECT count(*)::bigint AS total FROM orders o ${whereSql}`,
    params.slice(0, params.length - 2),
  );

  return { orders: rows.map(mapOrder), total: countRows[0].total };
}

export async function insert(client, data) {
  const { rows } = await client.query(
    `INSERT INTO orders (
       order_ref, barcode_value, tracking_token,
       customer_name, customer_phone, customer_email,
       address_line1, address_line2, city, region, postal_code, country,
       delivery_zone, delivery_notes, created_by_id, import_batch_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id`,
    [
      data.orderRef,
      data.barcodeValue,
      data.trackingToken,
      data.customerName,
      data.customerPhone ?? null,
      data.customerEmail ?? null,
      data.addressLine1,
      data.addressLine2 ?? null,
      data.city ?? null,
      data.region ?? null,
      data.postalCode ?? null,
      data.country ?? null,
      data.deliveryZone ?? null,
      data.deliveryNotes ?? null,
      data.createdById ?? null,
      data.importBatchId ?? null,
    ],
  );
  return findById(rows[0].id, client);
}

const UPDATABLE_COLUMNS = {
  customerName: 'customer_name',
  customerPhone: 'customer_phone',
  customerEmail: 'customer_email',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  city: 'city',
  region: 'region',
  postalCode: 'postal_code',
  country: 'country',
  deliveryZone: 'delivery_zone',
  deliveryNotes: 'delivery_notes',
};

export async function update(client, id, patch) {
  const assignments = [];
  const params = [];
  const push = (value) => `$${params.push(value)}`;

  for (const [field, column] of Object.entries(UPDATABLE_COLUMNS)) {
    if (field in patch) assignments.push(`${column} = ${push(patch[field] ?? null)}`);
  }
  if (assignments.length === 0) return findById(id, client);

  const idParam = push(id);
  await client.query(`UPDATE orders SET ${assignments.join(', ')} WHERE id = ${idParam}`, params);
  return findById(id, client);
}

export async function remove(client, id) {
  const { rowCount } = await client.query('DELETE FROM orders WHERE id = $1', [id]);
  return rowCount > 0;
}

/**
 * Writes a status transition: updates the order row (including the denormalised
 * delivery clock) and appends the audit row. Callers must already hold the row
 * lock from findByIdForUpdate / findByBarcodeForUpdate and must have validated
 * the transition against the status machine.
 */
export async function applyStatusChange(client, {
  order,
  toStatus,
  actorId = null,
  source,
  scanEventId = null,
  notes = null,
  latitude = null,
  longitude = null,
  assignment,
}) {
  const assignments = ['status = $2'];
  const params = [order.id, toStatus];
  const push = (value) => `$${params.push(value)}`;

  // clock_timestamp() rather than now(): a request that moves an order through
  // two statuses (self-assign then pickup) must not stamp both with the
  // transaction's start time.
  //
  // ready_at is COALESCEd: a redelivery must not restart the delivery clock,
  // otherwise scan-to-delivery time under-reports every reattempted order.
  if (toStatus === 'ready_for_delivery') assignments.push('ready_at = COALESCE(ready_at, clock_timestamp())');
  if (toStatus === 'out_for_delivery') assignments.push('picked_up_at = clock_timestamp()');
  if (toStatus === 'delivered') assignments.push('delivered_at = clock_timestamp()', 'attempt_count = attempt_count + 1');
  if (toStatus === 'failed_attempt') assignments.push('attempt_count = attempt_count + 1');

  if (assignment !== undefined) {
    if (assignment === null) {
      assignments.push('assigned_driver_id = NULL', 'assigned_by_id = NULL', 'assigned_at = NULL');
    } else {
      assignments.push(
        `assigned_driver_id = ${push(assignment.driverId)}`,
        `assigned_by_id = ${push(assignment.assignedById ?? null)}`,
        'assigned_at = now()',
      );
    }
  }

  await client.query(
    `UPDATE orders SET ${assignments.join(', ')} WHERE id = $1`,
    params,
  );

  const { rows } = await client.query(
    `INSERT INTO order_status_events
       (order_id, from_status, to_status, actor_id, source, scan_event_id, notes, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [order.id, order.status, toStatus, actorId, source, scanEventId, notes, latitude, longitude],
  );

  return {
    order: await findById(order.id, client),
    statusEvent: mapStatusEvent(rows[0]),
  };
}

/** Records the row created at order creation time (from_status is NULL). */
export async function recordInitialStatus(client, { orderId, actorId, source, notes = null }) {
  const { rows } = await client.query(
    `INSERT INTO order_status_events (order_id, from_status, to_status, actor_id, source, notes)
     VALUES ($1, NULL, 'created', $2, $3, $4)
     RETURNING *`,
    [orderId, actorId, source, notes],
  );
  return mapStatusEvent(rows[0]);
}

export async function listStatusEvents(orderId, client) {
  const { rows } = await run(
    client,
    `SELECT e.*, u.full_name AS actor_name
       FROM order_status_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.order_id = $1
      ORDER BY e.created_at ASC, e.id ASC`,
    [orderId],
  );
  return rows.map(mapStatusEvent);
}

/** Assignment without a status change (e.g. re-assigning an already-assigned order). */
export async function setAssignment(client, { orderId, driverId, assignedById }) {
  await client.query(
    `UPDATE orders
        SET assigned_driver_id = $2,
            assigned_by_id     = $3,
            assigned_at        = CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END
      WHERE id = $1`,
    [orderId, driverId, driverId ? assignedById : null],
  );
  return findById(orderId, client);
}
