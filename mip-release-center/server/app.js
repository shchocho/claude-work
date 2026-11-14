import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createAuditLog } from './audit.js';
import { loadConfig } from './config.js';
import { createMailConnector } from './connectors/mail.js';
import { CHANNELS, LABELS, MEDIA_TYPES, RECIPIENT_TYPES, REVIEW_STATUSES } from './consts.js';
import { openDatabase } from './db.js';
import {
  HttpError, applySecurityHeaders, createRouter, parseFramed, parseJson, readBody, sendDownload, sendJson, serveStatic,
} from './http.js';
import { createMockAdapter } from './mip/mock-adapter.js';
import { createSidecarAdapter } from './mip/sidecar-adapter.js';
import { getSample, listSamples } from './samples.js';
import { createServices } from './services.js';

const COOKIE = 'mrc_session';

function loadSecret(dataDir) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(dataDir, 'session.secret');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

export function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const db = openDatabase(config.dataDir);
  const audit = createAuditLog(db);
  const mock = createMockAdapter({ tenantKey: config.mockTenantKey });
  const mip = overrides.mip ?? (config.mipAdapter === 'sidecar' ? createSidecarAdapter({ url: config.sidecarUrl }) : mock);
  const mail = createMailConnector({ dataDir: config.dataDir });
  const services = createServices({ db, config, mip, mail, audit });
  const secret = loadSecret(config.dataDir);

  // ── 세션 ─────────────────────────────────────────────
  // 데모용 계정 선택 로그인. 운영에서는 이 부분을 Entra ID SSO(OIDC)로 바꾼다.
  const sign = (userId) => crypto.createHmac('sha256', secret).update(userId).digest('base64url');

  function currentUser(req) {
    const raw = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
    if (!raw) return null;
    const [userId, mac] = decodeURIComponent(raw.slice(COOKIE.length + 1)).split('.');
    if (!userId || !mac) return null;
    const expected = sign(userId);
    if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) ?? null;
  }

  function sessionCookie(value, maxAge) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookie ? '; Secure' : ''}`;
  }

  // ── 라우트 ───────────────────────────────────────────
  const router = createRouter();
  const open = { public: true };
  const auditorOnly = { role: 'auditor' };
  const framed = async (ctx) => parseFramed(await readBody(ctx.req, config.maxFileBytes + 64 * 1024));
  const json = async (ctx) => parseJson(await readBody(ctx.req, 64 * 1024));

  router.add('GET', '/api/health', () => ({ ok: true, time: new Date().toISOString(), adapter: mip.name }), open);

  router.add('GET', '/api/meta', () => ({
    labels: LABELS, channels: CHANNELS, mediaTypes: MEDIA_TYPES, recipientTypes: RECIPIENT_TYPES, reviewStatuses: REVIEW_STATUSES,
    corpDomains: config.corpDomains, maxFileBytes: config.maxFileBytes, releaseTtlDays: config.releaseTtlDays, adapter: mip.name,
  }), open);

  router.add('GET', '/api/users', () => ({ users: db.prepare('SELECT id, name, dept, title, role FROM users ORDER BY role DESC, name').all() }), open);

  router.add('GET', '/api/session', (ctx) => ({ user: ctx.user ?? null }), open);

  router.add('POST', '/api/session', async (ctx) => {
    const { userId } = await json(ctx);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(String(userId ?? ''));
    if (!user) throw new HttpError(400, 'INVALID', '선택한 계정을 찾을 수 없습니다.');
    ctx.res.setHeader('Set-Cookie', sessionCookie(encodeURIComponent(`${user.id}.${sign(user.id)}`), 60 * 60 * 12));
    audit.record({ actor: user, action: 'session.login', detail: {} });
    return { user };
  }, open);

  router.add('DELETE', '/api/session', (ctx) => {
    ctx.res.setHeader('Set-Cookie', sessionCookie('', 0));
    return { ok: true };
  }, open);

  router.add('GET', '/api/samples', () => ({ samples: mip.name === 'mock' ? listSamples() : [] }));

  router.add('GET', '/api/samples/:id', (ctx) => {
    const sample = getSample(ctx.params.id);
    if (!sample) throw new HttpError(404, 'NOT_FOUND', '샘플 문서를 찾을 수 없습니다.');
    sendDownload(ctx.res, mock.protect(sample), `${sample.fileName}.pfile`);
  });

  router.add('POST', '/api/inspect', async (ctx) => {
    const { meta, file } = await framed(ctx);
    return services.inspectFile(ctx.user, { file, fileName: String(meta.fileName ?? '').slice(0, 255) || 'file' });
  });

  router.add('GET', '/api/releases', (ctx) => ({ releases: services.listReleases(ctx.user) }));

  router.add('POST', '/api/releases', async (ctx) => {
    const { meta, file } = await framed(ctx);
    ctx.status = 201;
    return { release: await services.createRelease(ctx.user, { meta, file }) };
  });

  router.add('GET', '/api/releases/:id/file', (ctx) => {
    const file = services.fetchReleaseFile(ctx.user, ctx.params.id);
    sendDownload(ctx.res, file.buffer, file.fileName, file.mime, { 'X-File-Sha256': file.sha256 });
  });

  router.add('POST', '/api/transfers', async (ctx) => {
    const { meta, file } = await framed(ctx);
    const result = await services.createTransfer(ctx.user, { meta, file });
    ctx.status = result.duplicate ? 200 : 201;
    return result;
  });

  router.add('GET', '/api/audit/stats', () => services.auditStats(), auditorOnly);
  router.add('GET', '/api/audit/transfers', (ctx) => ({ transfers: services.auditTransfers(ctx.query) }), auditorOnly);
  router.add('GET', '/api/audit/releases', (ctx) => ({ releases: services.auditReleases(ctx.query) }), auditorOnly);
  router.add('GET', '/api/audit/events', (ctx) => ({ events: services.auditEvents(ctx.query) }), auditorOnly);

  router.add('GET', '/api/audit/verify', (ctx) => {
    const result = audit.verify();
    audit.record({ actor: ctx.user, action: 'audit.verified', detail: { ok: result.ok, count: result.count } });
    return result;
  }, auditorOnly);

  router.add('GET', '/api/audit/transfers/:id/file', (ctx) => {
    const file = services.auditFile(ctx.user, 'transfer', ctx.params.id);
    sendDownload(ctx.res, file.buffer, file.fileName, file.mime);
  }, auditorOnly);

  router.add('GET', '/api/audit/releases/:id/file', (ctx) => {
    const file = services.auditFile(ctx.user, 'release', ctx.params.id);
    sendDownload(ctx.res, file.buffer, file.fileName, file.mime);
  }, auditorOnly);

  router.add('POST', '/api/audit/transfers/:id/review', async (ctx) => ({
    transfer: services.reviewTransfer(ctx.user, ctx.params.id, await json(ctx)),
  }), auditorOnly);

  router.add('GET', '/api/audit/export.csv', (ctx) => {
    const csv = services.exportTransfersCsv(ctx.user, ctx.query);
    sendDownload(ctx.res, csv, `송부이력_${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv; charset=utf-8');
  }, auditorOnly);

  // ── 요청 처리 ────────────────────────────────────────
  async function handle(req, res) {
    applySecurityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'METHOD', '허용되지 않는 요청입니다.');
      if (serveStatic(config.webDir, pathname, res)) return;
      throw new HttpError(404, 'NOT_FOUND', '페이지를 찾을 수 없습니다.');
    }

    const { route, params, pathMatched } = router.match(req.method, pathname);
    if (!route) {
      throw pathMatched
        ? new HttpError(405, 'METHOD', '허용되지 않는 요청입니다.')
        : new HttpError(404, 'NOT_FOUND', '요청한 기능을 찾을 수 없습니다.');
    }
    // 쿠키 인증이므로, 상태를 바꾸는 요청은 브라우저가 교차 출처에서 붙일 수 없는 전용 헤더를 요구한다.
    if (req.method !== 'GET' && req.headers['x-mrc-client'] !== '1') {
      throw new HttpError(403, 'CSRF', '허용되지 않는 요청입니다.');
    }
    const user = currentUser(req);
    if (!route.options.public && !user) throw new HttpError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    if (route.options.role && user?.role !== route.options.role) {
      throw new HttpError(403, 'FORBIDDEN', '감사 담당자만 볼 수 있는 화면입니다.');
    }

    const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), user, status: 200 };
    const result = await route.handler(ctx);
    if (!res.writableEnded && !res.headersSent) sendJson(res, ctx.status, result ?? { ok: true });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      const known = error instanceof HttpError;
      if (!known) console.error(error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, known ? error.status : 500, {
        error: {
          code: known ? error.code : 'INTERNAL',
          message: known ? error.message : '서버에서 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.',
        },
      });
    });
  });

  return {
    config, db, audit, services, mip, mock, server,
    close: () => new Promise((resolve) => {
      server.close(() => {
        db.close();
        resolve();
      });
      server.closeAllConnections?.();
    }),
  };
}
