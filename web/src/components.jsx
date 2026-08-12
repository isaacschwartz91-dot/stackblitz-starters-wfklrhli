/** Small shared building blocks used across the screens. */
import { useEffect, useState } from 'react';

export const STATUS_LABELS = {
  created: 'Created',
  ready_for_delivery: 'Ready',
  assigned: 'Assigned',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  failed_attempt: 'Failed attempt',
  cancelled: 'Cancelled',
};

export function StatusBadge({ status, size }) {
  return (
    <span className={`badge badge--${status} ${size === 'lg' ? 'badge--lg' : ''}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function Spinner({ label = 'Loading' }) {
  return (
    <div className="spinner" role="status" aria-live="polite">
      <span className="spinner__dot" />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}

export function EmptyState({ title, children, icon = '📦' }) {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function ErrorNote({ error, onDismiss }) {
  if (!error) return null;
  return (
    <div className="note note--error" role="alert">
      <div>
        <strong>{error.message}</strong>
        {Array.isArray(error.details) && error.details.length > 0 ? (
          <ul className="note__list">
            {error.details.slice(0, 6).map((detail, index) => (
              <li key={index}>{detail.field ? `${detail.field}: ` : ''}{detail.message}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {onDismiss ? (
        <button type="button" className="note__close" onClick={onDismiss} aria-label="Dismiss">×</button>
      ) : null}
    </div>
  );
}

export function Toast({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;
  return (
    <div className={`toast toast--${toast.tone ?? 'ok'}`} role="status">
      {toast.message}
    </div>
  );
}

/** Toast state, returned as [toast, notify, dismiss]. */
export function useToast() {
  const [toast, setToast] = useState(null);
  return [toast, (message, tone = 'ok') => setToast({ message, tone }), () => setToast(null)];
}

export function Field({ label, error, children, hint, required }) {
  return (
    <label className="field">
      <span className="field__label">
        {label}
        {required ? <span className="field__required" aria-hidden="true"> *</span> : null}
      </span>
      {children}
      {hint && !error ? <span className="field__hint">{hint}</span> : null}
      {error ? <span className="field__error">{error}</span> : null}
    </label>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}

/** "2h 14m" — durations are read at a glance, never in raw seconds. */
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

export function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "3 minutes ago" for the activity feeds. */
export function formatRelative(value) {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
