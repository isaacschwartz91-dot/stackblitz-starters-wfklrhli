/**
 * Label rendering: Code 128 barcode, QR code, and a printable label sheet.
 *
 * Both symbologies encode the same `barcode_value`, so a phone camera reading
 * either one produces identical scanner input. The customer tracking URL is
 * printed as text rather than encoded, to keep the scannable region unambiguous
 * for staff and drivers.
 */
import bwipjs from 'bwip-js/node';
import QRCode from 'qrcode';

import { badRequest } from './errors.js';
import { trackingUrl } from './identifiers.js';

const BARCODE_DEFAULTS = { scale: 3, height: 14, includetext: true };
const QR_DEFAULTS = { width: 240, margin: 1, errorCorrectionLevel: 'M' };

function clamp(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function barcodeOptions({ scale, height, includetext } = {}) {
  return {
    bcid: 'code128',
    scale: clamp(scale, 1, 8, BARCODE_DEFAULTS.scale),
    height: clamp(height, 5, 40, BARCODE_DEFAULTS.height),
    includetext: includetext ?? BARCODE_DEFAULTS.includetext,
    textxalign: 'center',
    textsize: 8,
  };
}

export async function renderBarcodePng(value, options = {}) {
  if (!value) throw badRequest('A barcode value is required');
  return bwipjs.toBuffer({ ...barcodeOptions(options), text: value });
}

export async function renderBarcodeSvg(value, options = {}) {
  if (!value) throw badRequest('A barcode value is required');
  return bwipjs.toSVG({ ...barcodeOptions(options), text: value });
}

export function qrOptions({ width, margin, errorCorrectionLevel } = {}) {
  return {
    width: clamp(width, 64, 1024, QR_DEFAULTS.width),
    margin: clamp(margin, 0, 8, QR_DEFAULTS.margin),
    errorCorrectionLevel: ['L', 'M', 'Q', 'H'].includes(errorCorrectionLevel)
      ? errorCorrectionLevel
      : QR_DEFAULTS.errorCorrectionLevel,
  };
}

export async function renderQrPng(value, options = {}) {
  if (!value) throw badRequest('A QR value is required');
  return QRCode.toBuffer(value, { type: 'png', ...qrOptions(options) });
}

export async function renderQrSvg(value, options = {}) {
  if (!value) throw badRequest('A QR value is required');
  return QRCode.toString(value, { type: 'svg', ...qrOptions(options) });
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function formatAddress(order) {
  return [
    order.addressLine1,
    order.addressLine2,
    [order.city, order.region, order.postalCode].filter(Boolean).join(' '),
    order.country,
  ].filter(Boolean);
}

/**
 * Self-contained printable label (4in x 6in). Images are inlined as data URIs
 * so the page prints correctly from a phone with no follow-up requests and no
 * auth token on an <img> URL.
 */
export async function renderLabelHtml(order, { baseUrl } = {}) {
  const [barcodePng, qrPng] = await Promise.all([
    renderBarcodePng(order.barcodeValue, { scale: 3, height: 16 }),
    renderQrPng(order.barcodeValue, { width: 200 }),
  ]);

  const barcodeSrc = `data:image/png;base64,${barcodePng.toString('base64')}`;
  const qrSrc = `data:image/png;base64,${qrPng.toString('base64')}`;
  const track = baseUrl ? trackingUrl(baseUrl, order.trackingToken) : null;
  const addressLines = formatAddress(order)
    .map((line) => `<div>${escapeHtml(line)}</div>`)
    .join('\n        ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Label ${escapeHtml(order.orderRef)}</title>
<style>
  @page { size: 4in 6in; margin: 0; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #000;
    background: #fff;
  }
  .label {
    width: 4in; height: 6in; padding: 0.22in;
    display: flex; flex-direction: column; gap: 0.12in;
  }
  .row { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.15in; }
  .muted { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em; color: #444; }
  .ref { font-size: 15pt; font-weight: 700; font-variant-numeric: tabular-nums; }
  .zone {
    font-size: 20pt; font-weight: 700; line-height: 1;
    border: 2px solid #000; border-radius: 6px; padding: 0.06in 0.12in;
  }
  .customer { font-size: 13pt; font-weight: 700; }
  .address { font-size: 11pt; line-height: 1.35; }
  .notes { font-size: 9pt; border-left: 3px solid #000; padding-left: 0.08in; }
  .spacer { flex: 1; }
  .codes { display: flex; align-items: flex-end; gap: 0.15in; }
  .codes img { display: block; }
  .barcode { flex: 1; }
  .barcode img { width: 100%; height: auto; }
  .track { font-size: 7.5pt; color: #333; word-break: break-all; text-align: center; }
  hr { border: 0; border-top: 1px solid #000; margin: 0; }
</style>
</head>
<body>
  <div class="label">
    <div class="row">
      <div>
        <div class="muted">Order</div>
        <div class="ref">${escapeHtml(order.orderRef)}</div>
      </div>
      ${order.deliveryZone ? `<div class="zone">${escapeHtml(order.deliveryZone)}</div>` : ''}
    </div>
    <hr>
    <div>
      <div class="muted">Deliver to</div>
      <div class="customer">${escapeHtml(order.customerName)}</div>
      <div class="address">
        ${addressLines}
      </div>
      ${order.customerPhone ? `<div class="address">${escapeHtml(order.customerPhone)}</div>` : ''}
    </div>
    ${order.deliveryNotes ? `<div class="notes">${escapeHtml(order.deliveryNotes)}</div>` : ''}
    <div class="spacer"></div>
    <div class="codes">
      <img src="${qrSrc}" alt="QR code for ${escapeHtml(order.barcodeValue)}" width="110" height="110">
      <div class="barcode">
        <img src="${barcodeSrc}" alt="Barcode ${escapeHtml(order.barcodeValue)}">
      </div>
    </div>
    ${track ? `<div class="track">Track this delivery: ${escapeHtml(track)}</div>` : ''}
  </div>
</body>
</html>
`;
}
