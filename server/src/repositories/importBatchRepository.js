import { query } from '../db/pool.js';

export function mapBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    uploadedById: row.uploaded_by_id,
    uploadedByName: row.uploaded_by_name ?? null,
    totalRows: row.total_rows,
    createdCount: row.created_count,
    failedCount: row.failed_count,
    rowErrors: row.row_errors,
    createdAt: row.created_at,
  };
}

export async function create(client, { filename, uploadedById, totalRows }) {
  const { rows } = await client.query(
    `INSERT INTO order_import_batches (filename, uploaded_by_id, total_rows)
     VALUES ($1,$2,$3) RETURNING *`,
    [filename ?? null, uploadedById ?? null, totalRows],
  );
  return mapBatch(rows[0]);
}

export async function finalise(client, id, { createdCount, failedCount, rowErrors }) {
  const { rows } = await client.query(
    `UPDATE order_import_batches
        SET created_count = $2, failed_count = $3, row_errors = $4::jsonb
      WHERE id = $1
      RETURNING *`,
    [id, createdCount, failedCount, JSON.stringify(rowErrors ?? [])],
  );
  return mapBatch(rows[0]);
}

export async function findById(id) {
  const { rows } = await query(
    `SELECT b.*, u.full_name AS uploaded_by_name
       FROM order_import_batches b
       LEFT JOIN users u ON u.id = b.uploaded_by_id
      WHERE b.id = $1`,
    [id],
  );
  return mapBatch(rows[0]);
}

export async function list({ limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT b.*, u.full_name AS uploaded_by_name
       FROM order_import_batches b
       LEFT JOIN users u ON u.id = b.uploaded_by_id
      ORDER BY b.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map(mapBatch);
}
