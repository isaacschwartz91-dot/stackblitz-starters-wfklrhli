/**
 * Proof of delivery.
 *
 * Completing a drop-off and capturing evidence are separate steps on purpose: a
 * driver standing in the rain should be able to close the job instantly and let
 * a 3MB photo upload finish (or retry) afterwards. So:
 *
 *   POST /api/scans           dropoff scan -> status change, empty proof row
 *   POST /api/orders/:id/proof attaches photo/signature to the open attempt,
 *                              and will do the status change too if the driver
 *                              submits everything at once.
 */
import { withTransaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { assertTransitionAllowed } from '../lib/statusMachine.js';
import * as orders from '../repositories/orderRepository.js';
import * as proofs from '../repositories/proofRepository.js';
import { assertIsImage, decodeDataUrl, proofKey, storage } from '../storage/index.js';
import { notifyStatusChange } from './notificationService.js';
import { decorateOrder } from './orderService.js';

/** A driver may only touch their own parcels; staff may correct any of them. */
function assertCanCapture(order, actor) {
  if (actor.role === 'admin' || actor.role === 'dispatcher') return;
  if (actor.role !== 'driver' || order.assignedDriverId !== actor.id) {
    throw forbidden('This parcel is not assigned to you');
  }
}

async function uploadImage({ buffer, orderId, attemptNumber, kind }) {
  const detected = assertIsImage(buffer, kind === 'photo' ? 'Photo' : 'Signature');
  const key = proofKey({ orderId, attemptNumber, kind, ext: detected.ext });
  await storage().put({ key, body: buffer, contentType: detected.type });
  return key;
}

/**
 * Creates the proof row that belongs to a drop-off scan. Called from within the
 * scan transaction so a delivery and its proof record are never out of step.
 */
export async function recordProofForScan(client, {
  order,
  outcome,
  scanEventId,
  recipientName,
  failureReason,
  notes,
  capturedById,
  attemptNumber,
}) {
  return proofs.insert(client, {
    orderId: order.id,
    attemptNumber,
    outcome,
    scanEventId,
    recipientName,
    failureReason,
    notes,
    capturedById,
  });
}

/**
 * Attaches evidence to a delivery attempt, completing the drop-off first if the
 * driver has not scanned it separately.
 */
export async function captureProof({
  orderId,
  actor,
  outcome,
  recipientName,
  failureReason,
  notes,
  photoBuffer,
  signatureBuffer,
  signatureDataUrl,
}) {
  const signature = signatureBuffer ??
    (signatureDataUrl ? decodeDataUrl(signatureDataUrl, 'Signature') : undefined);

  if (outcome === 'failed' && !failureReason) {
    throw badRequest('A failed delivery attempt needs a reason');
  }

  // Upload outside the transaction: object storage can be slow, and holding a
  // row lock across a network round trip to S3 is how you get lock timeouts.
  // The order is re-read and re-checked inside the transaction below.
  const preflight = await orders.findById(orderId);
  if (!preflight) throw notFound('Order not found');
  assertCanCapture(preflight, actor);

  const isOpenDropoff = preflight.status === 'out_for_delivery';
  const attemptNumber = isOpenDropoff ? preflight.attemptCount + 1 : preflight.attemptCount;

  if (!isOpenDropoff && !['delivered', 'failed_attempt'].includes(preflight.status)) {
    throw conflict(
      `Proof of delivery can only be captured at drop-off — this order is ${preflight.status}`,
      { currentStatus: preflight.status },
    );
  }

  const [photoKey, signatureKey] = await Promise.all([
    photoBuffer ? uploadImage({ buffer: photoBuffer, orderId, attemptNumber, kind: 'photo' }) : null,
    signature ? uploadImage({ buffer: signature, orderId, attemptNumber, kind: 'signature' }) : null,
  ]);

  const result = await withTransaction(async (client) => {
    const order = await orders.findByIdForUpdate(client, orderId);
    if (!order) throw notFound('Order not found');
    assertCanCapture(order, actor);

    // Attach to an attempt that a drop-off scan already closed.
    if (order.status === 'delivered' || order.status === 'failed_attempt') {
      const existing = await proofs.findLatestForOrder(order.id, client);
      if (!existing) {
        const created = await proofs.insert(client, {
          orderId: order.id,
          attemptNumber: order.attemptCount,
          outcome: order.status === 'delivered' ? 'delivered' : 'failed',
          recipientName,
          failureReason: order.status === 'failed_attempt' ? (failureReason ?? 'Not recorded') : null,
          notes,
          photoKey,
          signatureKey,
          capturedById: actor.id,
        });
        return { order, proof: created, statusEvent: null };
      }
      const updated = await proofs.attachMedia(client, existing.id, {
        ...(photoKey ? { photoKey } : {}),
        ...(signatureKey ? { signatureKey } : {}),
        ...(recipientName !== undefined ? { recipientName } : {}),
        ...(notes !== undefined ? { notes } : {}),
      });
      return { order, proof: updated, statusEvent: null };
    }

    // Otherwise this request also completes the drop-off.
    const toStatus = outcome === 'failed' ? 'failed_attempt' : 'delivered';
    assertTransitionAllowed(order.status, toStatus);

    const changed = await orders.applyStatusChange(client, {
      order,
      toStatus,
      actorId: actor.id,
      source: 'manual',
      notes: notes ?? failureReason ?? null,
    });

    const proof = await proofs.insert(client, {
      orderId: order.id,
      attemptNumber: changed.order.attemptCount,
      outcome: toStatus === 'delivered' ? 'delivered' : 'failed',
      recipientName,
      failureReason: toStatus === 'failed_attempt' ? failureReason : null,
      notes,
      photoKey,
      signatureKey,
      capturedById: actor.id,
    });

    return { order: changed.order, proof, statusEvent: changed.statusEvent };
  });

  // Notify after the commit, and only when this request completed the drop-off;
  // attaching a photo to an already-closed attempt is not a new event.
  if (result.statusEvent) {
    await notifyStatusChange({ order: result.order, statusEvent: result.statusEvent });
  }

  return {
    order: decorateOrder(result.order),
    proof: await withSignedUrls(result.proof),
    statusEvent: result.statusEvent,
  };
}

/** Swaps storage keys for short-lived signed URLs. Keys never leave the server. */
export async function withSignedUrls(proof) {
  if (!proof) return null;
  const { photoKey, signatureKey, ...rest } = proof;
  const [photoUrl, signatureUrl] = await Promise.all([
    photoKey ? storage().signedUrl(photoKey) : null,
    signatureKey ? storage().signedUrl(signatureKey) : null,
  ]);
  return { ...rest, hasPhoto: Boolean(photoKey), hasSignature: Boolean(signatureKey), photoUrl, signatureUrl };
}

export async function listProofForOrder(orderId) {
  const rows = await proofs.listForOrder(orderId);
  return Promise.all(rows.map(withSignedUrls));
}

export function findLatest(orderId) {
  return proofs.findLatestForOrder(orderId);
}
