import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ApiError, api, downloadFile, query } from '../api.js';
import {
  EmptyState, ErrorNote, Field, Modal, Spinner, StatusBadge, Toast,
  formatRelative, useToast,
} from '../components.jsx';

const STATUS_OPTIONS = [
  ['', 'All statuses'],
  ['created', 'Created'],
  ['ready_for_delivery', 'Ready'],
  ['assigned', 'Assigned'],
  ['out_for_delivery', 'Out for delivery'],
  ['delivered', 'Delivered'],
  ['failed_attempt', 'Failed attempt'],
  ['cancelled', 'Cancelled'],
];

const PAGE_SIZE = 25;

export default function OrdersPage() {
  const navigate = useNavigate();
  const [toast, notify, dismissToast] = useToast();

  const [filters, setFilters] = useState({ status: '', zone: '', q: '' });
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get(
        `/api/orders${query({ ...filters, limit: PAGE_SIZE, offset })}`,
      );
      setData(result);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [filters, offset]);

  // Debounced so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(load, filters.q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, filters.q]);

  function updateFilter(key, value) {
    setOffset(0);
    setFilters((current) => ({ ...current, [key]: value }));
  }

  const total = data?.pagination.total ?? 0;

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1>Orders</h1>
          <p className="page__subtitle">
            {loading && !data ? 'Loading…' : `${total} order${total === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="row">
          <button type="button" className="button button--secondary" onClick={() => setShowImport(true)}>
            Import CSV
          </button>
          <button type="button" className="button" onClick={() => setShowCreate(true)}>
            New order
          </button>
        </div>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card__body">
          <div className="filters">
            <Field label="Search">
              <input
                type="search"
                placeholder="Reference, name, barcode…"
                value={filters.q}
                onChange={(e) => updateFilter('q', e.target.value)}
              />
            </Field>
            <Field label="Status">
              <select value={filters.status} onChange={(e) => updateFilter('status', e.target.value)}>
                {STATUS_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </Field>
            <Field label="Zone">
              <input
                type="text"
                placeholder="e.g. NORTH"
                value={filters.zone}
                onChange={(e) => updateFilter('zone', e.target.value)}
              />
            </Field>
            <div className="field">
              <span className="field__label">&nbsp;</span>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => downloadFile('/api/reports/export/deliveries', 'deliveries.csv')
                  .catch((err) => notify(err.message, 'error'))}
              >
                Export CSV
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        {loading && !data ? (
          <div className="page-centre"><Spinner /></div>
        ) : data?.orders.length === 0 ? (
          <EmptyState title="No orders match">
            Adjust the filters, or create the first order.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Customer</th>
                  <th>Zone</th>
                  <th>Status</th>
                  <th>Driver</th>
                  <th>Barcode</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {data?.orders.map((order) => (
                  <tr
                    key={order.id}
                    className="clickable"
                    onClick={() => navigate(`/orders/${order.id}`)}
                  >
                    <td>
                      <Link to={`/orders/${order.id}`} onClick={(e) => e.stopPropagation()}>
                        {order.orderRef}
                      </Link>
                    </td>
                    <td>
                      {order.customerName}
                      <div className="field__hint">{order.city ?? '—'}</div>
                    </td>
                    <td>{order.deliveryZone ?? '—'}</td>
                    <td><StatusBadge status={order.status} /></td>
                    <td>{order.assignedDriverName ?? <span className="field__hint">Unassigned</span>}</td>
                    <td className="mono">{order.barcodeValue}</td>
                    <td>{formatRelative(order.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > PAGE_SIZE ? (
          <div className="card__header" style={{ borderTop: '1px solid var(--border)', borderBottom: 0 }}>
            <span className="field__hint">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </span>
            <div className="row">
              <button
                type="button"
                className="button button--secondary button--sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </button>
              <button
                type="button"
                className="button button--secondary button--sm"
                disabled={!data?.pagination.hasMore}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {showCreate ? (
        <CreateOrderModal
          onClose={() => setShowCreate(false)}
          onCreated={(order) => {
            setShowCreate(false);
            notify(`Order ${order.orderRef} created`);
            load();
          }}
        />
      ) : null}

      {showImport ? (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={(result) => {
            notify(`${result.createdCount} order${result.createdCount === 1 ? '' : 's'} imported`);
            load();
          }}
        />
      ) : null}

      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  );
}

const EMPTY_ORDER = {
  orderRef: '', customerName: '', customerPhone: '', customerEmail: '',
  addressLine1: '', addressLine2: '', city: '', region: '', postalCode: '',
  country: '', deliveryZone: '', deliveryNotes: '',
};

function CreateOrderModal({ onClose, onCreated }) {
  const [form, setForm] = useState(EMPTY_ORDER);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const fieldErrors = error instanceof ApiError ? error.fieldErrors : {};

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Blank optional inputs are omitted; the API rejects unknown/empty fields.
      const payload = Object.fromEntries(
        Object.entries(form).filter(([, value]) => value.trim() !== ''),
      );
      const { order } = await api.post('/api/orders', payload);
      onCreated(order);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New order" onClose={onClose} wide>
      <ErrorNote error={error} onDismiss={() => setError(null)} />

      <form onSubmit={submit}>
        <div className="grid grid--2">
          <Field label="Order reference" required error={fieldErrors.orderRef}
            hint="From your order system — printed on the label">
            <input type="text" value={form.orderRef} onChange={set('orderRef')} required autoFocus />
          </Field>
          <Field label="Delivery zone" hint="Used to batch orders to drivers">
            <input type="text" value={form.deliveryZone} onChange={set('deliveryZone')} placeholder="NORTH" />
          </Field>
        </div>

        <Field label="Customer name" required error={fieldErrors.customerName}>
          <input type="text" value={form.customerName} onChange={set('customerName')} required />
        </Field>

        <div className="grid grid--2">
          <Field label="Phone" required error={fieldErrors.customerPhone}
            hint="Every order needs one — delivery updates are sent by SMS">
            <input
              type="tel"
              value={form.customerPhone}
              onChange={set('customerPhone')}
              placeholder="+15551234567"
              required
            />
          </Field>
          <Field label="Email" error={fieldErrors.customerEmail} hint="Optional">
            <input type="email" value={form.customerEmail} onChange={set('customerEmail')} />
          </Field>
        </div>

        <Field label="Address line 1" required error={fieldErrors.addressLine1}>
          <input type="text" value={form.addressLine1} onChange={set('addressLine1')} required />
        </Field>
        <Field label="Address line 2">
          <input type="text" value={form.addressLine2} onChange={set('addressLine2')} />
        </Field>

        <div className="grid grid--3">
          <Field label="City"><input type="text" value={form.city} onChange={set('city')} /></Field>
          <Field label="Region"><input type="text" value={form.region} onChange={set('region')} /></Field>
          <Field label="Postal code"><input type="text" value={form.postalCode} onChange={set('postalCode')} /></Field>
        </div>

        <Field label="Delivery notes">
          <textarea value={form.deliveryNotes} onChange={set('deliveryNotes')}
            placeholder="Leave with the doorman" />
        </Field>

        <div className="row row--end">
          <button type="button" className="button button--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="button" disabled={busy}>
            {busy ? 'Creating…' : 'Create order'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ImportModal({ onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('file', file);
      const response = await api.postForm('/api/orders/import', form);
      setResult(response);
      onImported(response);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Import orders from CSV" onClose={onClose} wide>
      <ErrorNote error={error} onDismiss={() => setError(null)} />

      {result ? (
        <div className="stack">
          <div className={`note note--${result.failedCount > 0 ? 'warn' : 'ok'}`}>
            <div>
              <strong>{result.createdCount} order{result.createdCount === 1 ? '' : 's'} created</strong>
              {result.failedCount > 0 ? <> · {result.failedCount} row{result.failedCount === 1 ? '' : 's'} skipped</> : null}
            </div>
          </div>

          {result.errors?.length > 0 ? (
            <div className="table-wrap" style={{ maxHeight: 280, overflowY: 'auto' }}>
              <table>
                <thead><tr><th>Row</th><th>Field</th><th>Problem</th></tr></thead>
                <tbody>
                  {result.errors.map((rowError, index) => (
                    <tr key={index}>
                      <td className="numeric">{rowError.rowNumber}</td>
                      <td>{rowError.field ?? '—'}</td>
                      <td>{rowError.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="row row--end">
            <button type="button" className="button" onClick={onClose}>Done</button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          <p className="page__subtitle" style={{ marginBottom: 14 }}>
            Required columns: <code className="mono">order_ref</code>,{' '}
            <code className="mono">customer_name</code>, <code className="mono">phone</code> and{' '}
            <code className="mono">address_line1</code>. Email is optional. Common header
            spellings are recognised automatically.
          </p>

          <Field label="CSV file" required>
            <input
              type="file"
              accept=".csv,text/csv"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>

          <div className="row row--between">
            <button
              type="button"
              className="button button--ghost button--sm"
              onClick={() => downloadFile('/api/orders/import/template', 'order-import-template.csv')}
            >
              Download template
            </button>
            <div className="row">
              <button type="button" className="button button--ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="button" disabled={busy || !file}>
                {busy ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
