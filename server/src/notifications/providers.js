/**
 * SMS and email delivery.
 *
 * Both providers are called over plain fetch rather than through their SDKs:
 * two endpoints, two auth headers, no dependency tree, and the request shape
 * stays visible for anyone debugging a failed send.
 *
 * NOTIFICATIONS_DRIVER selects behaviour:
 *   log      — print the message and mark it sent (default; no accounts needed)
 *   live     — really send via Twilio / SendGrid
 *   disabled — record the message as skipped
 */
import { config } from '../config.js';

/** Twilio credentials look like ACxxxx…; the placeholder in .env.example does not count. */
export function twilioConfigured() {
  const { accountSid, authToken, fromNumber } = config.notifications.twilio;
  return Boolean(
    accountSid?.startsWith('AC') &&
    accountSid.length > 10 &&
    authToken &&
    !authToken.startsWith('PLACEHOLDER') &&
    fromNumber,
  );
}

export function sendgridConfigured() {
  const { apiKey, fromEmail } = config.notifications.sendgrid;
  return Boolean(
    apiKey?.startsWith('SG.') &&
    !apiKey.includes('PLACEHOLDER') &&
    fromEmail,
  );
}

class ProviderError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.body = body;
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

async function postWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sendViaTwilio({ to, body }) {
  const { accountSid, authToken, fromNumber } = config.notifications.twilio;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const response = await postWithTimeout(url, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: fromNumber, Body: body }).toString(),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ProviderError(payload.message ?? `Twilio responded ${response.status}`, {
      status: response.status,
      body: payload,
    });
  }
  return { provider: 'twilio', providerRef: payload.sid ?? null };
}

async function sendViaSendgrid({ to, subject, body }) {
  const { apiKey, fromEmail, fromName } = config.notifications.sendgrid;

  const response = await postWithTimeout('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromEmail, name: fromName },
      subject,
      content: [{ type: 'text/plain', value: body }],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ProviderError(`SendGrid responded ${response.status}`, {
      status: response.status,
      body: text.slice(0, 500),
    });
  }

  // SendGrid returns 202 with an empty body; the id is in a header.
  return { provider: 'sendgrid', providerRef: response.headers.get('x-message-id') };
}

/**
 * Sends one message.
 * @returns {Promise<{status: 'sent'|'skipped', provider: string|null, providerRef: string|null, reason?: string}>}
 */
export async function deliver({ channel, to, subject, body }) {
  const driver = config.notifications.driver;

  if (driver === 'disabled') {
    return { status: 'skipped', provider: null, providerRef: null, reason: 'notifications disabled' };
  }

  if (driver === 'log') {
    console.log(
      `[notify:${channel}] to=${to}${subject ? ` subject="${subject}"` : ''}\n           ${body}`,
    );
    return { status: 'sent', provider: 'log', providerRef: null };
  }

  if (driver !== 'live') {
    throw new Error(`Unknown NOTIFICATIONS_DRIVER "${driver}". Expected log, live or disabled.`);
  }

  if (channel === 'sms') {
    if (!twilioConfigured()) {
      return {
        status: 'skipped',
        provider: null,
        providerRef: null,
        reason: 'Twilio credentials are not configured',
      };
    }
    return { ...(await sendViaTwilio({ to, body })), status: 'sent' };
  }

  if (!sendgridConfigured()) {
    return {
      status: 'skipped',
      provider: null,
      providerRef: null,
      reason: 'SendGrid credentials are not configured',
    };
  }
  return { ...(await sendViaSendgrid({ to, subject, body })), status: 'sent' };
}

/** Surfaced on the admin settings screen so missing keys are visible. */
export function providerStatus() {
  return {
    driver: config.notifications.driver,
    sms: {
      provider: 'twilio',
      configured: twilioConfigured(),
      from: twilioConfigured() ? config.notifications.twilio.fromNumber : null,
    },
    email: {
      provider: 'sendgrid',
      configured: sendgridConfigured(),
      from: sendgridConfigured() ? config.notifications.sendgrid.fromEmail : null,
    },
    notifyOnStatuses: config.notifications.notifyOnStatuses,
  };
}
