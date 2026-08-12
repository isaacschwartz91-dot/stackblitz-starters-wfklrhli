/**
 * API client.
 *
 * One place that knows about the bearer token, the error envelope the server
 * sends, and how a 401 should end the session.
 */
const TOKEN_KEY = 'dts.token';
const USER_KEY = 'dts.user';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export function storeSession({ token, user }) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message ?? `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.error?.code;
    this.details = payload?.error?.details;
  }

  /** Flattens zod-style field errors for display under inputs. */
  get fieldErrors() {
    if (!Array.isArray(this.details)) return {};
    return Object.fromEntries(
      this.details.filter((d) => d.field).map((d) => [d.field, d.message]),
    );
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

async function request(method, path, { body, isForm = false, raw = false } = {}) {
  const token = getToken();

  const response = await fetch(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body && !isForm ? { 'content-type': 'application/json' } : {}),
    },
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401) {
    clearSession();
    onUnauthorized();
  }

  if (raw) return response;

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text();

  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, { body }),
  patch: (path, body) => request('PATCH', path, { body }),
  del: (path) => request('DELETE', path),
  postForm: (path, formData) => request('POST', path, { body: formData, isForm: true }),
  raw: (path) => request('GET', path, { raw: true }),
};

/** Triggers a browser download for an authenticated endpoint. */
export async function downloadFile(path, fallbackName) {
  const response = await api.raw(path);
  if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => null));

  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = match?.[1] ?? fallbackName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Opens an authenticated HTML endpoint (the printable label) in a new tab.
 *
 * A plain <a href> cannot carry the bearer token, so the document is fetched
 * with credentials and handed to the new tab as a blob. The label embeds its
 * barcode images as data URIs, so the blob is self-contained and prints.
 */
export async function openAuthenticatedPage(path) {
  // Opened synchronously: a window.open() after an await is blocked as a popup.
  const tab = window.open('', '_blank');

  try {
    const response = await api.raw(path);
    if (!response.ok) {
      throw new ApiError(response.status, await response.json().catch(() => null));
    }

    const blob = new Blob([await response.text()], { type: 'text/html' });
    const url = URL.createObjectURL(blob);

    if (tab) {
      tab.location.replace(url);
      // Revoking immediately would break the tab before it finishes loading.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  } catch (err) {
    tab?.close();
    throw err;
  }
}

export const query = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const string = search.toString();
  return string ? `?${string}` : '';
};
