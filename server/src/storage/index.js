/**
 * Object storage for proof-of-delivery images.
 *
 * Three drivers behind one interface:
 *   local  — writes under STORAGE_LOCAL_DIR and serves through /api/files.
 *            The default, so the app runs with no cloud account.
 *   s3     — any S3-compatible bucket (AWS, Cloudflare R2, MinIO, Backblaze).
 *   memory — keeps blobs in the process; used by the test suite.
 *
 * Images are never public. Reads go through a signed, expiring URL, because the
 * customer-facing tracking page has to show a delivery photo without a login.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';

import { config } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';

/** Magic-byte sniffing: never trust a client-supplied content type. */
const IMAGE_SIGNATURES = [
  { type: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/webp', ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, extra: { at: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
];

export function detectImageType(buffer) {
  for (const signature of IMAGE_SIGNATURES) {
    const matches = signature.bytes.every((byte, i) => buffer[i] === byte);
    if (!matches) continue;
    if (signature.extra) {
      const ok = signature.extra.bytes.every((byte, i) => buffer[signature.extra.at + i] === byte);
      if (!ok) continue;
    }
    return { type: signature.type, ext: signature.ext };
  }
  return null;
}

export function assertIsImage(buffer, field) {
  if (!buffer?.length) throw badRequest(`${field} is empty`);
  const detected = detectImageType(buffer);
  if (!detected) {
    throw badRequest(`${field} must be a JPEG, PNG or WebP image`);
  }
  if (buffer.length > config.storage.maxUploadBytes) {
    throw badRequest(
      `${field} is larger than ${Math.round(config.storage.maxUploadBytes / 1024 / 1024)}MB`,
    );
  }
  return detected;
}

/** Parses a canvas `toDataURL()` payload into a buffer. */
export function decodeDataUrl(dataUrl, field) {
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(String(dataUrl).trim());
  if (!match) throw badRequest(`${field} must be a base64 image data URL`);
  const buffer = Buffer.from(match[2], 'base64');
  assertIsImage(buffer, field);
  return buffer;
}

// --- Signed URLs for the local driver ---------------------------------------

function signKey(key, expiresAt) {
  return createHmac('sha256', config.jwtSecret)
    .update(`${key}:${expiresAt}`)
    .digest('base64url');
}

export function verifyLocalSignature(key, expiresAt, signature) {
  const expected = signKey(key, expiresAt);
  const provided = String(signature ?? '');
  if (expected.length !== provided.length) return false;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) return false;
  return Number(expiresAt) > Math.floor(Date.now() / 1000);
}

// --- Drivers ----------------------------------------------------------------

/** Blocks `../` traversal out of the upload directory. */
function safeLocalPath(key) {
  const root = resolve(config.storage.localDir);
  const target = resolve(join(root, normalize(key)));
  if (target !== root && !target.startsWith(root + sep)) {
    throw badRequest('Invalid storage key');
  }
  return target;
}

const localDriver = {
  name: 'local',
  async put({ key, body }) {
    const path = safeLocalPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return { key };
  },
  async get(key) {
    try {
      return await readFile(safeLocalPath(key));
    } catch (err) {
      if (err.code === 'ENOENT') throw notFound('File not found');
      throw err;
    }
  },
  async remove(key) {
    await unlink(safeLocalPath(key)).catch(() => {});
  },
  async signedUrl(key, ttlSeconds = config.storage.urlTtlSeconds) {
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    const signature = signKey(key, expiresAt);
    return `${config.apiBaseUrl}/api/files/${key.split('/').map(encodeURIComponent).join('/')}` +
      `?expires=${expiresAt}&sig=${signature}`;
  },
};

const memoryStore = new Map();

const memoryDriver = {
  name: 'memory',
  async put({ key, body }) {
    memoryStore.set(key, Buffer.from(body));
    return { key };
  },
  async get(key) {
    const value = memoryStore.get(key);
    if (!value) throw notFound('File not found');
    return value;
  },
  async remove(key) {
    memoryStore.delete(key);
  },
  signedUrl: localDriver.signedUrl,
};

/**
 * S3-compatible driver. The SDK is imported lazily so deployments using local
 * storage never pay to load it.
 */
function createS3Driver() {
  const settings = config.storage.s3;
  if (!settings.bucket) {
    throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET to be set');
  }

  let clientPromise;
  async function getClient() {
    if (!clientPromise) {
      clientPromise = (async () => {
        const { S3Client } = await import('@aws-sdk/client-s3');
        return new S3Client({
          region: settings.region,
          endpoint: settings.endpoint,
          forcePathStyle: settings.forcePathStyle,
          credentials: settings.accessKeyId && settings.secretAccessKey
            ? { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey }
            : undefined, // fall back to the instance role / ambient credentials
        });
      })();
    }
    return clientPromise;
  }

  return {
    name: 's3',
    async put({ key, body, contentType }) {
      const [{ PutObjectCommand }, client] = await Promise.all([
        import('@aws-sdk/client-s3'),
        getClient(),
      ]);
      await client.send(new PutObjectCommand({
        Bucket: settings.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }));
      return { key };
    },
    async get(key) {
      const [{ GetObjectCommand }, client] = await Promise.all([
        import('@aws-sdk/client-s3'),
        getClient(),
      ]);
      const result = await client.send(new GetObjectCommand({ Bucket: settings.bucket, Key: key }));
      return Buffer.from(await result.Body.transformToByteArray());
    },
    async remove(key) {
      const [{ DeleteObjectCommand }, client] = await Promise.all([
        import('@aws-sdk/client-s3'),
        getClient(),
      ]);
      await client.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: key }));
    },
    async signedUrl(key, ttlSeconds = config.storage.urlTtlSeconds) {
      const [{ GetObjectCommand }, { getSignedUrl }, client] = await Promise.all([
        import('@aws-sdk/client-s3'),
        import('@aws-sdk/s3-request-presigner'),
        getClient(),
      ]);
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: settings.bucket, Key: key }),
        { expiresIn: ttlSeconds },
      );
    },
  };
}

const DRIVERS = {
  local: () => localDriver,
  memory: () => memoryDriver,
  s3: createS3Driver,
};

let activeDriver;

export function storage() {
  if (!activeDriver) {
    const factory = DRIVERS[config.storage.driver];
    if (!factory) {
      throw new Error(
        `Unknown STORAGE_DRIVER "${config.storage.driver}". Expected one of: ${Object.keys(DRIVERS).join(', ')}`,
      );
    }
    activeDriver = factory();
  }
  return activeDriver;
}

/** Only for tests that need to switch drivers between cases. */
export function resetStorage() {
  activeDriver = undefined;
  memoryStore.clear();
}

/** Deterministic, non-guessable-ish key layout: proof/<orderId>/<attempt>/<kind>.<ext> */
export function proofKey({ orderId, attemptNumber, kind, ext }) {
  return `proof/${orderId}/${attemptNumber}/${kind}.${ext}`;
}
