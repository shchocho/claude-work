// Minimal HTTP plumbing: route table, JSON bodies, error envelope, static files
// and the security headers every response carries.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const fail = {
  badRequest: (code = 'bad_request', message, details) => new HttpError(400, code, message, details),
  unauthorized: (code = 'unauthenticated', message) => new HttpError(401, code, message),
  forbidden: (code = 'forbidden', message, details) => new HttpError(403, code, message, details),
  notFound: (code = 'not_found', message) => new HttpError(404, code, message),
  conflict: (code = 'conflict', message, details) => new HttpError(409, code, message, details),
  invalid: (details, message = 'Validation failed') => new HttpError(422, 'validation_failed', message, details),
  unprocessable: (code, message, details) => new HttpError(422, code, message, details),
  tooMany: (retryAfterSeconds, code = 'too_many_attempts') =>
    new HttpError(429, code, 'Too many attempts', { retryAfterSeconds }),
};

const MAX_BODY_BYTES = 1024 * 1024;

export function createRouter() {
  const routes = [];

  function add(method, pattern, options, handler) {
    if (typeof options === 'function') {
      handler = options;
      options = {};
    }
    const keys = [];
    const source = pattern
      .split('/')
      .map((part) => {
        if (part.startsWith(':')) {
          keys.push(part.slice(1));
          return '([^/]+)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    routes.push({ method, pattern, regex: new RegExp(`^${source}$`), keys, options, handler });
  }

  function match(method, pathname) {
    const allowed = [];
    for (const route of routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      if (route.method !== method) {
        allowed.push(route.method);
        continue;
      }
      const params = {};
      let ok = true;
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1]);
        } catch {
          ok = false;
        }
      });
      if (!ok) continue;
      return { route, params };
    }
    return allowed.length ? { allowed } : null;
  }

  return {
    get: (p, o, h) => add('GET', p, o, h),
    post: (p, o, h) => add('POST', p, o, h),
    put: (p, o, h) => add('PUT', p, o, h),
    delete: (p, o, h) => add('DELETE', p, o, h),
    match,
    routes,
  };
}

export async function readBody(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, 'payload_too_large', 'Request body is too large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function parseJsonBody(req, raw) {
  if (!raw.length) return {};
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', 'Send application/json');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw fail.badRequest('invalid_json', 'Request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail.badRequest('invalid_json', 'Request body must be a JSON object');
  }
  return parsed;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // ignore a malformed cookie value
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure, path: cookiePath = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${cookiePath}`, 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function normalizeIp(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** Client address; forwarded headers are believed only when they come from a listed proxy. */
export function clientIp(req, config) {
  const remote = normalizeIp(req.socket?.remoteAddress);
  if (!config.trustProxy || !config.trustedProxies.includes(remote)) return remote;
  const chain = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => normalizeIp(s.trim()))
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (!config.trustedProxies.includes(chain[i])) return chain[i];
  }
  return remote;
}

export function fromTrustedProxy(req, config) {
  return config.trustProxy && config.trustedProxies.includes(normalizeIp(req.socket?.remoteAddress));
}

export function isSecureRequest(req, config) {
  if (req.socket?.encrypted) return true;
  return fromTrustedProxy(req, config) && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(req, config) {
  const headers = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (isSecureRequest(req, config)) headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}

export function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
}

export function sendDownload(res, { body, contentType, filename }) {
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Content-Disposition': `attachment; filename="${safeName}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Serve a file from publicDir. Returns false when nothing matched. */
export function serveStatic(req, res, publicDir, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (rel.includes('\0')) return false;
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(publicDir, '.' + path.posix.normalize('/' + rel));
  if (file !== publicDir && !file.startsWith(publicDir + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const etag = `"${crypto.createHash('sha1').update(`${stat.size}-${stat.mtimeMs}`).digest('base64url')}"`;
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return true;
}
