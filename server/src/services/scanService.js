/**
 * Scan ingestion — the path every physical scan takes.
 *
 * Two rules shape this file:
 *   1. Every scan is recorded, including rejected ones. A driver scanning the
 *      wrong parcel is exactly the event an operations lead needs to see, so a
 *      rejection is written on its own connection before the error is thrown
 *      (the caller's transaction is rolled back by then).
 *   2. The status machine is the only authority on what a scan may do. This
 *      service maps scan type -> intended transition and then asks.
 */
import { config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { normaliseBarcodeValue } from '../lib/identifiers.js';
import { assertTransitionAllowed, SCAN_TRANSITIONS } from '../lib/statusMachine.js';
import * as orders from '../repositories/orderRepository.js';
import * as proofs from '../repositories/proofRepository.js';
import * as scans from '../repositories/scanRepository.js';
import { decorateOrder } from './orderService.js';

/** Internal signal: the scan is refused, and why. Converted to an ApiError. */
class ScanRejection extends Error {
  constructor({ status, code, reason, message, orderId = null, details }) {
    super(message);
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.orderId = orderId;
    this.details = details;
  }
}

const SCAN_TYPE_LABELS = {
  label_activation: 'label activation',
  pickup: 'pickup',
  dropoff: 'drop-off',
};

/** Who may perform each scan type. Admins are an override for support cases. */
function assertScannerRole({ scanType, actor, order }) {
  if (actor.role === 'admin') return;

  if (scanType === 'label_activation') {
    if (actor.role !== 'dispatcher') {
      throw new ScanRejection({
        status: 403,
        code: 'forbidden',
        reason: 'role_not_permitted',
        orderId: order.id,
        message: 'Only warehouse staff can activate a label',
      });
    }
    return;
  }

  // pickup / dropoff
  if (actor.role !== 'driver') {
    throw new ScanRejection({
      status: 403,
      code: 'forbidden',
      reason: 'role_not_permitted',
      orderId: order.id,
      message: `Only the assigned driver can record a ${SCAN_TYPE_LABELS[scanType]} scan`,
    });
  }

  if (order.assignedDriverId && order.assignedDriverId !== actor.id) {
    throw new ScanRejection({
      status: 403,
      code: 'assigned_to_another_driver',
      reason: 'assigned_to_another_driver',
      orderId: order.id,
      message: `This parcel is assigned to ${order.assignedDriverName ?? 'another driver'}`,
      details: { assignedDriverName: order.assignedDriverName },
    });
  }
}

/** Maps a scan onto the status it is trying to produce. */
function targetStatusFor({ scanType, outcome }) {
  if (scanType === 'dropoff') return outcome === 'failed' ? 'failed_attempt' : 'delivered';
  return SCAN_TRANSITIONS[scanType].to;
}

export async function recordScan({
  scannedValue,
  scanType,
  actor,
  outcome,
  failureReason,
  recipientName,
  notes,
  deviceLabel,
  latitude,
  longitude,
}) {
  const normalised = normaliseBarcodeValue(scannedValue);

  if (scanType === 'dropoff' && outcome === 'failed' && !failureReason) {
    throw badRequest('A failed delivery attempt needs a reason');
  }

  try {
    return await withTransaction(async (client) => {
      const order = await orders.findByBarcodeForUpdate(client, normalised);

      if (!order) {
        throw new ScanRejection({
          status: 404,
          code: 'unknown_barcode',
          reason: 'unknown_barcode',
          message: `No order matches the code "${normalised}"`,
          details: { scannedValue: normalised },
        });
      }

      assertScannerRole({ scanType, actor, order });

      // A driver may pick up unassigned work directly off the shelf when the
      // deployment allows it; otherwise a dispatcher must assign it first.
      let assignment;
      if (
        scanType === 'pickup' &&
        !order.assignedDriverId &&
        order.status === 'ready_for_delivery'
      ) {
        if (!config.allowDriverSelfAssign) {
          throw new ScanRejection({
            status: 409,
            code: 'not_assigned',
            reason: 'not_assigned',
            orderId: order.id,
            message: 'This parcel has not been assigned to a driver yet',
          });
        }
        assignment = { driverId: actor.id, assignedById: actor.id };
        // Self-assignment moves it through 'assigned' implicitly; record that
        // hop so the history does not jump from ready straight to out.
        await orders.applyStatusChange(client, {
          order,
          toStatus: 'assigned',
          actorId: actor.id,
          source: 'scan',
          notes: 'Self-assigned at pickup',
          assignment,
        });
        await client.query(
          `INSERT INTO order_assignment_events
             (order_id, from_driver_id, to_driver_id, assigned_by_id, method, notes)
           VALUES ($1, NULL, $2, $2, 'self_assign', 'Taken at pickup scan')`,
          [order.id, actor.id],
        );
        order.status = 'assigned';
        order.assignedDriverId = actor.id;
      }

      const toStatus = targetStatusFor({ scanType, outcome });

      try {
        assertTransitionAllowed(order.status, toStatus);
      } catch (err) {
        throw new ScanRejection({
          status: err.status ?? 409,
          code: err.code ?? 'conflict',
          reason: `invalid_transition:${order.status}->${toStatus}`,
          orderId: order.id,
          message: err.message,
          details: { ...(err.details ?? {}), currentStatus: order.status, orderRef: order.orderRef },
        });
      }

      const scanEvent = await scans.insert(client, {
        orderId: order.id,
        scannedValue: normalised,
        scanType,
        scannedById: actor.id,
        accepted: true,
        deviceLabel,
        latitude,
        longitude,
      });

      const result = await orders.applyStatusChange(client, {
        order,
        toStatus,
        actorId: actor.id,
        source: 'scan',
        scanEventId: scanEvent.id,
        notes: notes ?? (outcome === 'failed' ? failureReason : null),
        latitude,
        longitude,
      });

      // A drop-off opens the proof-of-delivery record for this attempt. Images
      // are attached afterwards via POST /api/orders/:id/proof, so a slow upload
      // never blocks the driver from closing the job.
      const proof = scanType === 'dropoff'
        ? await proofs.insert(client, {
            orderId: order.id,
            attemptNumber: result.order.attemptCount,
            outcome: toStatus === 'delivered' ? 'delivered' : 'failed',
            scanEventId: scanEvent.id,
            recipientName: recipientName ?? null,
            failureReason: toStatus === 'failed_attempt' ? failureReason : null,
            notes: notes ?? null,
            capturedById: actor.id,
          })
        : null;

      return {
        order: decorateOrder(result.order),
        statusEvent: result.statusEvent,
        scanEvent,
        proof,
      };
    });
  } catch (err) {
    if (err instanceof ScanRejection) {
      await logRejectedScan({
        orderId: err.orderId,
        scannedValue: normalised,
        scanType,
        actor,
        reason: err.reason,
        deviceLabel,
        latitude,
        longitude,
      });
      throw new ApiError(err.status, err.code, err.message, err.details);
    }
    throw err;
  }
}

/**
 * Written outside the request's transaction — that transaction is rolled back
 * the moment the rejection is thrown, which would take the audit row with it.
 */
async function logRejectedScan(details) {
  try {
    await scans.insert(null, {
      orderId: details.orderId,
      scannedValue: details.scannedValue,
      scanType: details.scanType,
      scannedById: details.actor.id,
      accepted: false,
      rejectionReason: details.reason,
      deviceLabel: details.deviceLabel,
      latitude: details.latitude,
      longitude: details.longitude,
    });
  } catch (err) {
    // Never let audit logging mask the real error the user needs to see.
    console.error('[scan] failed to record rejected scan:', err.message);
  }
}

/**
 * Read-only "what is this parcel?" used by the scanner UI to show the order and
 * the action it is about to take before the driver commits to it.
 */
export async function lookupByBarcode({ scannedValue, actor }) {
  const normalised = normaliseBarcodeValue(scannedValue);
  const order = await orders.findByBarcode(normalised);

  if (!order) {
    throw notFound(`No order matches the code "${normalised}"`);
  }
  if (actor.role === 'driver' && order.assignedDriverId && order.assignedDriverId !== actor.id) {
    throw forbidden(`This parcel is assigned to ${order.assignedDriverName ?? 'another driver'}`);
  }

  return {
    order: decorateOrder(order),
    suggestedScan: suggestNextScan(order, actor),
    history: await orders.listStatusEvents(order.id),
  };
}

/** The scan the holder of this parcel would most likely make next. */
export function suggestNextScan(order, actor) {
  const isDriver = actor?.role === 'driver';

  switch (order.status) {
    case 'created':
      return isDriver ? null : { scanType: 'label_activation', label: 'Mark ready for delivery' };
    case 'ready_for_delivery':
      return isDriver && config.allowDriverSelfAssign
        ? { scanType: 'pickup', label: 'Take and start delivery' }
        : null;
    case 'assigned':
      return { scanType: 'pickup', label: 'Start delivery' };
    case 'out_for_delivery':
      return { scanType: 'dropoff', label: 'Complete delivery' };
    case 'failed_attempt':
      return null;
    default:
      return null;
  }
}

export function listOrderScans(orderId) {
  return scans.listForOrder(orderId);
}

export function listRecentScans(options) {
  return scans.listRecent(options);
}

export async function assertOrderExists(orderId) {
  const order = await orders.findById(orderId);
  if (!order) throw notFound('Order not found');
  return order;
}
