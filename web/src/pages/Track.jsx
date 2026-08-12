import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { api } from '../api.js';
import { EmptyState, Spinner, formatDateTime } from '../components.jsx';

const STEP_LABELS = {
  preparing: 'Preparing',
  dispatched: 'Dispatched',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
};

/**
 * The customer-facing page. No login, no navigation, no staff chrome — someone
 * arrives here from a text message, looks at one thing, and leaves.
 */
export default function TrackPage() {
  const { token } = useParams();
  const [tracking, setTracking] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.get(`/api/track/${encodeURIComponent(token)}`)
      .then((data) => !cancelled && setTracking(data.tracking))
      .catch((err) => !cancelled && setError(err));
    return () => { cancelled = true; };
  }, [token]);

  if (error) {
    return (
      <div className="track">
        <div className="track__inner">
          <EmptyState title="We could not find this delivery" icon="🔍">
            The link may have expired or been mistyped. Check the message we sent you.
          </EmptyState>
        </div>
      </div>
    );
  }

  if (!tracking) return <div className="page-centre"><Spinner label="Loading your delivery" /></div>;

  const reachedIndex = tracking.timeline.indexOf(tracking.status.code);
  const isFailed = tracking.status.code === 'attempted';

  return (
    <div className="track">
      <div className="track__inner">
        <header className="track__header">
          <div className="track__ref">Order {tracking.orderRef}</div>
          <h1 className="track__status">{tracking.status.label}</h1>
          <p className="track__description">{tracking.status.description}</p>
        </header>

        {isFailed ? (
          <div className="note note--warn">
            We attempted delivery {tracking.attemptCount} time
            {tracking.attemptCount === 1 ? '' : 's'} and will try again.
          </div>
        ) : (
          <div className="track__progress" role="img" aria-label={`Status: ${tracking.status.label}`}>
            {tracking.timeline.map((step, index) => (
              <div
                key={step}
                className={`track__step ${index <= reachedIndex ? 'track__step--done' : ''}`}
              >
                {STEP_LABELS[step]}
              </div>
            ))}
          </div>
        )}

        <div className="card" style={{ marginTop: 22 }}>
          <div className="card__body">
            <dl className="deflist">
              <dt>Delivering to</dt>
              <dd>
                {tracking.customerName}
                <br />
                {[tracking.destination.city, tracking.destination.region, tracking.destination.postalCode]
                  .filter(Boolean).join(' ')}
              </dd>
              {tracking.driverFirstName ? (
                <>
                  <dt>Your driver</dt>
                  <dd>{tracking.driverFirstName}</dd>
                </>
              ) : null}
              {tracking.dispatchedAt ? (
                <><dt>Dispatched</dt><dd>{formatDateTime(tracking.dispatchedAt)}</dd></>
              ) : null}
              {tracking.deliveredAt ? (
                <><dt>Delivered</dt><dd>{formatDateTime(tracking.deliveredAt)}</dd></>
              ) : null}
            </dl>
          </div>
        </div>

        {tracking.milestones.length > 0 ? (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card__header"><h2>Progress</h2></div>
            <div className="card__body">
              <ol className="timeline">
                {tracking.milestones.map((milestone, index) => (
                  <li key={`${milestone.code}-${index}`}>
                    <span className={`timeline__dot ${
                      milestone.code === 'delivered' ? 'timeline__dot--done'
                        : milestone.code === 'attempted' ? 'timeline__dot--fail'
                        : 'timeline__dot--current'
                    }`} />
                    <div className="timeline__body">
                      <div className="timeline__title">{milestone.label}</div>
                      <div className="timeline__meta">{formatDateTime(milestone.at)}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        ) : null}

        {tracking.proofOfDelivery ? (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card__header"><h2>Proof of delivery</h2></div>
            <div className="card__body stack">
              {tracking.proofOfDelivery.recipientName ? (
                <p>Received by <strong>{tracking.proofOfDelivery.recipientName}</strong></p>
              ) : null}
              {tracking.proofOfDelivery.photoUrl ? (
                <img className="track__photo" src={tracking.proofOfDelivery.photoUrl}
                  alt="Photo taken at delivery" />
              ) : null}
              {tracking.proofOfDelivery.signatureUrl ? (
                <img className="track__photo" src={tracking.proofOfDelivery.signatureUrl}
                  alt="Signature captured at delivery" />
              ) : null}
            </div>
          </div>
        ) : null}

        <p className="track__footer">
          Questions about this delivery? Reply to the message we sent you.
        </p>
      </div>
    </div>
  );
}
