/**
 * Settings baked in at deploy time.
 *
 * Without this, every member of staff would have to paste the Supabase project
 * URL and key into the Settings screen on their own phone before the app was
 * any use to them. Instead the deploy writes a `config.json` next to the app,
 * and every device that loads the site is connected already.
 *
 * A choice made on the device still wins: whoever connects or disconnects
 * Supabase in Settings is overriding the deploy on purpose, and that sticks.
 */

export interface RuntimeConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  storeName: string;
  /** Short commit this build came from, written by the deploy. */
  commit: string;
  branch: string;
  builtAt: string;
}

let loaded: RuntimeConfig | null = null;

/** Read `config.json` once, at start-up. Absent or malformed is fine. */
export async function loadRuntimeConfig(): Promise<void> {
  try {
    const response = await fetch('config.json', { cache: 'no-store' });
    if (!response.ok) return;
    const parsed = (await response.json()) as Partial<RuntimeConfig>;
    loaded = {
      supabaseUrl: String(parsed.supabaseUrl ?? '').trim(),
      supabaseAnonKey: String(parsed.supabaseAnonKey ?? '').trim(),
      storeName: String(parsed.storeName ?? '').trim(),
      commit: String(parsed.commit ?? '').trim(),
      branch: String(parsed.branch ?? '').trim(),
      builtAt: String(parsed.builtAt ?? '').trim(),
    };
  } catch {
    // No config.json is the normal case for a plain static deploy.
    loaded = null;
  }
}

export function runtimeConfig(): RuntimeConfig | null {
  return loaded;
}

/** The deployed Supabase project, when the deploy named one. */
export function runtimeSupabase(): { url: string; anonKey: string } | null {
  if (loaded === null) return null;
  if (loaded.supabaseUrl === '' || loaded.supabaseAnonKey === '') return null;
  return { url: loaded.supabaseUrl.replace(/\/+$/, ''), anonKey: loaded.supabaseAnonKey };
}
