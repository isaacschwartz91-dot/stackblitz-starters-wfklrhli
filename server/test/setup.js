/**
 * Must be the first import in every test file: it pins the environment before
 * src/config.js is evaluated.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres@127.0.0.1:5433/delivery_tracking_test';
process.env.PUBLIC_BASE_URL = 'http://localhost:5173';
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER ?? 'memory';
process.env.NOTIFICATIONS_DRIVER = process.env.NOTIFICATIONS_DRIVER ?? 'log';
