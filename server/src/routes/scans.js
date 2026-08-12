import { Router } from 'express';
import { z } from 'zod';

import { authenticate, requireStaff } from '../middleware/auth.js';
import * as scanService from '../services/scanService.js';

const router = Router();

const coordinate = (max) => z.coerce.number().min(-max).max(max).optional();

const scanSchema = z.object({
  barcodeValue: z.string().min(1, 'Scan a barcode').max(200),
  scanType: z.enum(['label_activation', 'pickup', 'dropoff']),
  outcome: z.enum(['delivered', 'failed']).optional(),
  failureReason: z.string().max(500).optional(),
  recipientName: z.string().max(200).optional(),
  notes: z.string().max(1000).optional(),
  deviceLabel: z.string().max(120).optional(),
  latitude: coordinate(90),
  longitude: coordinate(180),
}).strict();

const lookupSchema = z.object({
  value: z.string().min(1).max(200),
}).strict();

router.use(authenticate);

/** Read-only preview: what is this parcel, and what happens if I scan it? */
router.get('/lookup', async (req, res) => {
  const { value } = lookupSchema.parse(req.query);
  res.json(await scanService.lookupByBarcode({ scannedValue: value, actor: req.user }));
});

/** Recent scan activity, including rejected scans. Staff-only. */
router.get('/recent', requireStaff, async (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit ?? '50', 10) || 50, 200);
  res.json({ scans: await scanService.listRecentScans({ limit }) });
});

router.post('/', async (req, res) => {
  const payload = scanSchema.parse(req.body);
  const result = await scanService.recordScan({
    scannedValue: payload.barcodeValue,
    scanType: payload.scanType,
    outcome: payload.outcome,
    failureReason: payload.failureReason,
    recipientName: payload.recipientName,
    notes: payload.notes,
    deviceLabel: payload.deviceLabel,
    latitude: payload.latitude,
    longitude: payload.longitude,
    actor: req.user,
  });
  res.status(201).json(result);
});

export default router;
