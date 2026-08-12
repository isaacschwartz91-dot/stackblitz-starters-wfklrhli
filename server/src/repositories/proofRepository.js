import { query as poolQuery } from '../db/pool.js';

export function mapProof(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    attemptNumber: row.attempt_number,
    outcome: row.outcome,
    scanEventId: row.scan_event_id,
    recipientName: row.recipient_name,
    failureReason: row.failure_reason,
    notes: row.notes,
    photoKey: row.photo_key,
    signatureKey: row.signature_key,
    capturedById: row.captured_by_id,
    capturedByName: row.captured_by_name ?? null,
    capturedAt: row.captured_at,
  };
}

const run = (client, text, params) => (client ?? { query: poolQuery }).query(text, params);

export async function insert(client, {
  orderId,
  attemptNumber,
  outcome,
  scanEventId = null,
  recipientName = null,
  failureReason = null,
  notes = null,
  photoKey = null,
  signatureKey = null,
  capturedById = null,
}) {
  const { rows } = await run(
    client,
    `INSERT INTO proof_of_delivery
       (order_id, attempt_number, outcome, scan_event_id, recipient_name,
        failure_reason, notes, photo_key, signature_key, captured_by_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [orderId, attemptNumber, outcome, scanEventId, recipientName,
     failureReason, notes, photoKey, signatureKey, capturedById],
  );
  return mapProof(rows[0]);
}

/** Fills in evidence captured after the drop-off scan (slow uploads, retries). */
export async function attachMedia(client, id, { photoKey, signatureKey, recipientName, notes }) {
  const assignments = [];
  const params = [id];
  const push = (value) => `$${params.push(value)}`;

  if (photoKey !== undefined) assignments.push(`photo_key = ${push(photoKey)}`);
  if (signatureKey !== undefined) assignments.push(`signature_key = ${push(signatureKey)}`);
  if (recipientName !== undefined) assignments.push(`recipient_name = ${push(recipientName)}`);
  if (notes !== undefined) assignments.push(`notes = ${push(notes)}`);
  if (assignments.length === 0) return findById(id, client);

  const { rows } = await run(
    client,
    `UPDATE proof_of_delivery SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`,
    params,
  );
  return mapProof(rows[0]);
}

export async function findById(id, client) {
  const { rows } = await run(client, 'SELECT * FROM proof_of_delivery WHERE id = $1', [id]);
  return mapProof(rows[0]);
}

export async function findLatestForOrder(orderId, client) {
  const { rows } = await run(
    client,
    `SELECT * FROM proof_of_delivery
      WHERE order_id = $1
      ORDER BY attempt_number DESC
      LIMIT 1`,
    [orderId],
  );
  return mapProof(rows[0]);
}

export async function findByOrderAndAttempt(orderId, attemptNumber, client) {
  const { rows } = await run(
    client,
    'SELECT * FROM proof_of_delivery WHERE order_id = $1 AND attempt_number = $2',
    [orderId, attemptNumber],
  );
  return mapProof(rows[0]);
}

export async function listForOrder(orderId) {
  const { rows } = await poolQuery(
    `SELECT p.*, u.full_name AS captured_by_name
       FROM proof_of_delivery p
       LEFT JOIN users u ON u.id = p.captured_by_id
      WHERE p.order_id = $1
      ORDER BY p.attempt_number ASC`,
    [orderId],
  );
  return rows.map(mapProof);
}
