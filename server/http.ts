/**
 * HTTP adapter.
 *
 * Translates node:http requests into the plain `ApiRequest` the router works
 * with, and serves the built Angular client. Keeping the transport this thin
 * is what lets the whole API be tested without a socket — and tested over a
 * real socket too, which AC-10 asks for.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

import { handle, type ApiContext, type ApiRequest } from './api';

const SESSION_COOKIE = 'scn_session';
const MAX_BODY_BYTES = 2 * 1024 * 1024; // catalog CSV uploads travel this way

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export interface ServerOptions {
  ctx: ApiContext;
  /** Directory holding the built Angular app. Omit to run API-only. */
  staticDir?: string | null;
  /** Set when the app is served over TLS, so the cookie gets `Secure`. */
  secureCookies?: boolean;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function clientIp(req: IncomingMessage): string {
  // Only trust a forwarding header when a reverse proxy is actually in front;
  // otherwise a client could spoof its way around the rate limiter.
  if (process.env['TRUST_PROXY'] === '1') {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (first) return first.split(',')[0]!.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Security headers applied to every response (NFR-8: no third-party code). */
function securityHeaders(secure: boolean): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    // No third-party origins at all: no analytics, no trackers, no CDN fonts.
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    ...(secure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

function serveStatic(
  staticDir: string,
  urlPath: string,
  res: ServerResponse,
  secure: boolean,
): boolean {
  const root = resolve(staticDir);
  // Normalize before joining so `../` cannot climb out of the static root.
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400, securityHeaders(secure)).end('Malformed path');
    return true;
  }
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(root, relative);

  const resolvedPath = resolve(filePath);
  const separator = process.platform === 'win32' ? '\\' : '/';
  if (resolvedPath !== root && !resolvedPath.startsWith(`${root}${separator}`)) {
    res.writeHead(403, securityHeaders(secure)).end('Forbidden');
    return true;
  }

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
  }
  // Single-page app: unknown paths fall back to index.html.
  if (!existsSync(filePath)) {
    const fallback = join(root, 'index.html');
    if (!existsSync(fallback)) return false;
    filePath = fallback;
  }

  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const immutable = /-[A-Z0-9]{8,}\./i.test(filePath);
  res.writeHead(200, {
    ...securityHeaders(secure),
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(filePath).pipe(res);
  return true;
}

export function createApiServer(options: ServerOptions) {
  const { ctx, staticDir = null, secureCookies = false } = options;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const headers = securityHeaders(secureCookies);

      if (!url.pathname.startsWith('/api/')) {
        if (staticDir && serveStatic(staticDir, url.pathname, res, secureCookies)) return;
        res.writeHead(404, { ...headers, 'content-type': 'text/plain' }).end('Not found');
        return;
      }

      let body: unknown = null;
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        let raw: string;
        try {
          raw = await readBody(req);
        } catch {
          res
            .writeHead(413, { ...headers, 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'That upload is too large.' }));
          return;
        }
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            res
              .writeHead(400, { ...headers, 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'Malformed request.' }));
            return;
          }
        }
      }

      const authHeader = req.headers['authorization'];
      const bearer =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7)
          : null;

      const apiRequest: ApiRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        body,
        token: bearer ?? readCookie(req.headers.cookie, SESSION_COOKIE),
        ip: clientIp(req),
      };

      const response = await handle(ctx, apiRequest);
      const outHeaders: Record<string, string | string[]> = {
        ...headers,
        'content-type': 'application/json; charset=utf-8',
        ...(response.headers ?? {}),
      };

      if (response.sessionToken !== undefined) {
        const base = `${SESSION_COOKIE}=${
          response.sessionToken ? encodeURIComponent(response.sessionToken) : ''
        }; Path=/; HttpOnly; SameSite=Strict`;
        outHeaders['set-cookie'] = response.sessionToken
          ? `${base}${secureCookies ? '; Secure' : ''}`
          : `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
      }

      const payload =
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? {});
      res.writeHead(response.status, outHeaders).end(payload);
    })().catch((error: unknown) => {
      console.error('[http] request failed', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Something went wrong.' }));
    });
  });

  // Bound slow clients as well as body size. These limits are especially
  // important because this is a single-process Node service.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export { SESSION_COOKIE };
