import { Router } from 'express';

import { getPublicTracking } from '../services/trackingService.js';

const router = Router();

/**
 * Public delivery status. No authentication by design — the customer opens this
 * from a text message. The tracking token is the credential.
 */
router.get('/:token', async (req, res) => {
  const tracking = await getPublicTracking(req.params.token);
  res
    // Never let a shared proxy or CDN cache someone's delivery details.
    .set('Cache-Control', 'no-store')
    .set('X-Robots-Tag', 'noindex, nofollow')
    .json({ tracking });
});

export default router;
