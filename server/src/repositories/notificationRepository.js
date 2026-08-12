import { query } from '../db/pool.js';

export function mapNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    channel: row.channel,
    recipient: row.recipient,
    templateKey: row.template_key,
    statusEventId: row.status_event_id,
    status: row.status,
    provider: row.provider,
    providerRef: row.provider_ref,
    error: row.error,
    attempts: row.attempts,
    payload: row.payload,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

/**
 * Claims the right to send one message.
 *
 * ON CONFLICT DO NOTHING against the (status_event_id, channel) unique index is
 * what makes notification dispatch idempotent: replaying a status change — or
 * two workers racing — produces no row the second time, and the caller sends
 * nothing. Returns null when the message was already claimed.
 */
export async function claim({ orderId, channel, recipient, templateKey, statusEventId, payload }) {
  const { rows } = await query(
    `INSERT INTO notifications
       (order_id, channel, recipient, template_key, status_event_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (status_event_id, channel) DO NOTHING
     RETURNING *`,
    [orderId, channel, recipient, templateKey, statusEventId, JSON.stringify(payload ?? {})],
  );
  return mapNotification(rows[0]);
}

/**
 * Has this customer already been told this particular thing?
 *
 * The unique index only dedupes per status event. This dedupes per order, which
 * is what stops an un-assign / re-assign cycle from re-announcing dispatch.
 */
export async function existsForTemplate({ orderId, templateKey, channel }) {
  const { rows } = await query(
    `SELECT 1 FROM notifications
      WHERE order_id = $1 AND template_key = $2 AND channel = $3
        AND status IN ('sent', 'pending')
      LIMIT 1`,
    [orderId, templateKey, channel],
  );
  return rows.length > 0;
}

export async function markSent(id, { provider, providerRef }) {
  const { rows } = await query(
    `UPDATE notifications
        SET status = 'sent', provider = $2, provider_ref = $3,
            sent_at = clock_timestamp(), attempts = attempts + 1, error = NULL
      WHERE id = $1
      RETURNING *`,
    [id, provider, providerRef],
  );
  return mapNotification(rows[0]);
}

export async function markSkipped(id, reason) {
  const { rows } = await query(
    `UPDATE notifications
        SET status = 'skipped', error = $2, attempts = attempts + 1
      WHERE id = $1
      RETURNING *`,
    [id, reason],
  );
  return mapNotification(rows[0]);
}

export async function markFailed(id, error) {
  const { rows } = await query(
    `UPDATE notifications
        SET status = 'failed', error = $2, attempts = attempts + 1
      WHERE id = $1
      RETURNING *`,
    [id, String(error).slice(0, 1000)],
  );
  return mapNotification(rows[0]);
}

export async function listForOrder(orderId) {
  const { rows } = await query(
    'SELECT * FROM notifications WHERE order_id = $1 ORDER BY created_at ASC',
    [orderId],
  );
  return rows.map(mapNotification);
}

export async function listRecent({ limit = 50, status } = {}) {
  const params = [];
  const where = status ? `WHERE status = $${params.push(status)}` : '';
  const { rows } = await query(
    `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT $${params.push(limit)}`,
    params,
  );
  return rows.map(mapNotification);
}

/** Messages that failed and are worth retrying. */
export async function listRetryable({ limit = 50, maxAttempts = 3 } = {}) {
  const { rows } = await query(
    `SELECT * FROM notifications
      WHERE status = 'failed' AND attempts < $2
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit, maxAttempts],
  );
  return rows.map(mapNotification);
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM notifications WHERE id = $1', [id]);
  return mapNotification(rows[0]);
}
