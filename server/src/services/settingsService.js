/**
 * Admin-editable application settings.
 *
 * Defaults live here, not in the database, so an empty `app_settings` table is a
 * valid state and a row only exists once an admin has actually changed
 * something. The registry is also the validation: an unknown key is rejected
 * rather than quietly stored.
 */
import { query } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';

/**
 * Every setting an admin can change.
 *
 * `group` and `label` are consumed by the admin screen, so adding a setting here
 * makes it appear in the UI without any frontend change.
 */
export const SETTINGS = Object.freeze({
  'publicTracking.showStreetAddress': {
    type: 'boolean',
    default: false,
    group: 'Public tracking page',
    label: 'Show the street address',
    description:
      'The full delivery address, including street. Anyone holding the tracking link can see it — those links get forwarded.',
  },
  'publicTracking.showCustomerPhone': {
    type: 'boolean',
    default: false,
    group: 'Public tracking page',
    label: 'Show the customer phone number',
    description: 'The phone number the delivery notifications are sent to.',
  },
  'publicTracking.showDeliveryNotes': {
    type: 'boolean',
    default: false,
    group: 'Public tracking page',
    label: 'Show the delivery notes',
    description:
      'Instructions staff recorded on the order, such as "key is under the mat". Often the most sensitive field on an order.',
  },
});

export const SETTING_KEYS = Object.keys(SETTINGS);

/** Defaults, as a plain object. */
export function defaultSettings() {
  return Object.fromEntries(
    Object.entries(SETTINGS).map(([key, definition]) => [key, definition.default]),
  );
}

function validate(key, value) {
  const definition = SETTINGS[key];
  if (!definition) {
    throw badRequest(`Unknown setting "${key}"`, { allowed: SETTING_KEYS });
  }
  if (definition.type === 'boolean' && typeof value !== 'boolean') {
    throw badRequest(`Setting "${key}" must be true or false`);
  }
  return value;
}

/**
 * Short-lived cache. The public tracking endpoint reads settings on every
 * request and they change perhaps twice a year; a few seconds of staleness
 * across instances is a fair trade for not querying every time. Writes clear
 * the cache in-process so an admin sees their own change immediately.
 */
const CACHE_TTL_MS = 15_000;
let cache = null;
let cachedAt = 0;

export function clearSettingsCache() {
  cache = null;
  cachedAt = 0;
}

export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;

  const { rows } = await query('SELECT key, value FROM app_settings');
  const stored = Object.fromEntries(
    // Ignore rows for keys that no longer exist in the registry, so removing a
    // setting from the code does not resurrect it as junk in the API response.
    rows.filter((row) => row.key in SETTINGS).map((row) => [row.key, row.value]),
  );

  cache = { ...defaultSettings(), ...stored };
  cachedAt = Date.now();
  return cache;
}

/** Applies a partial patch. Returns the full settings object. */
export async function updateSettings(patch, { actorId } = {}) {
  const entries = Object.entries(patch);
  if (entries.length === 0) throw badRequest('No settings to update');

  for (const [key, value] of entries) validate(key, value);

  for (const [key, value] of entries) {
    await query(
      `INSERT INTO app_settings (key, value, updated_by_id)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_by_id = EXCLUDED.updated_by_id,
             updated_at = clock_timestamp()`,
      [key, JSON.stringify(value), actorId ?? null],
    );
  }

  clearSettingsCache();
  return getSettings({ fresh: true });
}

/** Registry plus current values, for rendering the admin screen. */
export async function describeSettings() {
  const values = await getSettings({ fresh: true });
  return {
    settings: values,
    definitions: Object.entries(SETTINGS).map(([key, definition]) => ({
      key,
      value: values[key],
      isDefault: values[key] === definition.default,
      ...definition,
    })),
  };
}
