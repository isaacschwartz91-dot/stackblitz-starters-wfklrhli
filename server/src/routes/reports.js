import { Router } from 'express';
import { z } from 'zod';

import { badRequest, notFound } from '../lib/errors.js';
import { authenticate, requireStaff } from '../middleware/auth.js';
import * as reports from '../services/reportService.js';

const router = Router();

const rangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  zone: z.string().max(64).optional(),
  driverId: z.string().uuid().optional(),
}).strict().refine(
  (q) => !q.from || !q.to || q.from <= q.to,
  { message: 'from must be before to', path: ['from'] },
);

/** Reports are staff-only: they cover every driver's performance. */
router.use(authenticate, requireStaff);

function parseRange(query) {
  const parsed = rangeSchema.parse(query);
  return { ...reports.resolveRange(parsed), zone: parsed.zone, driverId: parsed.driverId };
}

router.get('/summary', async (req, res) => {
  res.json(await reports.summary(parseRange(req.query)));
});

router.get('/scan-to-delivery', async (req, res) => {
  const range = parseRange(req.query);
  res.json({ range: { from: range.from, to: range.to }, timing: await reports.scanToDeliveryTime(range) });
});

router.get('/drivers', async (req, res) => {
  const range = parseRange(req.query);
  const [perDay, totals] = await Promise.all([
    reports.deliveriesPerDriver(range),
    reports.driverTotals(range),
  ]);
  res.json({ range: { from: range.from, to: range.to }, perDay, totals });
});

router.get('/failures', async (req, res) => {
  const range = parseRange(req.query);
  res.json({ range: { from: range.from, to: range.to }, ...(await reports.failedDeliveries(range)) });
});

router.get('/daily-volume', async (req, res) => {
  const range = parseRange(req.query);
  res.json({ range: { from: range.from, to: range.to }, days: await reports.dailyVolume(range) });
});

/** CSV export: /api/reports/export/deliveries?from=…&to=… */
router.get('/export/:report', async (req, res) => {
  const range = parseRange(req.query);
  const result = await reports.buildCsvReport(req.params.report, range);

  if (!result) {
    throw notFound(
      `Unknown report "${req.params.report}". Available: ${Object.keys(reports.CSV_REPORTS).join(', ')}`,
    );
  }

  res.type('text/csv').attachment(result.filename).send(result.csv);
});

export default router;
