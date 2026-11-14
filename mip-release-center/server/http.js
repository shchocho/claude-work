import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

export function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

/** 파일 내려받기 응답. 한글 파일명은 RFC 5987 형식으로 싣는다. */
export function sendDownload(res, buffer, fileName, mime = 'application/octet-stream', extraHeaders = {}) {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(buffer);
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      req.resume();
      reject(new HttpError(413, 'TOO_LARGE', tooLargeMessage(limit)));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'TOO_LARGE', tooLargeMessage(limit)));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tooLargeMessage(limit) {
  return `파일이 너무 큽니다. ${Math.floor(limit / 1024 / 1024)}MB 이하 파일만 처리할 수 있습니다.`;
}

/**
 * 메타데이터와 파일을 한 요청으로 받는 본문 형식.
 * [4바이트 big-endian 메타 길이][메타 JSON(UTF-8)][파일 바이트]
 */
export function parseFramed(buffer) {
  const bad = () => new HttpError(400, 'BAD_BODY', '요청 형식이 올바르지 않습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.');
  if (buffer.length < 4) throw bad();
  const metaLength = buffer.readUInt32BE(0);
  if (metaLength > 64 * 1024 || 4 + metaLength > buffer.length) throw bad();
  let meta;
  try {
    meta = JSON.parse(buffer.subarray(4, 4 + metaLength).toString('utf8'));
  } catch {
    throw bad();
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw bad();
  return { meta, file: buffer.subarray(4 + metaLength) };
}

export function parseJson(buffer) {
  if (!buffer.length) return {};
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    /* 아래에서 오류 처리 */
  }
  throw new HttpError(400, 'BAD_BODY', '요청 형식이 올바르지 않습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.');
}

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler, options = {}) => {
    const keys = [];
    const source = pattern.replace(/:([a-zA-Z]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler, options });
  };
  const match = (method, pathname) => {
    let pathMatched = false;
    for (const route of routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(m[i + 1]);
      });
      return { route, params };
    }
    return { pathMatched };
  };
  return { add, match };
}

export function serveStatic(webDir, pathname, res) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return false;
  }
  const file = path.normalize(path.join(webDir, rel));
  if (!file.startsWith(webDir + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const headers = {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  };
  if (rel === '/sw.js') headers['Service-Worker-Allowed'] = '/';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
  return true;
}
