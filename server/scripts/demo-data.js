/**
 * Generates a realistic demo dataset: several weeks of deliveries across zones
 * and drivers, including failed attempts and redeliveries, with the delivery
 * clock backdated so the reports have something to measure.
 *
 *   npm run demo
 *
 * Destructive: clears existing orders first. Development use only.
 */
import { closePool, pool, query } from '../src/db/pool.js';
import * as assignmentService from '../src/services/assignmentService.js';
import * as orderService from '../src/services/orderService.js';
import * as scanService from '../src/services/scanService.js';
import * as users from '../src/repositories/userRepository.js';

const ZONES = ['NORTH', 'SOUTH', 'EAST', 'WEST'];

const NAMES = [
  'Dana Whitfield', 'Marcus Bell', 'Yuki Tanaka', 'Fatima Nasser', 'Theo Marchetti',
  'Nia Boateng', 'Oskar Lindgren', 'Claudia Moreno', 'Ravi Chandra', 'Elena Popescu',
  'Jonah Adeyemi', 'Mei Lin', 'Tomas Novak', 'Aisha Rahman', 'Felix Braun',
  'Sofia Rossi', 'Kwame Mensah', 'Ingrid Dahl', 'Hassan Karim', 'Lucia Ferrari',
];

const STREETS = [
  'Alder Street', 'Kestrel Lane', 'Copper Row', 'Juniper Court', 'Foundry Avenue',
  'Larkspur Way', 'Harbour Terrace', 'Vestry Street', 'Marlow Crescent', 'Bramble Walk',
];

const FAILURE_REASONS = [
  'Nobody home', 'Access refused', 'Address not found', 'No safe place to leave it',
];

// Deterministic pseudo-randomness: reruns produce the same shaped dataset.
let seed = 20260812;
function random() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (min, max) => min + Math.floor(random() * (max - min + 1));

async function clearOrders() {
  await query('TRUNCATE orders, order_status_events, scan_events, proof_of_delivery, notifications, order_assignment_events, order_import_batches CASCADE');
}

/** Rewrites an order's whole clock so a delivery appears to have happened days ago. */
async function backdate(orderId, { daysAgo, readyHour, minutesToDeliver }) {
  await pool.query(
    `WITH stamps AS (
       SELECT (date_trunc('day', now()) - ($2 || ' days')::interval + ($3 || ' hours')::interval) AS ready
     )
     UPDATE orders o
        SET created_at   = (SELECT ready FROM stamps) - interval '3 hours',
            ready_at     = (SELECT ready FROM stamps),
            assigned_at  = (SELECT ready FROM stamps) + interval '20 minutes',
            picked_up_at = CASE WHEN o.picked_up_at IS NULL THEN NULL
                           ELSE (SELECT ready FROM stamps) + interval '45 minutes' END,
            delivered_at = CASE WHEN o.delivered_at IS NULL THEN NULL
                           ELSE (SELECT ready FROM stamps) + ($4 || ' minutes')::interval END
      WHERE o.id = $1`,
    [orderId, String(daysAgo), String(readyHour), String(minutesToDeliver)],
  );

  // Move the status log with it, or the reports and the timeline disagree.
  await pool.query(
    `UPDATE order_status_events e
        SET created_at = o.ready_at + (
              CASE e.to_status
                WHEN 'created' THEN interval '-3 hours'
                WHEN 'ready_for_delivery' THEN interval '0'
                WHEN 'assigned' THEN interval '20 minutes'
                WHEN 'out_for_delivery' THEN interval '45 minutes'
                ELSE ($2 || ' minutes')::interval
              END)
       FROM orders o
      WHERE o.id = e.order_id AND o.id = $1`,
    [orderId, String(minutesToDeliver)],
  );
}

async function main() {
  const [admin] = await users.list({ role: 'admin' });
  const drivers = await users.list({ role: 'driver' });

  if (!admin || drivers.length === 0) {
    console.error('Run `npm run seed` first — demo data needs an admin and some drivers.');
    process.exitCode = 1;
    return;
  }

  console.log('Clearing existing orders...');
  await clearOrders();

  const actor = { id: admin.id, role: 'admin' };
  let reference = 2000;
  let created = 0;
  let delivered = 0;
  let failed = 0;

  // Three weeks of history.
  for (let daysAgo = 20; daysAgo >= 0; daysAgo -= 1) {
    const isWeekend = [0, 6].includes(
      new Date(Date.now() - daysAgo * 86_400_000).getDay(),
    );
    const volume = isWeekend ? between(2, 5) : between(6, 12);

    for (let i = 0; i < volume; i += 1) {
      reference += 1;
      const zone = pick(ZONES);
      const driver = pick(drivers);
      const driverActor = { id: driver.id, role: 'driver' };

      const order = await orderService.createOrder({
        actorId: admin.id,
        data: {
          orderRef: `ORD-${reference}`,
          customerName: pick(NAMES),
          customerPhone: `+1555${String(between(1000000, 9999999))}`,
          customerEmail: random() > 0.4 ? `customer${reference}@example.com` : undefined,
          addressLine1: `${between(1, 400)} ${pick(STREETS)}`,
          city: 'Springfield',
          region: 'IL',
          postalCode: `627${String(between(10, 99))}`,
          country: 'US',
          deliveryZone: zone,
          deliveryNotes: random() > 0.8 ? 'Leave with the doorman' : undefined,
        },
      });
      created += 1;

      // Today's orders are left spread across the pipeline so the dispatch and
      // driver screens have live work on them.
      if (daysAgo === 0) {
        const stage = random();
        if (stage < 0.25) continue; // never scanned
        await scanService.recordScan({
          scannedValue: order.barcodeValue, scanType: 'label_activation', actor,
        });
        if (stage < 0.55) continue; // waiting for a dispatcher

        await assignmentService.assignOrder({
          orderId: order.id, driverId: driver.id, actorId: admin.id,
        });
        if (stage < 0.8) continue; // assigned, not collected

        await scanService.recordScan({
          scannedValue: order.barcodeValue, scanType: 'pickup', actor: driverActor,
        });
        continue; // out for delivery
      }

      // Historic orders run to completion.
      await scanService.recordScan({
        scannedValue: order.barcodeValue, scanType: 'label_activation', actor,
      });
      await assignmentService.assignOrder({
        orderId: order.id, driverId: driver.id, actorId: admin.id,
      });
      await scanService.recordScan({
        scannedValue: order.barcodeValue, scanType: 'pickup', actor: driverActor,
      });

      const failsFirstTime = random() < 0.12;

      if (failsFirstTime) {
        await scanService.recordScan({
          scannedValue: order.barcodeValue,
          scanType: 'dropoff',
          outcome: 'failed',
          failureReason: pick(FAILURE_REASONS),
          actor: driverActor,
        });
        failed += 1;

        // Two thirds of failures are recovered on a second attempt.
        if (random() < 0.66) {
          await assignmentService.assignOrder({
            orderId: order.id, driverId: driver.id, actorId: admin.id,
          });
          await scanService.recordScan({
            scannedValue: order.barcodeValue, scanType: 'pickup', actor: driverActor,
          });
          await scanService.recordScan({
            scannedValue: order.barcodeValue, scanType: 'dropoff', outcome: 'delivered', actor: driverActor,
          });
          delivered += 1;
        }
      } else {
        await scanService.recordScan({
          scannedValue: order.barcodeValue, scanType: 'dropoff', outcome: 'delivered', actor: driverActor,
        });
        delivered += 1;
      }

      await backdate(order.id, {
        daysAgo,
        readyHour: between(7, 10),
        // Most deliveries land within the day; a few drag on.
        minutesToDeliver: random() < 0.9 ? between(90, 420) : between(600, 1800),
      });
    }
  }

  console.log(`\nCreated ${created} orders: ${delivered} delivered, ${failed} failed attempts.`);
  console.log('Sign in at http://localhost:5173 with admin@example.com / admin12345');
}

try {
  await main();
} catch (err) {
  console.error('Demo data failed:', err);
  process.exitCode = 1;
} finally {
  await closePool();
}
