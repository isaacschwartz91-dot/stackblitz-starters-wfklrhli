import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth.jsx';
import { ErrorNote, Field } from '../components.jsx';

/** Seeded accounts, shown only against a local API so nobody has to guess. */
const DEV_ACCOUNTS = [
  ['Admin', 'admin@example.com', 'admin12345'],
  ['Dispatcher', 'dispatch@example.com', 'dispatch12345'],
  ['Driver', 'driver1@example.com', 'driver12345'],
];

const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);

export default function LoginPage() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={location.state?.from?.pathname ?? '/'} replace />;

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const signedIn = await signIn(email, password);
      navigate(signedIn.role === 'driver' ? '/queue' : '/orders', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <div className="login__mark" aria-hidden="true">◧</div>
          <h1>Deliveries</h1>
          <p className="page__subtitle">Sign in to manage and deliver orders</p>
        </div>

        <div className="card">
          <div className="card__body">
            <ErrorNote error={error} onDismiss={() => setError(null)} />

            <form onSubmit={onSubmit}>
              <Field label="Email" required>
                <input
                  type="email"
                  value={email}
                  autoComplete="username"
                  autoFocus
                  required
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>

              <Field label="Password" required>
                <input
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  required
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>

              <button type="submit" className="button button--block button--lg" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            {isLocal ? (
              <div className="login__hints">
                <strong>Development accounts</strong>
                {DEV_ACCOUNTS.map(([role, accountEmail, accountPassword]) => (
                  <div className="login__hint-row" key={accountEmail}>
                    <span>{role}</span>
                    <button
                      type="button"
                      className="button button--ghost button--sm"
                      onClick={() => { setEmail(accountEmail); setPassword(accountPassword); }}
                    >
                      <code>{accountEmail}</code>
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
