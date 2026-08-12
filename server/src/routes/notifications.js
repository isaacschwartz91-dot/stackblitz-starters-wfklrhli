import { Router } from 'express';

import { authenticate, requireAdmin, requireStaff } from '../middleware/auth.js';
import { providerStatus } from '../notifications/providers.js';
import * as notificationService from '../services/notificationService.js';

const router = Router();

router.use(authenticate);

/**
 * Which channels are actually wired up. The admin screen shows this so a
 * missing API key is visible before customers stop getting messages.
 */
router.get('/status', requireStaff, (_req, res) => {
  res.json({ notifications: providerStatus() });
});

router.get('/', requireStaff, async (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit ?? '50', 10) || 50, 200);
  res.json({ notifications: await notificationService.listRecent({ limit, status: req.query.status }) });
});

router.post('/retry', requireAdmin, async (_req, res) => {
  const retried = await notificationService.retryFailed({ limit: 50 });
  res.json({ retried: retried.length, notifications: retried });
});

export default router;
