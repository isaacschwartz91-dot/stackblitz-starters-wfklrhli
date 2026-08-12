import { Router } from 'express';
import { z } from 'zod';

import { authenticate, requireAdmin, requireStaff } from '../middleware/auth.js';
import { providerStatus } from '../notifications/providers.js';
import { config } from '../config.js';
import * as settingsService from '../services/settingsService.js';

const router = Router();

// Keys are validated against the registry in the service; this only checks shape.
const updateSchema = z.record(z.string(), z.boolean()).refine(
  (patch) => Object.keys(patch).length > 0,
  { message: 'No settings to update' },
);

router.use(authenticate);

/**
 * Current values plus the registry that describes them, so the admin screen
 * renders whatever settings exist without needing its own copy of the list.
 */
router.get('/', requireStaff, async (_req, res) => {
  res.json(await settingsService.describeSettings());
});

/**
 * Read-only environment facts worth surfacing next to the editable settings —
 * these are deployment configuration, not something to toggle at runtime.
 */
router.get('/environment', requireStaff, (_req, res) => {
  res.json({
    environment: {
      allowDriverSelfAssign: config.allowDriverSelfAssign,
      storageDriver: config.storage.driver,
      proofUrlTtlSeconds: config.storage.urlTtlSeconds,
      publicBaseUrl: config.publicBaseUrl,
    },
    notifications: providerStatus(),
  });
});

router.patch('/', requireAdmin, async (req, res) => {
  const patch = updateSchema.parse(req.body);
  const settings = await settingsService.updateSettings(patch, { actorId: req.user.id });
  res.json({ settings });
});

export default router;
