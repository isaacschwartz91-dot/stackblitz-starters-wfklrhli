import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, downloadFile, query } from '../api.js';
import {
  EmptyState, ErrorNote, Field, Spinner, StatusBadge, Toast,
  formatDateTime, formatDuration, useToast,
} from '../components.jsx';

const isoDate = (date) => date.toISOString().slice(0, 10);

export default function ReportsPage() {
  const [toast, notify, dismissToast] = useToast();

  const [range, setRange] = useState(() => ({
    from: isoDate(new Date(Date.now() - 29 * 86_400_000)),
    to: isoDate(new Date()),
  }));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // `to` is a date, which parses as midnight — push it to the end of the day
      // so today's deliveries are inside the window.
      const params = { from: range.from, to: `${range.to}T23:59:59.999Z` };
      const [summary, drivers, failures, volume] = await Promise.all([
        api.get(`/api/reports/summary${query(params)}`),
        api.get(`/api/reports/drivers${query(params)}`),
        api.get(`/api/reports/failures${query(params)}`),
        api.get(`/api/reports/daily-volume${query(params)}`),
      ]);
      setData({ summary, drivers, failures, volume });
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  function exportCsv(report) {
    downloadFile(
      `/api/reports/export/${report}${query({ from: range.from, to: `${range.to}T23:59:59.999Z` })}`,
      `${report}.csv`,
    ).catch((err) => notify(err.message, 'error'));
  }

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1>Reports</h1>
          <p className="page__subtitle">Delivery performance and exceptions</p>
        </div>
        <div className="row">
          <Field label="From">
            <input type="date" value={range.from}
              onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </Field>
          <Field label="To">
            <input type="date" value={range.to}
              onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </Field>
        </div>
      </div>

      <ErrorNote error={error} onDismiss={() => setError(null)} />

      {loading && !data ? (
        <div className="page-centre"><Spinner /></div>
      ) : data ? (
        <div className="stack">
          <section className="grid grid--4">
            <Stat label="Delivered" value={data.summary.orders.delivered} />
            <Stat
              label="Median scan to delivery"
              value={formatDuration(data.summary.timing.medianSeconds)}
              hint={`p90 ${formatDuration(data.summary.timing.p90Seconds)}`}
            />
            <Stat label="In flight" value={data.summary.orders.inFlight}
              hint={`${data.summary.orders.awaitingAssignment} awaiting a driver`} />
            <Stat label="Open failures" value={data.summary.orders.failedOpen}
              hint={`${data.summary.orders.notYetScanned} not yet scanned`} />
          </section>

          <section className="card">
            <div className="card__header">
              <h2>Daily volume</h2>
              <div className="legend">
                <span><span className="legend__swatch" style={{ background: 'var(--ok)' }} />Delivered</span>
                <span><span className="legend__swatch" style={{ background: 'var(--danger)' }} />Failed</span>
              </div>
            </div>
            <div className="card__body">
              <VolumeChart days={data.volume.days} />
            </div>
          </section>

          <section className="card">
            <div className="card__header">
              <h2>Deliveries per driver</h2>
              <button type="button" className="button button--secondary button--sm"
                onClick={() => exportCsv('drivers')}>
                Export CSV
              </button>
            </div>
            <div className="card__body card__body--flush">
              {data.drivers.totals.length === 0 ? (
                <EmptyState title="No drivers yet" icon="🚚" />
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Driver</th>
                        <th className="numeric">Delivered</th>
                        <th className="numeric">Failed attempts</th>
                        <th className="numeric">Success rate</th>
                        <th className="numeric">Open now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.drivers.totals.map((driver) => (
                        <tr key={driver.driverId}>
                          <td>{driver.driverName}</td>
                          <td className="numeric">{driver.delivered}</td>
                          <td className="numeric">{driver.failedAttempts}</td>
                          <td className="numeric">
                            {driver.successRate === null
                              ? <span className="field__hint">—</span>
                              : `${Math.round(driver.successRate * 100)}%`}
                          </td>
                          <td className="numeric">{driver.openOrders}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card__header">
              <h2>Scan-to-delivery time</h2>
              <button type="button" className="button button--secondary button--sm"
                onClick={() => exportCsv('deliveries')}>
                Export deliveries CSV
              </button>
            </div>
            <div className="card__body">
              <div className="grid grid--4">
                <Stat label="Fastest" value={formatDuration(data.summary.timing.fastestSeconds)} />
                <Stat label="Median" value={formatDuration(data.summary.timing.medianSeconds)} />
                <Stat label="90th percentile" value={formatDuration(data.summary.timing.p90Seconds)} />
                <Stat label="Slowest" value={formatDuration(data.summary.timing.slowestSeconds)} />
              </div>
              <p className="field__hint" style={{ marginTop: 12 }}>
                Measured from the label-activation scan that starts tracking to the
                drop-off scan that completes it, across {data.summary.timing.deliveredCount}{' '}
                delivered order{data.summary.timing.deliveredCount === 1 ? '' : 's'}.
              </p>
            </div>
          </section>

          <section className="card">
            <div className="card__header">
              <h2>Failed and reattempted</h2>
              <button type="button" className="button button--secondary button--sm"
                onClick={() => exportCsv('failures')}>
                Export CSV
              </button>
            </div>
            <div className="card__body card__body--flush">
              <div className="card__body grid grid--3" style={{ paddingBottom: 0 }}>
                <Stat label="Orders with failures" value={data.failures.summary.ordersWithFailures} />
                <Stat label="Recovered" value={data.failures.summary.reattemptedAndDelivered}
                  hint="Failed then delivered" />
                <Stat label="Still open" value={data.failures.summary.stillOpen} />
              </div>

              {data.failures.orders.length === 0 ? (
                <EmptyState title="No failed attempts" icon="✅">
                  Every delivery in this window landed first time.
                </EmptyState>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Reference</th>
                        <th>Status</th>
                        <th>Zone</th>
                        <th>Driver</th>
                        <th className="numeric">Failures</th>
                        <th>Last reason</th>
                        <th>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.failures.orders.map((order) => (
                        <tr key={order.orderId}>
                          <td><Link to={`/orders/${order.orderId}`}>{order.orderRef}</Link></td>
                          <td><StatusBadge status={order.status} /></td>
                          <td>{order.deliveryZone ?? '—'}</td>
                          <td>{order.driverName ?? '—'}</td>
                          <td className="numeric">{order.failureCount}</td>
                          <td>{order.lastFailureReason ?? '—'}</td>
                          <td>{formatDateTime(order.lastFailedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  );
}

function Stat({ label, value, hint }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      {hint ? <div className="stat__hint">{hint}</div> : null}
    </div>
  );
}

/**
 * Deliberately a plain CSS chart rather than a charting library: two series over
 * at most a few dozen days does not justify the dependency.
 */
function VolumeChart({ days }) {
  if (!days?.length) return <EmptyState title="No data in this range" icon="📈" />;

  const peak = Math.max(1, ...days.map((day) => day.delivered + day.failed));
  // Label every nth day so the axis stays readable on a narrow screen.
  const step = Math.ceil(days.length / 12);

  return (
    <div className="bars" role="img"
      aria-label={`Daily volume: ${days.reduce((sum, d) => sum + d.delivered, 0)} delivered, ${days.reduce((sum, d) => sum + d.failed, 0)} failed`}>
      {days.map((day, index) => (
        <div className="bars__col" key={day.day}>
          <div
            className="bars__stack"
            title={`${new Date(day.day).toLocaleDateString()}: ${day.delivered} delivered, ${day.failed} failed`}
          >
            {day.failed > 0 ? (
              <div className="bars__bar bars__bar--failed"
                style={{ height: `${(day.failed / peak) * 100}%` }} />
            ) : null}
            {day.delivered > 0 ? (
              <div className="bars__bar bars__bar--delivered"
                style={{ height: `${(day.delivered / peak) * 100}%` }} />
            ) : null}
          </div>
          <div className="bars__label">
            {index % step === 0 ? new Date(day.day).getDate() : ' '}
          </div>
        </div>
      ))}
    </div>
  );
}
