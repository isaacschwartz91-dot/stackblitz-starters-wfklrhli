/**
 * The public tracking view.
 *
 * Anyone holding the link can read this — the token travels by SMS and gets
 * forwarded, screenshotted and pasted into group chats. So the payload is built
 * by an explicit allow-list of fields rather than by stripping a few off the
 * internal order object, and it deliberately omits the street address, phone
 * number, email address and delivery notes: the recipient already knows their
 * own address, and nobody else needs it.
 */
import { notFound } from '../lib/errors.js';
import * as orders from '../repositories/orderRepository.js';
import * as proofs from '../repositories/proofRepository.js';
import { storage } from '../storage/index.js';
import { getSettings } from './settingsService.js';

/** "Dana Whitfield" -> "Dana W." */
function maskName(fullName) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts.at(-1)[0]}.`;
}

function firstName(fullName) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  return parts[0] ?? null;
}

/** Customer-facing wording for each internal status. */
const PUBLIC_STATUS = {
  created: { code: 'preparing', label: 'Preparing', description: 'We have your order and are getting it ready.' },
  ready_for_delivery: { code: 'dispatched', label: 'Dispatched', description: 'Your order has left our warehouse and is scheduled for delivery.' },
  assigned: { code: 'dispatched', label: 'Dispatched', description: 'Your order is scheduled for delivery.' },
  out_for_delivery: { code: 'out_for_delivery', label: 'Out for delivery', description: 'Your order is on the van today.' },
  delivered: { code: 'delivered', label: 'Delivered', description: 'Your order has been delivered.' },
  failed_attempt: { code: 'attempted', label: 'Delivery attempted', description: 'We tried to deliver your order but could not complete it. We will try again.' },
  cancelled: { code: 'cancelled', label: 'Cancelled', description: 'This delivery was cancelled.' },
};

/** The milestones shown as a progress bar, in order. */
const PUBLIC_TIMELINE = ['preparing', 'dispatched', 'out_for_delivery', 'delivered'];

export async function getPublicTracking(token) {
  const order = await orders.findByTrackingToken(token);
  if (!order) throw notFound('We could not find a delivery for this link');

  const settings = await getSettings();
  const status = PUBLIC_STATUS[order.status] ?? PUBLIC_STATUS.created;
  const history = await orders.listStatusEvents(order.id);

  // Collapse the internal log into customer-visible milestones. Internal hops
  // (assignment, re-queueing) are not shown; they would only confuse.
  const milestones = [];
  for (const event of history) {
    const mapped = PUBLIC_STATUS[event.toStatus];
    if (!mapped || mapped.code === 'preparing') continue;
    const previous = milestones.at(-1);
    if (previous?.code === mapped.code && mapped.code !== 'attempted') continue;
    milestones.push({ code: mapped.code, label: mapped.label, at: event.createdAt });
  }

  const proof = order.status === 'delivered' ? await proofs.findLatestForOrder(order.id) : null;

  return {
    orderRef: order.orderRef,
    customerName: maskName(order.customerName),
    status: { ...status, raw: order.status },
    timeline: PUBLIC_TIMELINE,
    milestones,
    // Town-level by default — enough to confirm the delivery is going to the
    // right place. An admin can opt into the street address and phone number
    // (Settings → Public tracking page); those keys are absent, not null, when
    // the setting is off, so nothing has to be filtered downstream.
    destination: {
      city: order.city,
      region: order.region,
      postalCode: order.postalCode,
      country: order.country,
      ...(settings['publicTracking.showStreetAddress']
        ? { addressLine1: order.addressLine1, addressLine2: order.addressLine2 }
        : {}),
    },
    ...(settings['publicTracking.showCustomerPhone']
      ? { customerPhone: order.customerPhone }
      : {}),
    ...(settings['publicTracking.showDeliveryNotes'] && order.deliveryNotes
      ? { deliveryNotes: order.deliveryNotes }
      : {}),
    driverFirstName: order.status === 'out_for_delivery' ? firstName(order.assignedDriverName) : null,
    attemptCount: order.attemptCount,
    dispatchedAt: order.readyAt,
    outForDeliveryAt: order.pickedUpAt,
    deliveredAt: order.deliveredAt,
    proofOfDelivery: proof
      ? {
          recipientName: proof.recipientName,
          capturedAt: proof.capturedAt,
          photoUrl: proof.photoKey ? await storage().signedUrl(proof.photoKey) : null,
          signatureUrl: proof.signatureKey ? await storage().signedUrl(proof.signatureKey) : null,
        }
      : null,
  };
}
