import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { EmptyState, ErrorNote, Spinner, StatusBadge } from '../components.jsx';

/** A driver's working screen: what they are holding, in the order to do it. */
export default function DriverQueuePage() {
  const { user } = useAuth();
  const [queue, setQueue] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setQueue(await api.get('/api/queues/mine'));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!queue) return <div className="page-centre"><Spinner /></div>;

  const { counts, orders } = queue;

  return (
    <div className="page page--narrow">
      <div className="page__header">
        <div>
          <h1>My queue</h1>
          <p className="page__subtitle">{user.fullName}</p>
        </div>
        <Link to="/scan" className="button">📷 Scan</Link>
      </div>

      <div className="grid grid--3" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="stat__label">To collect</div>
          <div className="stat__value">{counts.assigned}</div>
        </div>
        <div className="stat">
          <div className="stat__label">On the van</div>
          <div className="stat__value">{counts.outForDelivery}</div>
        </div>
        <div className="stat">
          <div className="stat__label">Failed</div>
          <div className="stat__value">{counts.failed}</div>
        </div>
      </div>

      <div className="card">
        <div className="card__header"><h2>Parcels</h2></div>
        <div className="card__body card__body--flush">
          {orders.length === 0 ? (
            <EmptyState title="Nothing assigned" icon="✅">
              You are all caught up. New work will appear here once a dispatcher assigns it.
            </EmptyState>
          ) : (
            orders.map((order) => (
              <Link key={order.id} to={`/orders/${order.id}`} className="queue-card">
                {order.deliveryZone ? (
                  <span className="queue-card__zone">{order.deliveryZone}</span>
                ) : null}
                <div className="queue-card__main">
                  <div className="queue-card__ref">{order.orderRef}</div>
                  <div className="queue-card__address">
                    {order.customerName} · {order.addressLine1}
                    {order.city ? `, ${order.city}` : ''}
                  </div>
                  {order.deliveryNotes ? (
                    <div className="queue-card__address">📝 {order.deliveryNotes}</div>
                  ) : null}
                </div>
                <StatusBadge status={order.status} />
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
