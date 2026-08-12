export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const badRequest = (message, details) =>
  new ApiError(400, 'bad_request', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new ApiError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have access to this resource') =>
  new ApiError(403, 'forbidden', message);

export const notFound = (message = 'Resource not found') =>
  new ApiError(404, 'not_found', message);

export const conflict = (message, details) =>
  new ApiError(409, 'conflict', message, details);

export const unprocessable = (message, details) =>
  new ApiError(422, 'unprocessable_entity', message, details);

export const payloadTooLarge = (message) =>
  new ApiError(413, 'payload_too_large', message);
