// Calls to the server. Carries the CSRF token and turns error envelopes into ApiError.
let csrfToken = null;
const handlers = {};

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Listen for 'unauthenticated' and 'password_change_required'. */
export function onApiEvent(name, fn) {
  handlers[name] = fn;
}

export function qs(params) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') out.set(key, value);
  }
  const text = out.toString();
  return text ? '?' + text : '';
}

async function request(method, path, body) {
  const init = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (method !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    if (csrfToken) init.headers['X-CSRF-Token'] = csrfToken;
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network_error', 'Network error');
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    // an empty or non-JSON body is handled below
  }
  if (json?.csrfToken) csrfToken = json.csrfToken;
  if (res.ok) return json;
  const error = json?.error ?? {};
  const err = new ApiError(res.status, error.code ?? 'http_' + res.status, error.message, error.details);
  if (res.status === 401 && err.code === 'unauthenticated') handlers.unauthenticated?.();
  if (err.code === 'password_change_required') handlers.password_change_required?.();
  throw err;
}

export const api = {
  get: (path, params) => request('GET', path + qs(params)),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
};
