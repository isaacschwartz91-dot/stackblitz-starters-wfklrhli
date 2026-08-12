/**
 * Development seed data: one user per role plus a spread of orders.
 * Idempotent — re-running skips records that already exist.
 *
 * The passwords here are deliberately obvious placeholders for local use.
 */
import { closePool, withTransaction, query } from '../src/db/pool.js';
import * as users from '../src/repositories/userRepository.js';
import * as orderService from '../src/services/orderService.js';

const SEED_USERS = [
  { email: 'admin@example.com', fullName: 'Avery Lindqvist', role: 'admin', password: 'admin12345', phone: '+15550100001' },
  { email: 'dispatch@example.com', fullName: 'Rosa Ferreira', role: 'dispatcher', password: 'dispatch12345', phone: '+15550100002' },
  { email: 'driver1@example.com', fullName: 'Sam Okafor', role: 'driver', password: 'driver12345', phone: '+15550100003' },
  { email: 'driver2@example.com', fullName: 'Priya Raman', role: 'driver', password: 'driver12345', phone: '+15550100004' },
];

const SEED_ORDERS = [
  { orderRef: 'ORD-1001', customerName: 'Dana Whitfield', customerPhone: '+15551234567', customerEmail: 'dana@example.com', addressLine1: '84 Alder Street', addressLine2: 'Apt 3B', city: 'Springfield', region: 'IL', postalCode: '62704', country: 'US', deliveryZone: 'NORTH', deliveryNotes: 'Leave with the doorman' },
  { orderRef: 'ORD-1002', customerName: 'Marcus Bell', customerPhone: '+15551234568', addressLine1: '19 Kestrel Lane', city: 'Springfield', region: 'IL', postalCode: '62703', country: 'US', deliveryZone: 'NORTH' },
  { orderRef: 'ORD-1003', customerName: 'Yuki Tanaka', customerEmail: 'yuki@example.com', addressLine1: '450 Copper Row', city: 'Springfield', region: 'IL', postalCode: '62711', country: 'US', deliveryZone: 'SOUTH' },
  { orderRef: 'ORD-1004', customerName: 'Fatima Nasser', customerPhone: '+15551234570', addressLine1: '7 Juniper Court', city: 'Springfield', region: 'IL', postalCode: '62712', country: 'US', deliveryZone: 'SOUTH', deliveryNotes: 'Ring the side bell' },
  { orderRef: 'ORD-1005', customerName: 'Theo Marchetti', customerPhone: '+15551234571', customerEmail: 'theo@example.com', addressLine1: '231 Foundry Avenue', city: 'Springfield', region: 'IL', postalCode: '62702', country: 'US', deliveryZone: 'EAST' },
  { orderRef: 'ORD-1006', customerName: 'Nia Boateng', customerPhone: '+15551234572', addressLine1: '96 Larkspur Way', city: 'Springfield', region: 'IL', postalCode: '62707', country: 'US', deliveryZone: 'EAST' },
  { orderRef: 'ORD-1007', customerName: 'Oskar Lindgren', customerPhone: '+15551234573', addressLine1: '12 Harbour Terrace', city: 'Springfield', region: 'IL', postalCode: '62705', country: 'US', deliveryZone: 'WEST' },
  { orderRef: 'ORD-1008', customerName: 'Claudia Moreno', customerEmail: 'claudia@example.com', addressLine1: '308 Vestry Street', city: 'Springfield', region: 'IL', postalCode: '62706', country: 'US', deliveryZone: 'WEST' },
];

async function seedUsers() {
  const created = [];
  for (const user of SEED_USERS) {
    const existing = await users.findByEmailWithHash(user.email);
    if (existing) {
      created.push(existing);
      continue;
    }
    created.push(await users.create(user));
    console.log(`  user  ${user.email.padEnd(24)} (${user.role})`);
  }
  return created;
}

async function seedOrders(adminId) {
  const created = [];
  for (const data of SEED_ORDERS) {
    const { rows } = await query('SELECT id FROM orders WHERE order_ref = $1', [data.orderRef]);
    if (rows.length > 0) continue;
    const order = await orderService.createOrder({ data, actorId: adminId });
    created.push(order);
    console.log(`  order ${order.orderRef.padEnd(12)} ${order.barcodeValue}`);
  }
  return created;
}

/**
 * Walks a few orders down the lifecycle so the dashboard and reports have
 * something to show before anyone scans anything.
 */
async function advanceSampleOrders(adminId, driverId) {
  const { rows } = await query(
    `SELECT id, status FROM orders WHERE status = 'created' ORDER BY order_ref LIMIT 5`,
  );
  if (rows.length === 0) return;

  const [first, second, third, fourth] = rows;
  const ready = rows.slice(0, 4);

  for (const row of ready) {
    await orderService.changeOrderStatus({
      orderId: row.id,
      toStatus: 'ready_for_delivery',
      actorId: adminId,
      notes: 'Seeded: label activated',
    });
  }

  // Assign three of them, then push two further along.
  await withTransaction(async (client) => {
    for (const row of [first, second, third]) {
      await client.query(
        `UPDATE orders SET assigned_driver_id = $2, assigned_by_id = $3, assigned_at = now(),
                           status = 'assigned'
           WHERE id = $1`,
        [row.id, driverId, adminId],
      );
      await client.query(
        `INSERT INTO order_status_events (order_id, from_status, to_status, actor_id, source, notes)
         VALUES ($1, 'ready_for_delivery', 'assigned', $2, 'manual', 'Seeded: assigned to driver')`,
        [row.id, adminId],
      );
    }
  });

  await orderService.changeOrderStatus({
    orderId: first.id, toStatus: 'out_for_delivery', actorId: driverId, notes: 'Seeded: picked up',
  });
  await orderService.changeOrderStatus({
    orderId: first.id, toStatus: 'delivered', actorId: driverId, notes: 'Seeded: delivered',
  });
  await orderService.changeOrderStatus({
    orderId: second.id, toStatus: 'out_for_delivery', actorId: driverId, notes: 'Seeded: picked up',
  });

  console.log(`  advanced ${ready.length} orders through the lifecycle (${fourth ? 'incl. queue' : ''})`);
}

async function main() {
  console.log('Seeding development data...');
  const seeded = await seedUsers();
  const admin = seeded.find((u) => u.role === 'admin');
  const driver = seeded.find((u) => u.role === 'driver');

  await seedOrders(admin.id);
  await advanceSampleOrders(admin.id, driver.id);

  console.log('\nDone. Sign in with:');
  for (const user of SEED_USERS) {
    console.log(`  ${user.role.padEnd(11)} ${user.email.padEnd(24)} ${user.password}`);
  }
}

try {
  await main();
} catch (err) {
  console.error('Seed failed:', err);
  process.exitCode = 1;
} finally {
  await closePool();
}
