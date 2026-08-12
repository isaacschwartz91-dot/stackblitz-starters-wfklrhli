import multer from 'multer';
import { ZodError } from 'zod';

import { config } from '../config.js';
import { ApiError } from '../lib/errors.js';

/** Postgres SQLSTATEs worth translating into a useful client-facing message. */
const PG_ERRORS = {
  '23505': { status: 409, code: 'conflict', message: 'That value is already in use' },
  '23503': { status: 400, code: 'bad_request', message: 'Referenced record does not exist' },
  '23514': { status: 422, code: 'unprocessable_entity', message: 'Record violates a data constraint' },
  '22P02': { status: 400, code: 'bad_request', message: 'Malformed identifier or value' },
  '23502': { status: 422, code: 'unprocessable_entity', message: 'A required field was missing' },
};

/** Maps a unique-violation constraint name onto the field the client sent. */
const UNIQUE_CONSTRAINT_FIELDS = {
  orders_order_ref_key: { field: 'orderRef', message: 'An order with this reference already exists' },
  orders_barcode_value_key: { field: 'barcodeValue', message: 'That barcode value is already in use' },
  orders_tracking_token_key: { field: 'trackingToken', message: 'That tracking token is already in use' },
  users_email_lower_key: { field: 'email', message: 'An account with this email already exists' },
  proof_of_delivery_attempt_key: {
    field: 'attemptNumber',
    message: 'Proof of delivery for this attempt already exists',
  },
};

function formatZodError(error) {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || undefined,
    message: issue.message,
  }));
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` },
  });
}

// Express identifies error middleware by arity — `next` must stay declared.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'validation_failed',
        message: 'Some fields are invalid',
        details: formatZodError(err),
      },
    });
    return;
  }

  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(status).json({
      error: { code: 'upload_failed', message: err.message, details: { field: err.field } },
    });
    return;
  }

  if (err?.code && PG_ERRORS[err.code]) {
    const mapped = PG_ERRORS[err.code];
    const unique = err.constraint ? UNIQUE_CONSTRAINT_FIELDS[err.constraint] : undefined;
    res.status(mapped.status).json({
      error: {
        code: mapped.code,
        message: unique?.message ?? mapped.message,
        ...(unique ? { details: { field: unique.field } } : {}),
      },
    });
    return;
  }

  // Body-parser surfaces malformed JSON as a SyntaxError with a status.
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    res.status(400).json({ error: { code: 'bad_request', message: 'Request body is not valid JSON' } });
    return;
  }

  console.error('[error]', err);
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Something went wrong',
      // Stacks help in dev and leak internals in production.
      ...(config.isProduction ? {} : { details: { message: err?.message, stack: err?.stack } }),
    },
  });
}
