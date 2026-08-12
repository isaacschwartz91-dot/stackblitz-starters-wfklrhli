import { query as poolQuery } from '../db/pool.js';

export function mapScanEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    scannedValue: row.scanned_value,
    scanType: row.scan_type,
    scannedById: row.scanned_by_id,
    scannedByName: row.scanned_by_name ?? null,
    accepted: row.accepted,
    rejectionReason: row.rejection_reason,
    deviceLabel: row.device_label,
    latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
    longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
    createdAt: row.created_at,
    orderRef: row.order_ref ?? undefined,
  };
}

const run = (client, text, params) => (client ?? { query: poolQuery }).query(text, params);

export async function insert(client, {
  orderId = null,
  scannedValue,
  scanType,
  scannedById,
  accepted,
  rejectionReason = null,
  deviceLabel = null,
  latitude = null,
  longitude = null,
}) {
  const { rows } = await run(
    client,
    `INSERT INTO scan_events
       (order_id, scanned_value, scan_type, scanned_by_id, accepted, rejection_reason,
        device_label, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [orderId, scannedValue, scanType, scannedById, accepted, rejectionReason,
     deviceLabel, latitude, longitude],
  );
  return mapScanEvent(rows[0]);
}

export async function listForOrder(orderId) {
  const { rows } = await poolQuery(
    `SELECT s.*, u.full_name AS scanned_by_name
       FROM scan_events s
       LEFT JOIN users u ON u.id = s.scanned_by_id
      WHERE s.order_id = $1
      ORDER BY s.created_at ASC`,
    [orderId],
  );
  return rows.map(mapScanEvent);
}

/** Recent scan activity, for the admin "what is being scanned" view. */
export async function listRecent({ limit = 50, scannedById, acceptedOnly = false } = {}) {
  const where = [];
  const params = [];
  if (scannedById) where.push(`s.scanned_by_id = $${params.push(scannedById)}`);
  if (acceptedOnly) where.push('s.accepted');

  const { rows } = await poolQuery(
    `SELECT s.*, u.full_name AS scanned_by_name, o.order_ref
       FROM scan_events s
       LEFT JOIN users u ON u.id = s.scanned_by_id
       LEFT JOIN orders o ON o.id = s.order_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.created_at DESC
      LIMIT $${params.push(limit)}`,
    params,
  );
  return rows.map(mapScanEvent);
}
