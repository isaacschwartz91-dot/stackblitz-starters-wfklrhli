import 'dotenv/config';

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// A fixed dev secret keeps `npm run dev` working with no .env at all, but it
// must never be what protects a real deployment.
const DEV_JWT_SECRET = 'dev-only-insecure-jwt-secret';

function resolveJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (isProduction) {
    throw new Error('JWT_SECRET must be set when NODE_ENV=production');
  }
  return DEV_JWT_SECRET;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProduction,
  isTest,
  port: Number.parseInt(process.env.PORT ?? '4000', 10),

  databaseUrl: isProduction
    ? required('DATABASE_URL')
    : (process.env.DATABASE_URL ??
       'postgres://postgres:postgres@localhost:5432/delivery_tracking'),

  // Postgres in managed environments usually terminates unencrypted traffic;
  // opt in explicitly rather than silently disabling certificate checks.
  databaseSsl: process.env.DATABASE_SSL === 'true',
  databasePoolMax: Number.parseInt(process.env.DATABASE_POOL_MAX ?? '10', 10),

  jwtSecret: resolveJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  bcryptRounds: Number.parseInt(process.env.BCRYPT_ROUNDS ?? (isTest ? '4' : '12'), 10),

  // Used to build the customer-facing tracking link printed on labels.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),

  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  logFormat: process.env.LOG_FORMAT ?? (isProduction ? 'combined' : 'dev'),

  csvMaxBytes: Number.parseInt(process.env.CSV_MAX_BYTES ?? '5242880', 10),
  csvMaxRows: Number.parseInt(process.env.CSV_MAX_ROWS ?? '5000', 10),

  // When true, a driver scanning an unassigned parcel at pickup takes ownership
  // of it. Small teams want this; teams with strict dispatch control don't.
  allowDriverSelfAssign: process.env.ALLOW_DRIVER_SELF_ASSIGN !== 'false',

  storage: {
    driver: process.env.STORAGE_DRIVER ?? 'local',
    localDir: process.env.STORAGE_LOCAL_DIR ?? './var/uploads',
    urlTtlSeconds: Number.parseInt(process.env.STORAGE_URL_TTL_SECONDS ?? '604800', 10),
    maxUploadBytes: Number.parseInt(process.env.MAX_UPLOAD_BYTES ?? '10485760', 10),
    s3: {
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION ?? 'us-east-1',
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    },
  },

  notifications: {
    driver: process.env.NOTIFICATIONS_DRIVER ?? 'log',
    notifyOnStatuses: (process.env.NOTIFY_ON_STATUSES ??
      'ready_for_delivery,out_for_delivery,delivered,failed_attempt')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      fromNumber: process.env.TWILIO_FROM_NUMBER,
    },
    sendgrid: {
      apiKey: process.env.SENDGRID_API_KEY,
      fromEmail: process.env.SENDGRID_FROM_EMAIL,
      fromName: process.env.SENDGRID_FROM_NAME ?? 'Deliveries',
    },
  },
};

export function assertProductionReady() {
  if (!isProduction) return;
  if (config.jwtSecret === DEV_JWT_SECRET) {
    throw new Error('Refusing to start in production with the development JWT secret');
  }
}
