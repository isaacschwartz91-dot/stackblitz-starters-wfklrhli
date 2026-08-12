import { Router } from 'express';

import { config } from '../config.js';
import { forbidden } from '../lib/errors.js';
import { detectImageType, storage, verifyLocalSignature } from '../storage/index.js';

const router = Router();

/**
 * Serves a stored proof-of-delivery image.
 *
 * Deliberately unauthenticated: the link is handed to customers by SMS/email and
 * shown on the public tracking page. Access is granted by the expiring HMAC
 * signature in the query string, not by a session. Only used by the local
 * storage driver — with S3 the signed URL points straight at the bucket.
 */
router.get('/*splat', async (req, res) => {
  const key = Array.isArray(req.params.splat) ? req.params.splat.join('/') : req.params.splat;
  const { expires, sig } = req.query;

  if (!verifyLocalSignature(key, expires, sig)) {
    throw forbidden('This link is invalid or has expired');
  }

  const body = await storage().get(key);
  const detected = detectImageType(body);

  res
    .type(detected?.type ?? 'application/octet-stream')
    // Private: shareable by whoever holds the link, but not cached by proxies.
    .set('Cache-Control', `private, max-age=${config.storage.urlTtlSeconds}`)
    .set('X-Content-Type-Options', 'nosniff')
    .send(body);
});

export default router;
