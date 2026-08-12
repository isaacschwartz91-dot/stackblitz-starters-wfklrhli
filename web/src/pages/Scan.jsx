import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  ErrorNote, Modal, Spinner, StatusBadge, Toast, formatDateTime, useToast,
} from '../components.jsx';
import ProofCapture from './ProofCapture.jsx';

const SCAN_LABELS = {
  label_activation: 'Mark ready for delivery',
  pickup: 'Start delivery',
  dropoff: 'Complete delivery',
};

/**
 * Camera scanning screen.
 *
 * The library is imported lazily: it pulls in a WASM decoder that is dead weight
 * for anyone who never opens this page. Scanning is a two-step flow — look the
 * code up first, show the operator what they are holding, then let them confirm
 * the action — because an accidental scan should never silently change a status.
 */
export default function ScanPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [toast, notify, dismissToast] = useToast();

  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [manualCode, setManualCode] = useState('');
  const [lookup, setLookup] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showProof, setShowProof] = useState(false);

  const scannerRef = useRef(null);
  const lastScanRef = useRef({ code: null, at: 0 });

  const stopCamera = useCallback(async () => {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (!scanner) return;
    try {
      if (scanner.isScanning) await scanner.stop();
      scanner.clear();
    } catch {
      // Already stopped — nothing to clean up.
    }
  }, []);

  const doLookup = useCallback(async (code) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.get(`/api/scans/lookup?value=${encodeURIComponent(code)}`);
      setLookup(result);
      await stopCamera();
      setScanning(false);
      if (navigator.vibrate) navigator.vibrate(60);
    } catch (err) {
      setError(err);
      if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
    } finally {
      setBusy(false);
    }
  }, [stopCamera]);

  const onDecoded = useCallback((text) => {
    // The camera fires many times a second on the same code; ignore repeats.
    const now = Date.now();
    if (lastScanRef.current.code === text && now - lastScanRef.current.at < 3000) return;
    lastScanRef.current = { code: text, at: now };
    doLookup(text);
  }, [doLookup]);

  async function startCamera() {
    setCameraError(null);
    setError(null);
    setLookup(null);
    setScanning(true);

    try {
      const { Html5Qrcode } = await import('html5-qrcode');
      const scanner = new Html5Qrcode('scanner-region', { verbose: false });
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 260, height: 180 }, aspectRatio: 1.334 },
        onDecoded,
        () => {}, // per-frame "not found" callback: noisy, deliberately ignored
      );
    } catch (err) {
      setScanning(false);
      setCameraError(
        err?.message?.includes('Permission') || err?.name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow it in your browser settings, or type the code below.'
          : `Could not start the camera: ${err?.message ?? err}. You can type the code below instead.`,
      );
    }
  }

  useEffect(() => () => { stopCamera(); }, [stopCamera]);

  async function performScan(scanType, extra = {}) {
    setBusy(true);
    setError(null);
    try {
      const position = await currentPosition();
      const result = await api.post('/api/scans', {
        barcodeValue: lookup.order.barcodeValue,
        scanType,
        ...position,
        ...extra,
      });
      notify(`${lookup.order.orderRef} → ${result.order.status.replace(/_/g, ' ')}`);
      setLookup({ ...lookup, order: result.order, suggestedScan: null });

      // A completed drop-off is the end of the road for this parcel; get the
      // operator straight back to scanning the next one.
      setTimeout(() => { setLookup(null); startCamera(); }, 1200);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page page--narrow">
      <div className="page__header">
        <div>
          <h1>Scan</h1>
          <p className="page__subtitle">
            {user.role === 'driver'
              ? 'Scan at pickup and again at the door'
              : 'Scan a label to start tracking the parcel'}
          </p>
        </div>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {cameraError ? <div className="note note--warn">{cameraError}</div> : null}

      <div className="scanner">
        {scanning ? (
          <>
            <div className="scanner__viewport">
              <div id="scanner-region" />
            </div>
            <p className="scanner__hint">Point the camera at the barcode or QR code</p>
            <button
              type="button"
              className="button button--ghost button--block"
              style={{ marginTop: 10 }}
              onClick={async () => { await stopCamera(); setScanning(false); }}
            >
              Stop camera
            </button>
          </>
        ) : lookup ? (
          <ScanResult
            lookup={lookup}
            busy={busy}
            onScan={performScan}
            onCaptureProof={() => setShowProof(true)}
            onOpen={() => navigate(`/orders/${lookup.order.id}`)}
            onReset={() => { setLookup(null); setError(null); }}
          />
        ) : (
          <div className="card">
            <div className="card__body">
              <button type="button" className="button button--lg button--block" onClick={startCamera}>
                📷 Open camera
              </button>

              <div className="scanner__manual">
                <input
                  type="text"
                  value={manualCode}
                  placeholder="DTS-XXXX-XXXX"
                  aria-label="Enter the code by hand"
                  onChange={(e) => setManualCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && manualCode.trim()) doLookup(manualCode.trim());
                  }}
                />
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={busy || !manualCode.trim()}
                  onClick={() => doLookup(manualCode.trim())}
                >
                  Look up
                </button>
              </div>
              <p className="scanner__hint">
                Damaged label? Type the code printed under the barcode.
              </p>
            </div>
          </div>
        )}

        {busy && !lookup ? <div className="page-centre"><Spinner /></div> : null}
      </div>

      {showProof && lookup ? (
        <Modal title="Complete delivery" onClose={() => setShowProof(false)} wide>
          <ProofCapture
            order={lookup.order}
            onDone={() => {
              setShowProof(false);
              notify('Delivery completed');
              setLookup(null);
              startCamera();
            }}
            onCancel={() => setShowProof(false)}
          />
        </Modal>
      ) : null}

      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  );
}

function ScanResult({ lookup, busy, onScan, onCaptureProof, onOpen, onReset }) {
  const { order, suggestedScan } = lookup;
  const isDropoff = suggestedScan?.scanType === 'dropoff';

  return (
    <div className="card">
      <div className="card__body scan-result">
        <div className="scan-result__code mono">{order.barcodeValue}</div>
        <h2 style={{ marginTop: 10 }}>{order.orderRef}</h2>
        <div style={{ margin: '10px 0' }}>
          <StatusBadge status={order.status} size="lg" />
        </div>

        <p><strong>{order.customerName}</strong></p>
        <p className="page__subtitle">
          {order.addressLine1}
          {order.addressLine2 ? `, ${order.addressLine2}` : ''}
          <br />
          {[order.city, order.postalCode].filter(Boolean).join(' ')}
        </p>
        {order.deliveryNotes ? (
          <div className="note note--info" style={{ marginTop: 14, textAlign: 'left' }}>
            {order.deliveryNotes}
          </div>
        ) : null}

        <div className="stack" style={{ marginTop: 18 }}>
          {suggestedScan ? (
            isDropoff ? (
              <button type="button" className="button button--lg button--ok button--block"
                disabled={busy} onClick={onCaptureProof}>
                {SCAN_LABELS.dropoff}
              </button>
            ) : (
              <button type="button" className="button button--lg button--block"
                disabled={busy} onClick={() => onScan(suggestedScan.scanType)}>
                {busy ? 'Working…' : SCAN_LABELS[suggestedScan.scanType] ?? suggestedScan.label}
              </button>
            )
          ) : (
            <p className="page__subtitle">
              Nothing to do for this parcel right now.
            </p>
          )}

          <div className="row">
            <button type="button" className="button button--secondary" style={{ flex: 1 }} onClick={onOpen}>
              Open order
            </button>
            <button type="button" className="button button--ghost" style={{ flex: 1 }} onClick={onReset}>
              Scan another
            </button>
          </div>
        </div>

        {order.readyAt ? (
          <p className="field__hint" style={{ marginTop: 14 }}>
            Tracking started {formatDateTime(order.readyAt)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Best-effort geolocation, attached to the scan so a dispute about where a
 * parcel was dropped has an answer. Never blocks the scan: a driver in a
 * basement with no GPS lock still has to be able to complete the job.
 */
function currentPosition() {
  if (!navigator.geolocation) return Promise.resolve({});
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({}), 3000);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(timer);
        resolve({
          latitude: Number(position.coords.latitude.toFixed(6)),
          longitude: Number(position.coords.longitude.toFixed(6)),
        });
      },
      () => { clearTimeout(timer); resolve({}); },
      { timeout: 2500, maximumAge: 60_000 },
    );
  });
}
