/**
 * Test-runner module resolver.
 *
 * Node's built-in TypeScript support only resolves fully specified imports,
 * but Angular sources use extensionless relative imports. This hook fills the
 * gap for `node --test` so the application code can stay idiomatic Angular
 * and still be tested with zero test dependencies.
 *
 * Used only by `npm test` via --import; it never ships in a build.
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CANDIDATE_SUFFIXES = ['.ts', '/index.ts', '.tsx', '.js'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
    const hasExtension = /\.[cm]?[jt]sx?$/.test(specifier);

    if (isRelative && !hasExtension && context.parentURL) {
      const base = new URL(specifier, context.parentURL);
      for (const suffix of CANDIDATE_SUFFIXES) {
        const candidate = new URL(base.href + suffix);
        if (existsSync(fileURLToPath(candidate))) {
          // No explicit `format`: Node must classify it itself, otherwise
          // TypeScript files are handed to the plain JS parser unstripped.
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }

    return nextResolve(specifier, context);
  },
});

// Keep the import of pathToFileURL meaningful for older Node builds that
// resolve URL construction differently; harmless otherwise.
export { pathToFileURL };
