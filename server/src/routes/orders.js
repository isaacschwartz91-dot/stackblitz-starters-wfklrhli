import { Router } from 'express';
import multer from 'multer';

import { config } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { buildCsvTemplate } from '../lib/csvImport.js';
import {
  renderBarcodePng,
  renderBarcodeSvg,
  renderLabelHtml,
  renderQrPng,
  renderQrSvg,
} from '../lib/labels.js';
import { trackingUrl } from '../lib/identifiers.js';
import { authenticate, requireRole, requireStaff } from '../middleware/auth.js';
import {
  assignOrderSchema,
  changeStatusSchema,
  createOrderSchema,
  listOrdersQuerySchema,
  updateOrderSchema,
} from '../schemas/orders.js';
import * as assignmentService from '../services/assignmentService.js';
import * as orderService from '../services/orderService.js';
import * as scanService from '../services/scanService.js';
import * as batches from '../repositories/importBatchRepository.js';

const router = Router();

// CSVs are small and processed in one pass; memory storage avoids temp-file
// cleanup entirely.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.csvMaxBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /csv|excel|text\/plain|octet-stream/i.test(file.mimetype) ||
      /\.csv$/i.test(file.originalname);
    cb(ok ? null : badRequest('Upload a .csv file'), ok);
  },
});

router.use(authenticate);

// ---------------------------------------------------------------------------
// CSV helpers (before /:id so "template" isn't parsed as an order id)
// ---------------------------------------------------------------------------

router.get('/import/template', requireStaff, (_req, res) => {
  res.type('text/csv').attachment('order-import-template.csv').send(buildCsvTemplate());
});

router.get('/import/batches', requireStaff, async (_req, res) => {
  res.json({ batches: await batches.list({ limit: 20 }) });
});

router.get('/import/batches/:id', requireStaff, async (req, res) => {
  const batch = await batches.findById(req.params.id);
  if (!batch) {
    res.status(404).json({ error: { code: 'not_found', message: 'Import batch not found' } });
    return;
  }
  res.json({ batch });
});

router.post('/import', requireStaff, upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Attach a CSV file in the "file" field');

  const result = await orderService.importOrdersFromCsv({
    content: req.file.buffer,
    filename: req.file.originalname,
    actorId: req.user.id,
  });

  // 207: some rows may have failed while others were created.
  res.status(result.errors.length > 0 ? 207 : 201).json({
    batch: result.batch,
    createdCount: result.created.length,
    failedCount: result.errors.length,
    orders: result.created,
    errors: result.errors,
    unknownHeaders: result.unknownHeaders,
  });
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

router.get('/', async (req, res) => {
  const filters = listOrdersQuerySchema.parse(req.query);

  // Drivers only ever see their own work.
  if (req.user.role === 'driver') filters.driverId = req.user.id;

  res.json(await orderService.listOrders(filters));
});

router.post('/', requireStaff, async (req, res) => {
  const data = createOrderSchema.parse(req.body);
  const order = await orderService.createOrder({ data, actorId: req.user.id });
  res.status(201).json({ order });
});

router.get('/:id', async (req, res) => {
  const order = await orderService.getOrderWithHistory(req.params.id);
  res.json({ order });
});

router.patch('/:id', requireStaff, async (req, res) => {
  const patch = updateOrderSchema.parse(req.body);
  res.json({ order: await orderService.updateOrder(req.params.id, patch) });
});

router.patch('/:id/status', requireStaff, async (req, res) => {
  const { status, notes } = changeStatusSchema.parse(req.body);
  const result = await orderService.changeOrderStatus({
    orderId: req.params.id,
    toStatus: status,
    actorId: req.user.id,
    notes,
  });
  res.json(result);
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  res.json(await orderService.deleteOrder(req.params.id));
});

/** Every scan against this order, including rejected ones. */
router.get('/:id/scans', async (req, res) => {
  await orderService.getOrder(req.params.id);
  res.json({ scans: await scanService.listOrderScans(req.params.id) });
});

// ---------------------------------------------------------------------------
// Driver assignment
// ---------------------------------------------------------------------------

router.post('/:id/assign', requireStaff, async (req, res) => {
  const { driverId, notes } = assignOrderSchema.parse(req.body);
  const order = await assignmentService.assignOrder({
    orderId: req.params.id,
    driverId,
    actorId: req.user.id,
    notes,
  });
  res.json({ order });
});

router.get('/:id/assignments', requireStaff, async (req, res) => {
  await orderService.getOrder(req.params.id);
  res.json({ assignments: await assignmentService.listAssignmentHistory(req.params.id) });
});

// ---------------------------------------------------------------------------
// Label + barcode rendering
// ---------------------------------------------------------------------------

/**
 * Both symbologies encode the order's barcode value by default. `?content=tracking`
 * switches the QR to the customer tracking URL, for merchants who want a
 * customer-scannable code on the packing slip.
 */
async function resolveCodeContent(orderId, contentParam) {
  const order = await orderService.getOrder(orderId);
  const value = contentParam === 'tracking'
    ? trackingUrl(config.publicBaseUrl, order.trackingToken)
    : order.barcodeValue;
  return { order, value };
}

router.get('/:id/label', async (req, res) => {
  const order = await orderService.getOrder(req.params.id);
  const html = await renderLabelHtml(order, { baseUrl: config.publicBaseUrl });
  res.type('html').send(html);
});

router.get('/:id/barcode.png', async (req, res) => {
  const { value } = await resolveCodeContent(req.params.id, req.query.content);
  const png = await renderBarcodePng(value, req.query);
  res.type('png').set('Cache-Control', 'private, max-age=300').send(png);
});

router.get('/:id/barcode.svg', async (req, res) => {
  const { value } = await resolveCodeContent(req.params.id, req.query.content);
  const svg = await renderBarcodeSvg(value, req.query);
  res.type('svg').set('Cache-Control', 'private, max-age=300').send(svg);
});

router.get('/:id/qr.png', async (req, res) => {
  const { value } = await resolveCodeContent(req.params.id, req.query.content);
  const png = await renderQrPng(value, req.query);
  res.type('png').set('Cache-Control', 'private, max-age=300').send(png);
});

router.get('/:id/qr.svg', async (req, res) => {
  const { value } = await resolveCodeContent(req.params.id, req.query.content);
  const svg = await renderQrSvg(value, req.query);
  res.type('svg').set('Cache-Control', 'private, max-age=300').send(svg);
});

export default router;
