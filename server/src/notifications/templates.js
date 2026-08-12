/**
 * Customer-facing message copy, one template per status change.
 *
 * Kept deliberately plain: these arrive as SMS on a phone, where a 160-character
 * segment costs money and marketing language reads as spam.
 */

const shortRef = (order) => order.orderRef;

export const TEMPLATE_KEYS = {
  ready_for_delivery: 'order_dispatched',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  failed_attempt: 'failed_attempt',
};

function firstName(fullName) {
  return String(fullName ?? '').trim().split(/\s+/)[0] || 'your driver';
}

const TEMPLATES = {
  order_dispatched: {
    sms: ({ order, trackingUrl }) =>
      `Your order ${shortRef(order)} has been dispatched and is scheduled for delivery. Track it: ${trackingUrl}`,
    email: ({ order, trackingUrl }) => ({
      subject: `Order ${shortRef(order)} is on its way`,
      text: `Hi ${order.customerName},\n\nYour order ${shortRef(order)} has been dispatched and is scheduled for delivery.\n\nTrack your delivery: ${trackingUrl}\n`,
    }),
  },

  out_for_delivery: {
    sms: ({ order, trackingUrl, driverName }) =>
      `Your order ${shortRef(order)} is out for delivery today with ${firstName(driverName)}. Track it: ${trackingUrl}`,
    email: ({ order, trackingUrl, driverName }) => ({
      subject: `Order ${shortRef(order)} is out for delivery`,
      text: `Hi ${order.customerName},\n\nYour order ${shortRef(order)} is out for delivery today with ${firstName(driverName)}.\n\nTrack your delivery: ${trackingUrl}\n`,
    }),
  },

  delivered: {
    sms: ({ order, trackingUrl, proofUrl }) =>
      proofUrl
        ? `Your order ${shortRef(order)} has been delivered. Photo proof: ${proofUrl}`
        : `Your order ${shortRef(order)} has been delivered. Details: ${trackingUrl}`,
    email: ({ order, trackingUrl, proofUrl, recipientName }) => ({
      subject: `Order ${shortRef(order)} has been delivered`,
      text: [
        `Hi ${order.customerName},`,
        '',
        `Your order ${shortRef(order)} has been delivered.`,
        recipientName ? `Received by: ${recipientName}` : null,
        proofUrl ? `Photo proof of delivery: ${proofUrl}` : null,
        '',
        `Delivery details: ${trackingUrl}`,
      ].filter((line) => line !== null).join('\n'),
    }),
  },

  failed_attempt: {
    sms: ({ order, trackingUrl, failureReason }) =>
      `We could not deliver order ${shortRef(order)}${failureReason ? ` (${failureReason})` : ''}. We will try again. Details: ${trackingUrl}`,
    email: ({ order, trackingUrl, failureReason }) => ({
      subject: `We missed you — order ${shortRef(order)}`,
      text: [
        `Hi ${order.customerName},`,
        '',
        `We tried to deliver your order ${shortRef(order)} today but were not able to complete it${failureReason ? `: ${failureReason}` : '.'}`,
        '',
        'We will attempt delivery again.',
        '',
        `Delivery details: ${trackingUrl}`,
      ].join('\n'),
    }),
  },
};

export function templateKeyFor(status) {
  return TEMPLATE_KEYS[status] ?? null;
}

/**
 * Templates that may legitimately be sent to the same customer more than once.
 *
 * A redelivery genuinely is out for delivery a second time, and a second missed
 * attempt is news. "Dispatched" and "delivered" are not: un-assigning and
 * re-assigning a parcel must not tell the customer it shipped twice.
 */
const REPEATABLE = new Set(['out_for_delivery', 'failed_attempt']);

export function isRepeatable(templateKey) {
  return REPEATABLE.has(templateKey);
}

/**
 * @returns {{subject?: string, body: string}|null}
 */
export function renderMessage({ templateKey, channel, context }) {
  const template = TEMPLATES[templateKey]?.[channel];
  if (!template) return null;

  const rendered = template(context);
  return channel === 'sms'
    ? { body: rendered }
    : { subject: rendered.subject, body: rendered.text };
}

export function availableTemplateKeys() {
  return Object.keys(TEMPLATES);
}
