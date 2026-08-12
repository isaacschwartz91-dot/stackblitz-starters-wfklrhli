import { z } from 'zod';

import { ORDER_STATUSES } from '../lib/statusMachine.js';

/** Collapses internal whitespace and trims; '' becomes undefined. */
const text = (max) =>
  z
    .string()
    .transform((value) => value.replace(/\s+/g, ' ').trim())
    .pipe(z.string().max(max));

const optionalText = (max) =>
  z
    .string()
    .transform((value) => {
      const cleaned = value.replace(/\s+/g, ' ').trim();
      return cleaned === '' ? undefined : cleaned;
    })
    .pipe(z.string().max(max).optional())
    .optional();

/**
 * Phone numbers arrive from CSVs in every shape a human can type. Keep a single
 * canonical form so notification dispatch in phase 5 never has to guess.
 */
export function normalisePhone(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;

  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null; // null = present but invalid
  return `${hasPlus ? '+' : ''}${digits}`;
}

const phoneField = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value.trim() === '') return undefined;
    const normalised = normalisePhone(value);
    if (normalised === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Phone number must contain between 7 and 15 digits',
      });
      return z.NEVER;
    }
    return normalised;
  });

const emailField = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value.trim() === '') return undefined;
    const cleaned = value.trim().toLowerCase();
    if (!z.string().email().safeParse(cleaned).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid email address' });
      return z.NEVER;
    }
    return cleaned;
  });

/** Fields shared by the JSON create endpoint and the CSV importer. */
export const orderFieldsShape = {
  orderRef: text(64).refine((v) => v.length > 0, 'Order reference is required'),
  customerName: text(200).refine((v) => v.length > 0, 'Customer name is required'),
  customerPhone: phoneField,
  customerEmail: emailField,
  addressLine1: text(200).refine((v) => v.length > 0, 'Address line 1 is required'),
  addressLine2: optionalText(200),
  city: optionalText(120),
  region: optionalText(120),
  postalCode: optionalText(32),
  country: optionalText(120),
  deliveryZone: optionalText(64),
  deliveryNotes: optionalText(1000),
};

// The DB enforces this too (orders_contact_present); checking here turns a 500
// from a constraint violation into a field-level 422.
const requireContact = (data, ctx) => {
  if (!data.customerPhone && !data.customerEmail) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['customerPhone'],
      message: 'Provide a phone number or an email address so the customer can be notified',
    });
  }
};

export const createOrderSchema = z
  .object(orderFieldsShape)
  .strict()
  .superRefine(requireContact);

/**
 * Updates are partial, and deliberately exclude orderRef and barcodeValue:
 * both are printed on a physical label that may already be on a parcel.
 */
export const updateOrderSchema = z
  .object({
    customerName: orderFieldsShape.customerName.optional(),
    customerPhone: phoneField,
    customerEmail: emailField,
    addressLine1: orderFieldsShape.addressLine1.optional(),
    addressLine2: optionalText(200),
    city: optionalText(120),
    region: optionalText(120),
    postalCode: optionalText(32),
    country: optionalText(120),
    deliveryZone: optionalText(64),
    deliveryNotes: optionalText(1000),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, 'No fields to update');

export const changeStatusSchema = z
  .object({
    status: z.enum(ORDER_STATUSES),
    notes: optionalText(1000),
  })
  .strict();

const uuid = z.string().uuid('Must be a UUID');

export const assignOrderSchema = z
  .object({
    driverId: uuid.nullable(),
    notes: optionalText(1000),
  })
  .strict();

const csvList = (values) =>
  z
    .string()
    .transform((value) => value.split(',').map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).min(1))
    .optional();

export const listOrdersQuerySchema = z
  .object({
    status: csvList(ORDER_STATUSES),
    driverId: z.union([uuid, z.literal('unassigned')]).optional(),
    zone: z.string().max(64).optional(),
    q: z.string().max(200).optional(),
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
    sort: z.enum(['created_at', 'ready_at', 'order_ref', 'status']).default('created_at'),
    direction: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict()
  .refine(
    (q) => !q.createdFrom || !q.createdTo || q.createdFrom <= q.createdTo,
    { message: 'createdFrom must be before createdTo', path: ['createdFrom'] },
  );
