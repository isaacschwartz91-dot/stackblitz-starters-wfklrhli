/**
 * Customer notifications on status change.
 *
 * Called after the status transition has committed, never inside its
 * transaction: a rolled-back delivery must not leave a sent SMS behind, and an
 * SMS provider being slow must not hold a row lock.
 *
 * Dispatch is idempotent through the (status_event_id, channel) unique index —
 * replaying a status change claims nothing and sends nothing.
 */
import { config } from '../config.js';
import { trackingUrl } from '../lib/identifiers.js';
import * as notifications from '../repositories/notificationRepository.js';
import * as proofs from '../repositories/proofRepository.js';
import { deliver } from '../notifications/providers.js';
import { isRepeatable, renderMessage, templateKeyFor } from '../notifications/templates.js';
import { storage } from '../storage/index.js';

/** Which channels this customer can actually be reached on. */
function channelsFor(order) {
  const channels = [];
  if (order.customerPhone) channels.push({ channel: 'sms', recipient: order.customerPhone });
  if (order.customerEmail) channels.push({ channel: 'email', recipient: order.customerEmail });
  return channels;
}

async function buildContext({ order, statusEvent }) {
  const context = {
    order,
    trackingUrl: trackingUrl(config.publicBaseUrl, order.trackingToken),
    driverName: order.assignedDriverName,
    failureReason: statusEvent?.notes ?? null,
    proofUrl: null,
    recipientName: null,
  };

  // A delivery notification is much more useful with the photo attached.
  if (statusEvent?.toStatus === 'delivered') {
    const proof = await proofs.findLatestForOrder(order.id);
    if (proof) {
      context.recipientName = proof.recipientName;
      if (proof.photoKey) {
        context.proofUrl = await storage().signedUrl(proof.photoKey);
      }
    }
  }

  return context;
}

/**
 * Sends the messages for one status change.
 *
 * Never throws: a notification failure must not roll back or fail the delivery
 * update that triggered it. Failures are recorded on the notification row.
 *
 * @returns {Promise<Array>} the notification rows that were claimed
 */
export async function notifyStatusChange({ order, statusEvent }) {
  if (!statusEvent) return [];

  const status = statusEvent.toStatus;
  if (!config.notifications.notifyOnStatuses.includes(status)) return [];

  const templateKey = templateKeyFor(status);
  if (!templateKey) return [];

  let context;
  try {
    context = await buildContext({ order, statusEvent });
  } catch (err) {
    console.error('[notify] could not build message context:', err.message);
    return [];
  }

  const results = [];

  for (const { channel, recipient } of channelsFor(order)) {
    const message = renderMessage({ templateKey, channel, context });
    if (!message) continue;

    // "Dispatched" and "delivered" are once-per-order facts. Only the
    // repeatable templates may be sent again on a second delivery attempt.
    if (!isRepeatable(templateKey)) {
      const alreadySent = await notifications
        .existsForTemplate({ orderId: order.id, templateKey, channel })
        .catch(() => false);
      if (alreadySent) continue;
    }

    let claimed;
    try {
      claimed = await notifications.claim({
        orderId: order.id,
        channel,
        recipient,
        templateKey,
        statusEventId: statusEvent.id,
        payload: { subject: message.subject ?? null, body: message.body },
      });
    } catch (err) {
      console.error(`[notify] could not queue ${channel} for order ${order.orderRef}:`, err.message);
      continue;
    }

    // Already claimed by an earlier run — this status change was replayed.
    if (!claimed) continue;

    try {
      const outcome = await deliver({
        channel,
        to: recipient,
        subject: message.subject,
        body: message.body,
      });

      results.push(
        outcome.status === 'skipped'
          ? await notifications.markSkipped(claimed.id, outcome.reason)
          : await notifications.markSent(claimed.id, outcome),
      );
    } catch (err) {
      console.error(`[notify] ${channel} to ${recipient} failed:`, err.message);
      results.push(await notifications.markFailed(claimed.id, err.message));
    }
  }

  return results;
}

/**
 * Retries messages that failed with a transient provider error.
 * Intended for a cron job; also exposed to admins as a manual button.
 */
export async function retryFailed({ limit = 50 } = {}) {
  const pending = await notifications.listRetryable({ limit });
  const results = [];

  for (const notification of pending) {
    try {
      const outcome = await deliver({
        channel: notification.channel,
        to: notification.recipient,
        subject: notification.payload?.subject ?? undefined,
        body: notification.payload?.body ?? '',
      });
      results.push(
        outcome.status === 'skipped'
          ? await notifications.markSkipped(notification.id, outcome.reason)
          : await notifications.markSent(notification.id, outcome),
      );
    } catch (err) {
      results.push(await notifications.markFailed(notification.id, err.message));
    }
  }

  return results;
}

export const listForOrder = notifications.listForOrder;
export const listRecent = notifications.listRecent;
