import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ErrorNote, Spinner, Toast, useToast } from '../components.jsx';

/**
 * Admin settings.
 *
 * The toggles are rendered from the registry the API returns, so adding a
 * setting on the server makes it appear here with no change to this file.
 */
export default function SettingsPage() {
  const { isAdmin } = useAuth();
  const [toast, notify, dismissToast] = useToast();

  const [definitions, setDefinitions] = useState(null);
  const [environment, setEnvironment] = useState(null);
  const [error, setError] = useState(null);
  const [savingKey, setSavingKey] = useState(null);

  const load = useCallback(async () => {
    try {
      const [settings, env] = await Promise.all([
        api.get('/api/settings'),
        api.get('/api/settings/environment'),
      ]);
      setDefinitions(settings.definitions);
      setEnvironment(env);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggle(key, value) {
    setSavingKey(key);

    // Optimistic: a checkbox that waits for a round trip before moving feels broken.
    setDefinitions((current) =>
      current.map((d) => (d.key === key ? { ...d, value } : d)));

    try {
      const result = await api.patch('/api/settings', { [key]: value });
      setDefinitions((current) =>
        current.map((d) => (d.key in result.settings
          ? { ...d, value: result.settings[d.key], isDefault: result.settings[d.key] === d.default }
          : d)));
      notify(value ? 'Setting turned on' : 'Setting turned off');
    } catch (err) {
      setDefinitions((current) =>
        current.map((d) => (d.key === key ? { ...d, value: !value } : d)));
      notify(err.message, 'error');
    } finally {
      setSavingKey(null);
    }
  }

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!definitions) return <div className="page-centre"><Spinner /></div>;

  const groups = definitions.reduce((acc, definition) => {
    (acc[definition.group] ??= []).push(definition);
    return acc;
  }, {});

  return (
    <div className="page page--narrow">
      <div className="page__header">
        <div>
          <h1>Settings</h1>
          <p className="page__subtitle">
            {isAdmin
              ? 'Changes take effect immediately for every customer.'
              : 'Read-only — only an admin can change these.'}
          </p>
        </div>
      </div>

      <div className="stack">
        {Object.entries(groups).map(([group, items]) => (
          <section className="card" key={group}>
            <div className="card__header">
              <h2>{group}</h2>
            </div>

            {group === 'Public tracking page' ? (
              <div className="card__body" style={{ paddingBottom: 0 }}>
                <div className="note note--info" style={{ marginBottom: 0 }}>
                  The tracking link has no login — anyone holding it can see whatever
                  is turned on here, and customers forward these links. Everything is
                  off by default.
                </div>
              </div>
            ) : null}

            <div className="card__body card__body--flush">
              {items.map((definition) => (
                <div className="setting" key={definition.key}>
                  <div className="setting__text">
                    <div className="setting__label">
                      {definition.label}
                      {definition.isDefault ? null : (
                        <span className="badge badge--assigned" style={{ marginLeft: 8 }}>
                          Changed
                        </span>
                      )}
                    </div>
                    <p className="setting__description">{definition.description}</p>
                  </div>

                  <label className="switch" title={isAdmin ? undefined : 'Admins only'}>
                    <input
                      type="checkbox"
                      checked={definition.value}
                      disabled={!isAdmin || savingKey === definition.key}
                      onChange={(e) => toggle(definition.key, e.target.checked)}
                    />
                    <span className="switch__track" aria-hidden="true" />
                    <span className="visually-hidden">{definition.label}</span>
                  </label>
                </div>
              ))}
            </div>
          </section>
        ))}

        {environment ? (
          <section className="card">
            <div className="card__header">
              <h2>Deployment</h2>
              <span className="field__hint">Set in the server environment, not here</span>
            </div>
            <div className="card__body">
              <dl className="deflist">
                <dt>Driver self-assignment</dt>
                <dd>
                  {environment.environment.allowDriverSelfAssign ? 'Enabled' : 'Disabled'}
                  <div className="field__hint">
                    {environment.environment.allowDriverSelfAssign
                      ? 'Drivers can take an unassigned parcel by scanning it at pickup.'
                      : 'A dispatcher must assign every parcel before it can be collected.'}
                    {' '}Change with <code className="mono">ALLOW_DRIVER_SELF_ASSIGN</code>.
                  </div>
                </dd>

                <dt>Proof storage</dt>
                <dd>
                  {environment.environment.storageDriver}
                  <div className="field__hint">
                    Proof links expire after{' '}
                    {Math.round(environment.environment.proofUrlTtlSeconds / 86400)} days.
                  </div>
                </dd>

                <dt>SMS</dt>
                <dd>
                  {environment.notifications.sms.configured
                    ? `Twilio, from ${environment.notifications.sms.from}`
                    : 'Not configured'}
                  {environment.notifications.driver !== 'live' ? (
                    <div className="field__hint">
                      Mode is <code className="mono">{environment.notifications.driver}</code> —
                      messages are recorded, not sent.
                    </div>
                  ) : null}
                </dd>

                <dt>Email</dt>
                <dd>
                  {environment.notifications.email.configured
                    ? `SendGrid, from ${environment.notifications.email.from}`
                    : 'Not configured'}
                </dd>

                <dt>Tracking links</dt>
                <dd className="mono">{environment.environment.publicBaseUrl}/track/…</dd>
              </dl>
            </div>
          </section>
        ) : null}
      </div>

      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
