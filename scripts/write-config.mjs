/**
 * Writes public/config.json from the environment before the app is built.
 *
 * Set these in the host's environment settings (Netlify: Site settings ->
 * Environment variables) and every device that opens the site is connected to
 * Supabase already, with nothing to type in:
 *
 *   SUPABASE_URL        or  VITE_SUPABASE_URL
 *   SUPABASE_ANON_KEY   or  VITE_SUPABASE_ANON_KEY
 *   STORE_NAME          (optional)
 *
 * The anon key is a public key — it is meant to travel to browsers, and the
 * database's row-level security is what actually protects the data. Never put
 * the service-role key here.
 */
import { mkdir, writeFile } from 'node:fs/promises';

const pick = (...names) => {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
};

const config = {
  supabaseUrl: pick('SUPABASE_URL', 'VITE_SUPABASE_URL', 'NG_APP_SUPABASE_URL'),
  supabaseAnonKey: pick('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'NG_APP_SUPABASE_ANON_KEY'),
  storeName: pick('STORE_NAME', 'VITE_STORE_NAME'),
};

await mkdir('public', { recursive: true });
await writeFile('public/config.json', JSON.stringify(config, null, 2) + '\n');

const connected = config.supabaseUrl !== '' && config.supabaseAnonKey !== '';
console.log(
  connected
    ? `config.json written — Supabase: ${config.supabaseUrl}`
    : 'config.json written — no Supabase variables set, the app will use browser storage',
);
