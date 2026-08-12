import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, openAuthenticatedPage } from '../api.js';
import { useAuth } from '../auth.jsx';
import {
  EmptyState, ErrorNote, Field, Modal, Spinner, StatusBadge, Toast,
  formatDateTime, formatDuration, useToast,
} from '../components.jsx';
import ProofCapture from './ProofCapture.jsx';

const STATUS_ACTIONS = {
  created: [{ status: 'ready_for_delivery', label: 'Mark ready for delivery' }],
  ready_for_delivery: [],
  assigned: [{ status: 'ready_for_delivery', label: 'Return to queue' }],
  out_for_delivery: [],
  failed_attempt: [],
  delivered: [],
  cancelled: [],
};

export default function OrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isStaff, isAdmin, user } = useAuth();
  const [toast, notify, dismissToast] = useToast();

  const [order, setOrder] = useState(null);
  const [scans, setScans] = useState([]);
  const [proof, setProof] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showProof, setShowProof] = useState(false);

  const load = useCallback(async () => {
    try {
      const [orderData, scanData, proofData] = await Promise.all([
        api.get(`/api/orders/${id}`),
        api.get(`/api/orders/${id}/scans`).catch(() => ({ scans: [] })),
        api.get(`/api/orders/${id}/proof`).catch(() => ({ proof: [] })),
      ]);
      setOrder(orderData.order);
      setScans(scanData.scans);
      setProof(proofData.proof);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!isStaff) return;
    api.get('/api/auth/drivers').then((data) => setDrivers(data.drivers)).catch(() => {});
  }, [isStaff]);

  async function run(action, successMessage) {
    setBusy(true);
    try {
      await action();
      await load();
      notify(successMessage);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="page-centre"><Spinner /></div>;
  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!order) return null;

  const canCapture =
    order.status === 'out_for_delivery' &&
    (isStaff || order.assignedDriverId === user.id);

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <Link to={isStaff ? '/orders' : '/queue'} className="field__hint">← Back</Link>
          <h1 style={{ marginTop: 6 }}>{order.orderRef}</h1>
          <div className="row" style={{ marginTop: 8 }}>
            <StatusBadge status={order.status} size="lg" />
            <span className="mono field__hint">{order.barcodeValue}</span>
          </div>
        </div>

        <div className="row">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => openAuthenticatedPage(`/api/orders/${order.id}/label`)
              .catch((err) => notify(err.message, 'error'))}
          >
            Print label
          </button>
          {canCapture ? (
            <button type="button" className="button button--ok" onClick={() => setShowProof(true)}>
              Complete delivery
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid grid--2">
        <div className="stack">
          <section className="card">
            <div className="card__header"><h2>Delivery</h2></div>
            <div className="card__body">
              <dl className="deflist">
                <dt>Customer</dt><dd>{order.customerName}</dd>
                <dt>Phone</dt><dd>{order.customerPhone ?? '—'}</dd>
                <dt>Email</dt><dd>{order.customerEmail ?? '—'}</dd>
                <dt>Address</dt>
                <dd>
                  {order.addressLine1}
                  {order.addressLine2 ? <><br />{order.addressLine2}</> : null}
                  <br />
                  {[order.city, order.region, order.postalCode].filter(Boolean).join(' ')}
                  {order.country ? <><br />{order.country}</> : null}
                </dd>
                <dt>Zone</dt><dd>{order.deliveryZone ?? '—'}</dd>
                {order.deliveryNotes ? (
                  <>
                    <dt>Notes</dt>
                    <dd>{order.deliveryNotes}</dd>
                  </>
                ) : null}
                <dt>Tracking</dt>
                <dd>
                  <a href={`/track/${order.trackingToken}`} target="_blank" rel="noreferrer">
                    Customer view ↗
                  </a>
                </dd>
              </dl>
            </div>
          </section>

          {isStaff ? (
            <section className="card">
              <div className="card__header"><h2>Assignment</h2></div>
              <div className="card__body">
                <dl className="deflist" style={{ marginBottom: 14 }}>
                  <dt>Driver</dt>
                  <dd>{order.assignedDriverName ?? <span className="field__hint">Unassigned</span>}</dd>
                  <dt>Assigned</dt><dd>{formatDateTime(order.assignedAt)}</dd>
                </dl>

                <AssignControl
                  order={order}
                  drivers={drivers}
                  busy={busy}
                  onAssign={(driverId) =>
                    run(
                      () => api.post(`/api/orders/${order.id}/assign`, { driverId }),
                      driverId ? 'Driver assigned' : 'Returned to the queue',
                    )}
                />
              </div>
            </section>
          ) : null}

          <section className="card">
            <div className="card__header"><h2>Timing</h2></div>
            <div className="card__body">
              <dl className="deflist">
                <dt>Created</dt><dd>{formatDateTime(order.createdAt)}</dd>
                <dt>Label scanned</dt><dd>{formatDateTime(order.readyAt)}</dd>
                <dt>Picked up</dt><dd>{formatDateTime(order.pickedUpAt)}</dd>
                <dt>Delivered</dt><dd>{formatDateTime(order.deliveredAt)}</dd>
                <dt>Attempts</dt><dd>{order.attemptCount}</dd>
                {order.readyAt && order.deliveredAt ? (
                  <>
                    <dt>Scan to delivery</dt>
                    <dd>
                      <strong>
                        {formatDuration(
                          (new Date(order.deliveredAt) - new Date(order.readyAt)) / 1000,
                        )}
                      </strong>
                    </dd>
                  </>
                ) : null}
              </dl>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <div className="card__header">
              <h2>History</h2>
              {isStaff && STATUS_ACTIONS[order.status]?.length > 0 ? (
                <div className="row">
                  {STATUS_ACTIONS[order.status].map((action) => (
                    <button
                      key={action.status}
                      type="button"
                      className="button button--secondary button--sm"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => api.patch(`/api/orders/${order.id}/status`, { status: action.status }),
                          action.label,
                        )}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="card__body">
              <ol className="timeline">
                {order.history.map((event) => (
                  <li key={event.id}>
                    <span className={`timeline__dot ${
                      event.toStatus === 'delivered' ? 'timeline__dot--done'
                        : event.toStatus === 'failed_attempt' ? 'timeline__dot--fail'
                        : event.toStatus === order.status ? 'timeline__dot--current' : ''
                    }`} />
                    <div className="timeline__body">
                      <div className="timeline__title">
                        <StatusBadge status={event.toStatus} />
                        {event.source === 'scan' ? <span className="field__hint"> · scanned</span> : null}
                      </div>
                      <div className="timeline__meta">
                        {formatDateTime(event.createdAt)}
                        {event.actorName ? ` · ${event.actorName}` : ''}
                      </div>
                      {event.notes ? <div className="timeline__meta">“{event.notes}”</div> : null}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          {proof.length > 0 ? (
            <section className="card">
              <div className="card__header"><h2>Proof of delivery</h2></div>
              <div className="card__body stack">
                {proof.map((record) => (
                  <div key={record.id}>
                    <div className="row row--between" style={{ marginBottom: 8 }}>
                      <strong>
                        Attempt {record.attemptNumber} ·{' '}
                        <StatusBadge status={record.outcome === 'delivered' ? 'delivered' : 'failed_attempt'} />
                      </strong>
                      <span className="field__hint">{formatDateTime(record.capturedAt)}</span>
                    </div>
                    <dl className="deflist">
                      {record.recipientName ? (<><dt>Received by</dt><dd>{record.recipientName}</dd></>) : null}
                      {record.failureReason ? (<><dt>Reason</dt><dd>{record.failureReason}</dd></>) : null}
                      {record.notes ? (<><dt>Notes</dt><dd>{record.notes}</dd></>) : null}
                      {record.capturedByName ? (<><dt>Captured by</dt><dd>{record.capturedByName}</dd></>) : null}
                    </dl>
                    <div className="grid grid--2" style={{ marginTop: 10 }}>
                      {record.photoUrl ? (
                        <a href={record.photoUrl} target="_blank" rel="noreferrer">
                          <img className="photo-preview" src={record.photoUrl} alt={`Delivery photo, attempt ${record.attemptNumber}`} />
                        </a>
                      ) : null}
                      {record.signatureUrl ? (
                        <a href={record.signatureUrl} target="_blank" rel="noreferrer">
                          <img className="photo-preview" src={record.signatureUrl} alt={`Signature, attempt ${record.attemptNumber}`} />
                        </a>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="card">
            <div className="card__header"><h2>Scans</h2></div>
            <div className="card__body card__body--flush">
              {scans.length === 0 ? (
                <EmptyState title="No scans yet" icon="📷">
                  The label has not been scanned.
                </EmptyState>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>When</th><th>Type</th><th>By</th><th>Result</th></tr>
                    </thead>
                    <tbody>
                      {scans.map((scan) => (
                        <tr key={scan.id}>
                          <td>{formatDateTime(scan.createdAt)}</td>
                          <td>{scan.scanType.replace(/_/g, ' ')}</td>
                          <td>{scan.scannedByName ?? '—'}</td>
                          <td>
                            {scan.accepted ? (
                              <span className="badge badge--delivered">Accepted</span>
                            ) : (
                              <span className="badge badge--failed_attempt" title={scan.rejectionReason}>
                                Rejected
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {isAdmin && order.status === 'created' ? (
            <button
              type="button"
              className="button button--ghost"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`Delete order ${order.orderRef}? This cannot be undone.`)) return;
                run(() => api.del(`/api/orders/${order.id}`), 'Order deleted')
                  .then(() => navigate('/orders'));
              }}
            >
              Delete order
            </button>
          ) : null}
        </div>
      </div>

      {showProof ? (
        <Modal title="Complete delivery" onClose={() => setShowProof(false)} wide>
          <ProofCapture
            order={order}
            onDone={() => {
              setShowProof(false);
              notify('Proof of delivery saved');
              load();
            }}
            onCancel={() => setShowProof(false)}
          />
        </Modal>
      ) : null}

      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  );
}

function AssignControl({ order, drivers, busy, onAssign }) {
  const [driverId, setDriverId] = useState('');
  const assignable = ['ready_for_delivery', 'assigned', 'failed_attempt'].includes(order.status);

  if (!assignable) {
    return (
      <p className="field__hint">
        {order.status === 'created'
          ? 'Scan the label before assigning this order.'
          : `An order that is ${order.status.replace(/_/g, ' ')} cannot be reassigned.`}
      </p>
    );
  }

  return (
    <div className="row">
      <select
        value={driverId}
        onChange={(e) => setDriverId(e.target.value)}
        style={{ flex: 1, minWidth: 180 }}
        aria-label="Driver"
      >
        <option value="">Choose a driver…</option>
        {drivers.map((driver) => (
          <option key={driver.id} value={driver.id}>
            {driver.fullName} ({driver.openOrders} open)
          </option>
        ))}
      </select>
      <button
        type="button"
        className="button"
        disabled={busy || !driverId}
        onClick={() => { onAssign(driverId); setDriverId(''); }}
      >
        Assign
      </button>
      {order.assignedDriverId ? (
        <button type="button" className="button button--ghost" disabled={busy} onClick={() => onAssign(null)}>
          Unassign
        </button>
      ) : null}
    </div>
  );
}
