import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, query } from '../api.js';
import {
  EmptyState, ErrorNote, Field, Spinner, StatusBadge, Toast, formatRelative, useToast,
} from '../components.jsx';

/** Dispatcher's screen: what is waiting, and who to give it to. */
export default function DispatchPage() {
  const [toast, notify, dismissToast] = useToast();

  const [zones, setZones] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [error, setError] = useState(null);
  const [selectedZone, setSelectedZone] = useState(null);
  const [waiting, setWaiting] = useState([]);
  const [chosenDrivers, setChosenDrivers] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [queueData, driverData] = await Promise.all([
        api.get('/api/queues/dispatch'),
        api.get('/api/auth/drivers'),
      ]);
      setZones(queueData.zones);
      setDrivers(driverData.drivers);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openZone = useCallback(async (zone) => {
    setSelectedZone(zone);
    setChosenDrivers([]);
    const result = await api.get(`/api/orders${query({
      status: 'ready_for_delivery',
      driverId: 'unassigned',
      // 'UNZONED' is a display label for orders with no zone, not a real value.
      zone: zone.zone === 'UNZONED' ? '' : zone.zone,
      limit: 100,
    })}`);
    setWaiting(result.orders.filter((o) => (zone.zone === 'UNZONED' ? !o.deliveryZone : true)));
  }, []);

  async function autoBatch() {
    setBusy(true);
    try {
      const result = await api.post('/api/queues/auto-batch', {
        ...(selectedZone.zone === 'UNZONED' ? {} : { zone: selectedZone.zone }),
        driverIds: chosenDrivers,
      });
      notify(
        `${result.assignedCount} parcel${result.assignedCount === 1 ? '' : 's'} assigned` +
        (result.perDriver.length > 1
          ? ` (${result.perDriver.map((d) => `${d.driverName.split(' ')[0]}: ${d.count}`).join(', ')})`
          : ''),
      );
      setSelectedZone(null);
      await load();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function toggleDriver(id) {
    setChosenDrivers((current) =>
      current.includes(id) ? current.filter((d) => d !== id) : [...current, id]);
  }

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!zones) return <div className="page-centre"><Spinner /></div>;

  const totalWaiting = zones.reduce((sum, zone) => sum + zone.waiting, 0);

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1>Dispatch</h1>
          <p className="page__subtitle">
            {totalWaiting} parcel{totalWaiting === 1 ? '' : 's'} scanned and waiting for a driver
          </p>
        </div>
        <button type="button" className="button button--secondary" onClick={load}>Refresh</button>
      </div>

      <div className="grid grid--2">
        <section className="card">
          <div className="card__header"><h2>Waiting by zone</h2></div>
          <div className="card__body card__body--flush">
            {zones.length === 0 ? (
              <EmptyState title="Queue is clear" icon="🎉">
                Everything scanned has a driver.
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Zone</th><th className="numeric">Waiting</th><th>Oldest</th><th /></tr>
                  </thead>
                  <tbody>
                    {zones.map((zone) => (
                      <tr key={zone.zone}>
                        <td><strong>{zone.zone}</strong></td>
                        <td className="numeric">{zone.waiting}</td>
                        <td>{formatRelative(zone.oldestReadyAt)}</td>
                        <td className="numeric">
                          <button
                            type="button"
                            className="button button--sm"
                            onClick={() => openZone(zone)}
                          >
                            Assign
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card__header"><h2>Drivers</h2></div>
          <div className="card__body card__body--flush">
            {drivers.length === 0 ? (
              <EmptyState title="No active drivers" icon="🚚" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Driver</th>
                      <th className="numeric">Open</th>
                      <th className="numeric">On the van</th>
                      <th className="numeric">Done today</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drivers.map((driver) => (
                      <tr key={driver.id}>
                        <td>{driver.fullName}</td>
                        <td className="numeric">{driver.openOrders}</td>
                        <td className="numeric">{driver.outForDelivery}</td>
                        <td className="numeric">{driver.deliveredToday}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>

      {selectedZone ? (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSelectedZone(null)}>
          <div className="modal modal--wide" role="dialog" aria-modal="true">
            <header className="modal__header">
              <h2>Assign zone {selectedZone.zone}</h2>
              <button type="button" className="icon-button" onClick={() => setSelectedZone(null)}>×</button>
            </header>
            <div className="modal__body">
              <Field label="Deal these parcels to" hint="Choose more than one to split the round evenly">
                <div className="stack" style={{ gap: 6 }}>
                  {drivers.map((driver) => (
                    <label key={driver.id} className="row" style={{ gap: 8, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={chosenDrivers.includes(driver.id)}
                        onChange={() => toggleDriver(driver.id)}
                      />
                      <span>{driver.fullName}</span>
                      <span className="field__hint">{driver.openOrders} open</span>
                    </label>
                  ))}
                </div>
              </Field>

              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card__header">
                  <h3>{waiting.length} parcel{waiting.length === 1 ? '' : 's'} waiting</h3>
                </div>
                <div className="card__body card__body--flush table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
                  <table>
                    <thead><tr><th>Reference</th><th>Customer</th><th>Status</th></tr></thead>
                    <tbody>
                      {waiting.map((order) => (
                        <tr key={order.id}>
                          <td><Link to={`/orders/${order.id}`}>{order.orderRef}</Link></td>
                          <td>{order.customerName}</td>
                          <td><StatusBadge status={order.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="row row--end">
                <button type="button" className="button button--ghost" onClick={() => setSelectedZone(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy || chosenDrivers.length === 0}
                  onClick={autoBatch}
                >
                  {busy ? 'Assigning…' : `Assign ${waiting.length} to ${chosenDrivers.length || 'no'} driver${chosenDrivers.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
