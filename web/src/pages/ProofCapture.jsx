import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { api } from '../api.js';
import { ErrorNote, Field } from '../components.jsx';

/**
 * Drop-off capture: outcome, photo, signature, notes.
 *
 * The photo input uses `capture="environment"`, which opens the rear camera
 * directly on a phone and falls back to a normal file picker on desktop.
 */
export default function ProofCapture({ order, onDone, onCancel }) {
  const [outcome, setOutcome] = useState('delivered');
  const [recipientName, setRecipientName] = useState('');
  const [failureReason, setFailureReason] = useState('');
  const [notes, setNotes] = useState('');
  const [photo, setPhoto] = useState(null);
  const [photoUrl, setPhotoUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const signatureRef = useRef(null);

  // Object URLs leak if they are not revoked when the photo changes.
  useEffect(() => {
    if (!photo) return undefined;
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const form = new FormData();
      form.set('outcome', outcome);
      if (recipientName.trim()) form.set('recipientName', recipientName.trim());
      if (notes.trim()) form.set('notes', notes.trim());
      if (outcome === 'failed' && failureReason.trim()) form.set('failureReason', failureReason.trim());
      if (photo) form.set('photo', photo, photo.name || 'photo.jpg');

      const signature = signatureRef.current?.toDataUrl();
      if (signature) form.set('signatureDataUrl', signature);

      await api.postForm(`/api/orders/${order.id}/proof`, form);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <ErrorNote error={error} onDismiss={() => setError(null)} />

      <div className="row" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className={`button ${outcome === 'delivered' ? 'button--ok' : 'button--secondary'}`}
          onClick={() => setOutcome('delivered')}
          aria-pressed={outcome === 'delivered'}
        >
          Delivered
        </button>
        <button
          type="button"
          className={`button ${outcome === 'failed' ? 'button--danger' : 'button--secondary'}`}
          onClick={() => setOutcome('failed')}
          aria-pressed={outcome === 'failed'}
        >
          Failed attempt
        </button>
      </div>

      {outcome === 'delivered' ? (
        <Field label="Received by" hint="Name of whoever took the parcel">
          <input
            type="text"
            value={recipientName}
            onChange={(e) => setRecipientName(e.target.value)}
            placeholder={order.customerName}
          />
        </Field>
      ) : (
        <Field label="Why did it fail?" required>
          <select value={failureReason} onChange={(e) => setFailureReason(e.target.value)} required>
            <option value="">Choose a reason…</option>
            <option>Nobody home</option>
            <option>Address not found</option>
            <option>Access refused</option>
            <option>No safe place to leave it</option>
            <option>Customer rescheduled</option>
            <option>Parcel damaged</option>
          </select>
        </Field>
      )}

      <Field label="Photo" hint="Opens the camera on a phone">
        <input
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
        />
      </Field>

      {photoUrl ? (
        <div style={{ marginBottom: 14 }}>
          <img className="photo-preview" src={photoUrl} alt="Delivery photo preview" />
          <button
            type="button"
            className="button button--ghost button--sm"
            style={{ marginTop: 8 }}
            onClick={() => setPhoto(null)}
          >
            Remove photo
          </button>
        </div>
      ) : null}

      <SignaturePad ref={signatureRef} />

      <Field label="Notes">
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything worth recording" />
      </Field>

      <div className="row row--end">
        <button type="button" className="button button--ghost" onClick={onCancel}>Cancel</button>
        <button
          type="submit"
          className={`button ${outcome === 'delivered' ? 'button--ok' : 'button--danger'}`}
          disabled={busy || (outcome === 'failed' && !failureReason)}
        >
          {busy ? 'Saving…' : outcome === 'delivered' ? 'Confirm delivery' : 'Record failed attempt'}
        </button>
      </div>
    </form>
  );
}

/**
 * Signature capture on a canvas. Pointer events cover mouse, touch and stylus in
 * one code path, and the canvas is sized to its backing store so lines are crisp
 * on high-DPI phone screens.
 */
const SignaturePad = forwardRef(function SignaturePad(_props, ref) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const scale = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    canvas.width = rect.width * scale;
    canvas.height = rect.height * scale;

    const context = canvas.getContext('2d');
    context.scale(scale, scale);
    context.lineWidth = 2.2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    // Read the ink colour from the theme so it stays visible in dark mode.
    context.strokeStyle = getComputedStyle(canvas).color;
  }, []);

  useImperativeHandle(ref, () => ({
    // Null when untouched, so an unsigned delivery does not upload a blank image.
    toDataUrl: () => (hasInk ? canvasRef.current.toDataURL('image/png') : null),
    clear: () => clearPad(),
  }), [hasInk]);

  function positionOf(event) {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function start(event) {
    event.preventDefault();
    canvasRef.current.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    const { x, y } = positionOf(event);
    const context = canvasRef.current.getContext('2d');
    context.beginPath();
    context.moveTo(x, y);
    setHasInk(true);
  }

  function move(event) {
    if (!drawingRef.current) return;
    event.preventDefault();
    const { x, y } = positionOf(event);
    const context = canvasRef.current.getContext('2d');
    context.lineTo(x, y);
    context.stroke();
  }

  function end() {
    drawingRef.current = false;
  }

  function clearPad() {
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  }

  return (
    <div className="field">
      <span className="field__label">Signature</span>
      <canvas
        ref={canvasRef}
        className="signature-pad"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
        aria-label="Signature pad — sign here"
      />
      <div className="row row--between" style={{ marginTop: 6 }}>
        <span className="field__hint">
          {hasInk ? 'Signature captured' : 'Ask the recipient to sign above'}
        </span>
        <button type="button" className="button button--ghost button--sm" onClick={clearPad} disabled={!hasInk}>
          Clear
        </button>
      </div>
    </div>
  );
});
