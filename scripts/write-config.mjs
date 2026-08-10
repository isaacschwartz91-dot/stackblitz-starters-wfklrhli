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
import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

/** The commit being built, when the host did not say and git is available. */
function localCommit() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const pick = (...names) => {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
};

/**
 * Which build this is.
 *
 * Without it, "the change is not on the site" and "the change is on the site
 * and my browser is showing me yesterday's copy" look identical, and there is
 * no way to tell them apart from either end. Netlify names the commit it
 * built in COMMIT_REF; a local build asks git.
 */
const commit = pick('COMMIT_REF', 'GITHUB_SHA', 'VERCEL_GIT_COMMIT_SHA') || localCommit();
const config = {
  supabaseUrl: pick('SUPABASE_URL', 'VITE_SUPABASE_URL', 'NG_APP_SUPABASE_URL'),
  supabaseAnonKey: pick('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'NG_APP_SUPABASE_ANON_KEY'),
  storeName: pick('STORE_NAME', 'VITE_STORE_NAME'),
  commit: commit.slice(0, 7),
  branch: pick('BRANCH', 'HEAD', 'GITHUB_REF_NAME'),
  builtAt: new Date().toISOString(),
};

await mkdir('public', { recursive: true });
await writeFile('public/config.json', JSON.stringify(config, null, 2) + '\n');

const connected = config.supabaseUrl !== '' && config.supabaseAnonKey !== '';
console.log(
  connected
    ? `config.json written — Supabase: ${config.supabaseUrl}`
    : 'config.json written — no Supabase variables set, the app will use browser storage',
);
// Printed so the build log itself says which commit produced these files.
console.log(`build: commit ${config.commit || '(unknown)'} branch ${config.branch || '(unknown)'} at ${config.builtAt}`);
