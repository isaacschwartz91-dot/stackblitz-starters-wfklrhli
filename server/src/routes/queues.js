import { Router } from 'express';
import { z } from 'zod';

import { forbidden } from '../lib/errors.js';
import { authenticate, requireStaff } from '../middleware/auth.js';
import * as assignmentService from '../services/assignmentService.js';

const router = Router();

const autoBatchSchema = z.object({
  // Omitting the zone batches every waiting parcel regardless of zone.
  zone: z.string().max(64).optional(),
  driverIds: z.array(z.string().uuid()).min(1, 'Choose at least one driver').max(50),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();

router.use(authenticate);

/** Unassigned, ready-to-go parcels grouped by zone. */
router.get('/dispatch', requireStaff, async (_req, res) => {
  res.json({ zones: await assignmentService.dispatchQueue() });
});

/** The signed-in driver's own work queue. */
router.get('/mine', async (req, res) => {
  if (req.user.role !== 'driver') {
    throw forbidden('Only drivers have a delivery queue');
  }
  res.json(await assignmentService.driverQueue(req.user.id));
});

/** A specific driver's queue — for dispatchers checking on someone's load. */
router.get('/driver/:driverId', requireStaff, async (req, res) => {
  res.json(await assignmentService.driverQueue(req.params.driverId));
});

router.post('/auto-batch', requireStaff, async (req, res) => {
  const { zone, driverIds, limit } = autoBatchSchema.parse(req.body);
  const result = await assignmentService.autoBatchByZone({
    zone,
    driverIds,
    limit,
    actorId: req.user.id,
  });
  res.json(result);
});

export default router;
