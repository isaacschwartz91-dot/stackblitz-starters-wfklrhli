import bcrypt from 'bcryptjs';

import { config } from '../config.js';
import { query } from '../db/pool.js';

export function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    phone: row.phone,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PUBLIC_COLUMNS = 'id, email, full_name, role, phone, is_active, created_at, updated_at';

export function hashPassword(plain) {
  return bcrypt.hash(plain, config.bcryptRounds);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export async function findById(id) {
  const { rows } = await query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
  return mapUser(rows[0]);
}

/** Includes the hash — only for the login path. */
export async function findByEmailWithHash(email) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  if (!rows[0]) return null;
  return { ...mapUser(rows[0]), passwordHash: rows[0].password_hash };
}

export async function list({ role, includeInactive = false } = {}) {
  const where = [];
  const params = [];
  if (role) where.push(`role = $${params.push(role)}`);
  if (!includeInactive) where.push('is_active');

  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM users
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY full_name ASC`,
    params,
  );
  return rows.map(mapUser);
}

export async function create({ email, fullName, password, role, phone = null }, client) {
  const passwordHash = await hashPassword(password);
  const runner = client ?? { query };
  const { rows } = await runner.query(
    `INSERT INTO users (email, full_name, password_hash, role, phone)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING ${PUBLIC_COLUMNS}`,
    [email.trim(), fullName.trim(), passwordHash, role, phone],
  );
  return mapUser(rows[0]);
}

export async function update(id, patch) {
  const columns = { fullName: 'full_name', phone: 'phone', role: 'role', isActive: 'is_active' };
  const assignments = [];
  const params = [id];

  for (const [field, column] of Object.entries(columns)) {
    if (field in patch) assignments.push(`${column} = $${params.push(patch[field])}`);
  }
  if ('password' in patch && patch.password) {
    assignments.push(`password_hash = $${params.push(await hashPassword(patch.password))}`);
  }
  if (assignments.length === 0) return findById(id);

  const { rows } = await query(
    `UPDATE users SET ${assignments.join(', ')} WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    params,
  );
  return mapUser(rows[0]);
}

/** Active drivers with their current open workload, for the assignment screen. */
export async function listDriversWithLoad() {
  const { rows } = await query(
    `SELECT u.id, u.email, u.full_name, u.role, u.phone, u.is_active, u.created_at, u.updated_at,
            count(o.id) FILTER (WHERE o.status IN ('assigned','out_for_delivery'))::bigint AS open_orders,
            count(o.id) FILTER (WHERE o.status = 'out_for_delivery')::bigint AS out_for_delivery,
            count(o.id) FILTER (
              WHERE o.status = 'delivered' AND o.delivered_at >= date_trunc('day', now())
            )::bigint AS delivered_today
       FROM users u
       LEFT JOIN orders o ON o.assigned_driver_id = u.id
      WHERE u.role = 'driver' AND u.is_active
      GROUP BY u.id
      ORDER BY u.full_name ASC`,
  );
  return rows.map((row) => ({
    ...mapUser(row),
    openOrders: row.open_orders,
    outForDelivery: row.out_for_delivery,
    deliveredToday: row.delivered_today,
  }));
}
