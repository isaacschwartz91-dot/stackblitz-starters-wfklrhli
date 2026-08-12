/**
 * Admin reporting.
 *
 * Every figure here is derived from the delivery clock on `orders`
 * (ready_at -> delivered_at) or from the status log, so the numbers agree with
 * what the order detail screen shows. Nothing is recomputed from scan events,
 * which include rejected scans and would inflate the counts.
 */
import { query } from '../db/pool.js';

/** Clamps a reporting window and defaults it to the last 30 days. */
export function resolveRange({ from, to } = {}) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Invalid date range');
  }
  return { from: start, to: end };
}

const seconds = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * Scan-to-delivery time: from the label-activation scan that started tracking to
 * the drop-off scan that completed it. Percentiles rather than a bare average,
 * because one parcel stuck in a depot for a week hides behind a mean.
 */
export async function scanToDeliveryTime({ from, to, zone, driverId }) {
  const params = [from, to];
  const filters = [];
  if (zone) filters.push(`AND lower(o.delivery_zone) = lower($${params.push(zone)})`);
  if (driverId) filters.push(`AND o.assigned_driver_id = $${params.push(driverId)}`);

  const { rows } = await query(
    `SELECT count(*)::bigint AS delivered_count,
            avg(extract(epoch FROM (o.delivered_at - o.ready_at)))          AS avg_seconds,
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY extract(epoch FROM (o.delivered_at - o.ready_at)))   AS median_seconds,
            percentile_cont(0.9) WITHIN GROUP (
              ORDER BY extract(epoch FROM (o.delivered_at - o.ready_at)))   AS p90_seconds,
            min(extract(epoch FROM (o.delivered_at - o.ready_at)))          AS fastest_seconds,
            max(extract(epoch FROM (o.delivered_at - o.ready_at)))          AS slowest_seconds
       FROM orders o
      WHERE o.status = 'delivered'
        AND o.delivered_at IS NOT NULL
        AND o.ready_at IS NOT NULL
        AND o.delivered_at BETWEEN $1 AND $2
        ${filters.join(' ')}`,
    params,
  );

  const row = rows[0];
  return {
    deliveredCount: row.delivered_count,
    avgSeconds: seconds(row.avg_seconds),
    medianSeconds: seconds(row.median_seconds),
    p90Seconds: seconds(row.p90_seconds),
    fastestSeconds: seconds(row.fastest_seconds),
    slowestSeconds: seconds(row.slowest_seconds),
  };
}

/**
 * Attribution rule shared by the per-driver reports: credit the driver who
 * actually made the scan, falling back to the order's assigned driver when a
 * staff member completed it on their behalf. Written once here so the
 * per-day and totals reports can never disagree about who delivered what.
 */
const DRIVER_ATTRIBUTION = `
       JOIN orders o ON o.id = e.order_id
  LEFT JOIN users du ON du.id = e.actor_id AND du.role = 'driver'
  LEFT JOIN users au ON au.id = o.assigned_driver_id
`;
const ATTRIBUTED_DRIVER_ID = 'COALESCE(du.id, o.assigned_driver_id)';
const ATTRIBUTED_DRIVER_NAME = 'COALESCE(du.full_name, au.full_name)';

/** Deliveries per driver per day — the core operational report. */
export async function deliveriesPerDriver({ from, to, driverId }) {
  const params = [from, to];
  const filter = driverId ? `AND ${ATTRIBUTED_DRIVER_ID} = $${params.push(driverId)}` : '';

  const { rows } = await query(
    `SELECT ${ATTRIBUTED_DRIVER_ID}   AS driver_id,
            ${ATTRIBUTED_DRIVER_NAME} AS driver_name,
            date_trunc('day', e.created_at)::date AS day,
            count(*)::bigint AS delivered,
            avg(extract(epoch FROM (o.delivered_at - o.ready_at))) AS avg_seconds
       FROM order_status_events e
       ${DRIVER_ATTRIBUTION}
      WHERE e.to_status = 'delivered'
        AND e.created_at BETWEEN $1 AND $2
        AND ${ATTRIBUTED_DRIVER_ID} IS NOT NULL
        ${filter}
      GROUP BY 1, 2, 3
      ORDER BY day DESC, delivered DESC`,
    params,
  );

  return rows.map((row) => ({
    driverId: row.driver_id,
    driverName: row.driver_name,
    day: row.day,
    delivered: row.delivered,
    avgSeconds: seconds(row.avg_seconds),
  }));
}

/** Per-driver totals across the whole window, for the leaderboard table. */
export async function driverTotals({ from, to }) {
  // Attempts and open workload are aggregated separately and only then joined
  // onto users. Joining order_status_events and orders in one pass multiplies
  // each event by the driver's order count.
  const { rows } = await query(
    `WITH attempts AS (
       SELECT ${ATTRIBUTED_DRIVER_ID} AS driver_id,
              count(*) FILTER (WHERE e.to_status = 'delivered')::bigint      AS delivered,
              count(*) FILTER (WHERE e.to_status = 'failed_attempt')::bigint AS failed_attempts
         FROM order_status_events e
         ${DRIVER_ATTRIBUTION}
        WHERE e.to_status IN ('delivered', 'failed_attempt')
          AND e.created_at BETWEEN $1 AND $2
        GROUP BY 1
     ),
     open_work AS (
       SELECT assigned_driver_id AS driver_id, count(*)::bigint AS open_orders
         FROM orders
        WHERE status IN ('assigned', 'out_for_delivery')
          AND assigned_driver_id IS NOT NULL
        GROUP BY 1
     )
     SELECT u.id AS driver_id,
            u.full_name AS driver_name,
            COALESCE(a.delivered, 0)       AS delivered,
            COALESCE(a.failed_attempts, 0) AS failed_attempts,
            COALESCE(w.open_orders, 0)     AS open_orders
       FROM users u
       LEFT JOIN attempts  a ON a.driver_id = u.id
       LEFT JOIN open_work w ON w.driver_id = u.id
      WHERE u.role = 'driver'
      ORDER BY delivered DESC, u.full_name ASC`,
    [from, to],
  );

  return rows.map((row) => {
    const attempts = row.delivered + row.failed_attempts;
    return {
      driverId: row.driver_id,
      driverName: row.driver_name,
      delivered: row.delivered,
      failedAttempts: row.failed_attempts,
      openOrders: row.open_orders,
      // Null rather than 0 when a driver made no attempts: "0% success" for
      // somebody who did not work that day would be a lie.
      successRate: attempts > 0 ? row.delivered / attempts : null,
    };
  });
}

/**
 * Failed and reattempted deliveries.
 *
 * `reattempted` counts orders that failed at least once and were later
 * delivered; `stillOpen` counts the ones that have not been resolved yet.
 */
export async function failedDeliveries({ from, to }) {
  const { rows } = await query(
    `WITH failures AS (
       SELECT o.id,
              o.order_ref,
              o.status,
              o.delivery_zone,
              o.attempt_count,
              o.assigned_driver_id,
              count(e.id)::bigint AS failure_count,
              max(e.created_at)   AS last_failed_at
         FROM orders o
         JOIN order_status_events e
           ON e.order_id = o.id
          AND e.to_status = 'failed_attempt'
          AND e.created_at BETWEEN $1 AND $2
        GROUP BY o.id
     )
     SELECT f.*, u.full_name AS driver_name,
            (SELECT e2.notes
               FROM order_status_events e2
              WHERE e2.order_id = f.id AND e2.to_status = 'failed_attempt'
              ORDER BY e2.created_at DESC
              LIMIT 1) AS last_failure_reason
       FROM failures f
       LEFT JOIN users u ON u.id = f.assigned_driver_id
      ORDER BY f.last_failed_at DESC`,
    [from, to],
  );

  const orders = rows.map((row) => ({
    orderId: row.id,
    orderRef: row.order_ref,
    status: row.status,
    deliveryZone: row.delivery_zone,
    attemptCount: row.attempt_count,
    failureCount: row.failure_count,
    lastFailedAt: row.last_failed_at,
    lastFailureReason: row.last_failure_reason,
    driverName: row.driver_name,
  }));

  return {
    orders,
    summary: {
      ordersWithFailures: orders.length,
      totalFailedAttempts: orders.reduce((sum, o) => sum + o.failureCount, 0),
      reattemptedAndDelivered: orders.filter((o) => o.status === 'delivered').length,
      stillOpen: orders.filter((o) => !['delivered', 'cancelled'].includes(o.status)).length,
    },
  };
}

/** Headline tiles for the dashboard. */
export async function summary({ from, to }) {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE o.created_at BETWEEN $1 AND $2)::bigint            AS created,
       count(*) FILTER (WHERE o.delivered_at BETWEEN $1 AND $2)::bigint          AS delivered,
       count(*) FILTER (WHERE o.status IN ('ready_for_delivery','assigned','out_for_delivery'))::bigint AS in_flight,
       count(*) FILTER (WHERE o.status = 'ready_for_delivery'
                          AND o.assigned_driver_id IS NULL)::bigint              AS awaiting_assignment,
       count(*) FILTER (WHERE o.status = 'failed_attempt')::bigint               AS failed_open,
       count(*) FILTER (WHERE o.status = 'created')::bigint                      AS not_yet_scanned
     FROM orders o`,
    [from, to],
  );

  const timing = await scanToDeliveryTime({ from, to });

  return {
    range: { from, to },
    orders: {
      created: rows[0].created,
      delivered: rows[0].delivered,
      inFlight: rows[0].in_flight,
      awaitingAssignment: rows[0].awaiting_assignment,
      failedOpen: rows[0].failed_open,
      notYetScanned: rows[0].not_yet_scanned,
    },
    timing,
  };
}

/** Daily volume, for the dashboard chart. */
export async function dailyVolume({ from, to }) {
  const { rows } = await query(
    `SELECT d.day::date AS day,
            count(c.id)::bigint AS created,
            count(v.id)::bigint AS delivered,
            count(f.id)::bigint AS failed
       FROM generate_series(date_trunc('day', $1::timestamptz),
                            date_trunc('day', $2::timestamptz),
                            interval '1 day') AS d(day)
       LEFT JOIN orders c ON date_trunc('day', c.created_at)   = d.day
       LEFT JOIN orders v ON date_trunc('day', v.delivered_at) = d.day
       LEFT JOIN order_status_events f
              ON date_trunc('day', f.created_at) = d.day AND f.to_status = 'failed_attempt'
      GROUP BY d.day
      ORDER BY d.day ASC`,
    [from, to],
  );

  return rows.map((row) => ({
    day: row.day,
    created: row.created,
    delivered: row.delivered,
    failed: row.failed,
  }));
}

// --- CSV export -------------------------------------------------------------

/** RFC 4180 quoting. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers, rows) {
  const lines = [headers.map((h) => csvCell(h.label)).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(h.value(row))).join(','));
  }
  // CRLF: Excel is the destination for most of these.
  return `${lines.join('\r\n')}\r\n`;
}

const formatDuration = (secs) => {
  if (secs === null || secs === undefined) return '';
  const total = Math.round(secs);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
};

export const CSV_REPORTS = {
  deliveries: {
    filename: 'deliveries',
    async rows({ from, to }) {
      const { rows } = await query(
        `SELECT o.order_ref, o.status, o.delivery_zone, o.customer_name,
                o.city, o.postal_code, o.attempt_count,
                o.created_at, o.ready_at, o.picked_up_at, o.delivered_at,
                u.full_name AS driver_name,
                extract(epoch FROM (o.delivered_at - o.ready_at)) AS scan_to_delivery_seconds
           FROM orders o
           LEFT JOIN users u ON u.id = o.assigned_driver_id
          WHERE o.created_at BETWEEN $1 AND $2
          ORDER BY o.created_at DESC`,
        [from, to],
      );
      return rows;
    },
    headers: [
      { label: 'Order reference', value: (r) => r.order_ref },
      { label: 'Status', value: (r) => r.status },
      { label: 'Zone', value: (r) => r.delivery_zone },
      { label: 'Customer', value: (r) => r.customer_name },
      { label: 'City', value: (r) => r.city },
      { label: 'Postal code', value: (r) => r.postal_code },
      { label: 'Driver', value: (r) => r.driver_name },
      { label: 'Attempts', value: (r) => r.attempt_count },
      { label: 'Created at', value: (r) => r.created_at },
      { label: 'Ready at', value: (r) => r.ready_at },
      { label: 'Picked up at', value: (r) => r.picked_up_at },
      { label: 'Delivered at', value: (r) => r.delivered_at },
      { label: 'Scan to delivery', value: (r) => formatDuration(r.scan_to_delivery_seconds) },
      {
        label: 'Scan to delivery (seconds)',
        value: (r) => (r.scan_to_delivery_seconds === null ? '' : Math.round(r.scan_to_delivery_seconds)),
      },
    ],
  },

  drivers: {
    filename: 'deliveries-per-driver',
    rows: (range) => deliveriesPerDriver(range),
    headers: [
      { label: 'Day', value: (r) => (r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day) },
      { label: 'Driver', value: (r) => r.driverName },
      { label: 'Delivered', value: (r) => r.delivered },
      { label: 'Average scan to delivery', value: (r) => formatDuration(r.avgSeconds) },
    ],
  },

  failures: {
    filename: 'failed-deliveries',
    rows: async (range) => (await failedDeliveries(range)).orders,
    headers: [
      { label: 'Order reference', value: (r) => r.orderRef },
      { label: 'Current status', value: (r) => r.status },
      { label: 'Zone', value: (r) => r.deliveryZone },
      { label: 'Driver', value: (r) => r.driverName },
      { label: 'Failed attempts', value: (r) => r.failureCount },
      { label: 'Total attempts', value: (r) => r.attemptCount },
      { label: 'Last failed at', value: (r) => r.lastFailedAt },
      { label: 'Last reason', value: (r) => r.lastFailureReason },
    ],
  },
};

export async function buildCsvReport(name, range) {
  const report = CSV_REPORTS[name];
  if (!report) return null;
  const rows = await report.rows(range);
  return {
    filename: `${report.filename}-${range.from.toISOString().slice(0, 10)}-to-${range.to.toISOString().slice(0, 10)}.csv`,
    csv: toCsv(report.headers, rows),
  };
}
