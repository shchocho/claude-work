// Wires the services together and maps HTTP routes onto them.
import {
  HttpError, fail, createRouter, readBody, parseJsonBody, clientIp, securityHeaders,
  sendJson, sendDownload, serveStatic, fromTrustedProxy,
} from './http.js';
import { createAudit } from './audit.js';
import { createUsers } from './users.js';
import { createAuth } from './auth.js';
import { createPolicyService } from './policy.js';
import { createOutbox } from './outbox.js';
import { createNotifier } from './notify.js';
import { createRequests } from './requests.js';
import { createExecutions } from './executions.js';
import { createApprovals } from './approvals.js';
import { createReports } from './reports.js';
import { createSweeper } from './sweeper.js';
import { can, ROLES, TOKEN_SCOPES } from './rbac.js';
import { safeEqual, toCsv } from './util.js';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from './seed.js';

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (name, stream) => (message, extra) => {
    if (LEVELS[name] > threshold) return;
    const entry = { ts: new Date().toISOString(), level: name, msg: message };
    if (extra instanceof Error) entry.error = extra.stack ?? String(extra);
    else if (extra !== undefined) entry.data = extra;
    stream.write(JSON.stringify(entry) + '\n');
  };
  return { error: write('error', process.stderr), warn: write('warn', process.stderr), info: write('info', process.stdout), debug: write('debug', process.stdout) };
}

const UNSAFE = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
// While a temporary password is in force only these calls are allowed.
const PASSWORD_CHANGE_ALLOWED = new Set(['GET /api/session', 'POST /api/logout', 'POST /api/me/password', 'GET /api/policy']);

export function createApp({ config, db, clock = { now: () => new Date() }, logger = createLogger(config.logLevel), fetchImpl = globalThis.fetch }) {
  const audit = createAudit({ db, clock });
  const users = createUsers({ db, clock, audit, config });
  const auth = createAuth({ db, clock, audit, config, users });
  const policy = createPolicyService({ db, clock, audit, users, config, logger });
  policy.ensureInitial();
  const outbox = createOutbox({ db, clock, config, logger, fetchImpl });
  const notifier = createNotifier({ db, clock, config, users, outbox });
  const requests = createRequests({ db, clock, audit, users, policy, notifier });
  const executions = createExecutions({ db, clock, audit, users, policy, notifier, requests, outbox, config, logger });
  const approvals = createApprovals({ db, clock, audit, users, policy, notifier, requests, executions });
  const reports = createReports({ db, clock, users });
  const sweeper = createSweeper({ db, clock, audit, policy, notifier, requests, auth, outbox, config, logger });
  const services = { audit, users, auth, policy, outbox, notifier, requests, executions, approvals, reports, sweeper };

  const router = createRouter();

  // ----- response helpers --------------------------------------------------

  function viewerFor(principal, row) {
    const isUser = principal.type === 'user';
    const isRequester = isUser && row.requester_id === principal.id;
    const cap = approvals.capacityFor(principal, row);
    const exec = executions.latestFor(row.id);
    const operator = isUser && can(principal, 'execution.operate');
    const stillValid = Boolean(row.approval_valid_until) && row.approval_valid_until > clock.now().toISOString();
    return {
      isRequester,
      canEdit: isRequester && ['draft', 'returned'].includes(row.status),
      canDelete: isRequester && row.status === 'draft',
      canCancel: isUser && (isRequester || can(principal, 'stage.reassign')) && ['pending', 'returned', 'approved'].includes(row.status),
      canClone: isRequester && can(principal, 'request.create') && row.status !== 'draft',
      canComment: isUser && row.status !== 'draft',
      canDecide: cap.can,
      decideCode: cap.code,
      decideSeats: cap.seats.map((id) => users.briefById(id)),
      canReassign: isUser && can(principal, 'stage.reassign') && row.status === 'pending',
      execution: exec
        ? {
            id: exec.id,
            status: exec.status,
            mode: exec.mode,
            canClaim: operator && ['queued', 'dispatching', 'running'].includes(exec.status) && ['approved', 'executing'].includes(row.status),
            isMine: operator && exec.status === 'claimed' && exec.operator_id === principal.id,
            canRetry: operator && ['failed', 'partial'].includes(exec.status) && ['failed', 'partial'].includes(row.status) && stillValid,
          }
        : null,
    };
  }

  function requestResponse(principal, id) {
    const request = requests.detail(principal, id);
    return { request, viewer: viewerFor(principal, requests.core.getRow(id)) };
  }

  function requireUser(ctx) {
    if (ctx.principal.type !== 'user') throw fail.forbidden('user_required', 'This call needs a signed-in user');
    return ctx.principal;
  }

  function badges(principal) {
    return {
      approvals: approvals.pendingCount(principal),
      executions: executions.counts(principal),
      notifications: notifier.unreadCount(principal.id),
      returned: db.get("SELECT count(*) AS n FROM requests WHERE requester_id = ? AND status = 'returned'", principal.id).n,
    };
  }

  function appInfo() {
    return {
      name: 'MIP Release Center',
      version: config.version,
      authMode: config.authMode,
      demo: config.demo,
      demoAccounts: config.demo ? DEMO_ACCOUNTS.map((a) => ({ login: a.login, name: a.name, title: a.title, roles: a.roles })) : undefined,
      demoPassword: config.demo ? DEMO_PASSWORD : undefined,
      executorMode: policy.executorMode(),
      executorWebhookConfigured: Boolean(config.executorWebhookUrl),
      passwordMinLength: config.passwordMinLength,
      roles: ROLES,
      tokenScopes: Object.keys(TOKEN_SCOPES),
    };
  }

  // ----- routes: session ---------------------------------------------------

  router.get('/healthz', { public: true }, () => ({ status: 'ok', version: config.version }));

  router.get('/api/session', { public: true }, (ctx) => {
    if (!ctx.session && config.authMode === 'header') {
      const identity = auth.proxyIdentity(ctx.req);
      if (identity) {
        const created = auth.startProxySession(identity, { ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
        ctx.setHeader('Set-Cookie', auth.sessionCookie(ctx.req, created.token));
        return { user: users.full(users.rowById(identity.id)), csrfToken: created.csrfToken, app: appInfo() };
      }
    }
    if (!ctx.session) return { user: null, csrfToken: null, app: appInfo() };
    return { user: users.full(ctx.session.user), csrfToken: ctx.session.csrfToken, app: appInfo() };
  });

  router.post('/api/login', { public: true, csrf: false }, async (ctx) => {
    const result = await auth.login(ctx.body, { ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
    ctx.setHeader('Set-Cookie', auth.sessionCookie(ctx.req, result.token));
    return { user: users.full(result.user), csrfToken: result.csrfToken, app: appInfo() };
  });

  router.post('/api/logout', {}, (ctx) => {
    if (ctx.session) auth.logout(ctx.session, ctx.principal);
    ctx.setHeader('Set-Cookie', auth.sessionCookie(ctx.req, ''));
    return { ok: true };
  });

  router.post('/api/me/password', {}, async (ctx) => {
    await users.changeOwnPassword(requireUser(ctx), ctx.body.current, ctx.body.next, ctx.session?.tokenHash);
    return { ok: true };
  });

  router.put('/api/me', {}, (ctx) => ({ user: users.setLocale(requireUser(ctx), ctx.body.locale) }));

  router.get('/api/badges', {}, (ctx) => badges(requireUser(ctx)));

  router.get('/api/dashboard', {}, (ctx) => {
    const principal = requireUser(ctx);
    const inbox = approvals.inbox(principal);
    const out = {
      badges: badges(principal),
      mine: {
        counts: requests.statusCounts(principal, { scope: 'mine' }),
        recent: requests.list(principal, { scope: 'mine', pageSize: 6 }).items,
      },
      approvals: inbox.slice(0, 5),
      notice: policy.current().policy.notice,
    };
    if (can(principal, 'request.read.all')) out.organisation = reports.backlog();
    return out;
  });

  router.get('/api/notifications', {}, (ctx) => {
    const principal = requireUser(ctx);
    return { items: notifier.list(principal.id, { unreadOnly: ctx.query.unread === 'true', limit: ctx.query.limit }), unread: notifier.unreadCount(principal.id) };
  });

  router.post('/api/notifications/read', {}, (ctx) => {
    const principal = requireUser(ctx);
    notifier.markRead(principal.id, ctx.body.all === true ? 'all' : ctx.body.ids);
    return { unread: notifier.unreadCount(principal.id) };
  });

  router.get('/api/directory/users', {}, (ctx) => {
    requireUser(ctx);
    if (ctx.query.ids !== undefined) {
      const ids = String(ctx.query.ids).split(',').filter(Boolean).slice(0, 50);
      return { items: ids.map((id) => users.rowById(id)).filter(Boolean).map((row) => ({ ...users.brief(row), login: row.login })) };
    }
    return { items: users.directory(ctx.query.q, ctx.query.limit) };
  });

  router.get('/api/directory/departments', {}, (ctx) => {
    requireUser(ctx);
    return { items: users.listDepartments() };
  });

  // ----- routes: delegation ------------------------------------------------

  router.get('/api/delegations', {}, (ctx) => ({ items: approvals.listDelegations(requireUser(ctx), { all: ctx.query.all === 'true' }) }));
  router.post('/api/delegations', {}, (ctx) => ({ delegation: approvals.createDelegation(requireUser(ctx), ctx.body) }));
  router.delete('/api/delegations/:id', {}, (ctx) => ({ delegation: approvals.revokeDelegation(requireUser(ctx), ctx.params.id) }));

  // ----- routes: policy ----------------------------------------------------

  router.get('/api/policy', {}, () => policy.current());
  router.get('/api/policy/versions', { permission: 'policy.write' }, () => ({ items: policy.versions() }));
  router.get('/api/policy/versions/:version', { permission: 'policy.write' }, (ctx) => {
    const found = policy.version(Number(ctx.params.version));
    if (!found) throw fail.notFound();
    return found;
  });
  router.post('/api/policy/validate', { permission: 'policy.write' }, (ctx) => {
    const { errors } = policy.validate(ctx.body.policy);
    return { valid: errors.length === 0, errors };
  });
  router.put('/api/policy', { permission: 'policy.write' }, (ctx) => policy.save(ctx.principal, ctx.body.policy, { note: ctx.body.note, baseVersion: ctx.body.baseVersion }));

  // Try a draft policy against a sample request: which route, which approvers.
  router.post('/api/policy/simulate', { permission: 'policy.write' }, (ctx) => {
    const { policy: draft, errors } = policy.validate(ctx.body.policy ?? policy.current().policy);
    if (errors.length) throw fail.invalid(errors, 'Policy is not valid');
    const sample = ctx.body.sample ?? {};
    const requester = users.rowById(sample.requesterId) ?? ctx.principal.user;
    const labelIds = Array.isArray(sample.labelIds) ? sample.labelIds.filter((l) => typeof l === 'string') : [];
    const facts = policy.factsFor(draft, {
      action: String(sample.action ?? ''),
      labelIds,
      external: Boolean(sample.external),
      reasonId: sample.reasonId ? String(sample.reasonId) : null,
      departmentId: requester.department_id,
      documentCount: Number.isInteger(sample.documentCount) ? sample.documentCount : Math.max(1, labelIds.length),
    });
    const route = policy.resolveRoute(draft, facts);
    if (!route) return { facts, route: null, error: { code: 'no_route' } };
    try {
      const { stages, cc } = policy.buildStages(draft, route, requester);
      return {
        facts,
        requester: users.brief(requester),
        route: { id: route.id, name: route.name },
        stages: stages.map((s) => ({ name: s.name, minApprovals: s.minApprovals, slaHours: s.slaHours, skipped: s.skipped, note: s.note, assignees: s.assignees.map((u) => users.brief(u)) })),
        cc: cc.map((u) => users.brief(u)),
      };
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) return { facts, requester: users.brief(requester), route: { id: route.id, name: route.name }, error: { code: err.code, details: err.details } };
      throw err;
    }
  });

  // ----- routes: requests --------------------------------------------------

  router.get('/api/requests', { tokenScope: 'requests:read' }, (ctx) => ({
    ...requests.list(ctx.principal, ctx.query),
    counts: ctx.query.counts === 'true' ? requests.statusCounts(ctx.principal, ctx.query) : undefined,
  }));

  router.get('/api/requests/export.csv', { tokenScope: 'requests:read' }, (ctx) => {
    const body = requests.exportCsv(ctx.principal, ctx.query);
    ctx.download({ body, contentType: 'text/csv; charset=utf-8', filename: `requests-${clock.now().toISOString().slice(0, 10)}.csv` });
  });

  router.post('/api/requests/preview', {}, (ctx) => requests.previewRoute(requireUser(ctx), ctx.body));

  router.post('/api/requests', {}, (ctx) => {
    const row = requests.createDraft(requireUser(ctx), ctx.body);
    return requestResponse(ctx.principal, row.id);
  });

  router.get('/api/requests/:id', { tokenScope: 'requests:read' }, (ctx) => requestResponse(ctx.principal, ctx.params.id));

  router.put('/api/requests/:id', {}, (ctx) => {
    requests.updateDraft(requireUser(ctx), ctx.params.id, ctx.body);
    return requestResponse(ctx.principal, ctx.params.id);
  });

  router.delete('/api/requests/:id', {}, (ctx) => requests.deleteDraft(requireUser(ctx), ctx.params.id));

  router.post('/api/requests/:id/submit', {}, (ctx) => {
    requests.submit(requireUser(ctx), ctx.params.id, { acknowledged: ctx.body.acknowledged, version: ctx.body.version });
    return requestResponse(ctx.principal, ctx.params.id);
  });

  router.post('/api/requests/:id/cancel', {}, (ctx) => {
    requests.cancel(requireUser(ctx), ctx.params.id, { reason: ctx.body.reason });
    return requestResponse(ctx.principal, ctx.params.id);
  });

  router.post('/api/requests/:id/clone', {}, (ctx) => {
    const row = requests.clone(requireUser(ctx), ctx.params.id);
    return requestResponse(ctx.principal, row.id);
  });

  router.post('/api/requests/:id/comments', {}, (ctx) => {
    requests.addComment(requireUser(ctx), ctx.params.id, ctx.body.body);
    return requestResponse(ctx.principal, ctx.params.id);
  });

  router.post('/api/requests/:id/decisions', {}, (ctx) => {
    approvals.decide(requireUser(ctx), ctx.params.id, ctx.body);
    return requestResponse(ctx.principal, ctx.params.id);
  });

  router.post('/api/requests/:id/stages/:stageId/reassign', { permission: 'stage.reassign' }, (ctx) => {
    approvals.reassign(requireUser(ctx), ctx.params.id, ctx.params.stageId, ctx.body);
    return requestResponse(ctx.principal, ctx.params.id);
  });

  // ----- routes: approvals -------------------------------------------------

  router.get('/api/approvals', {}, (ctx) => {
    const principal = requireUser(ctx);
    return ctx.query.state === 'done' ? { items: approvals.history(principal, { limit: ctx.query.limit }) } : { items: approvals.inbox(principal) };
  });

  // ----- routes: executions ------------------------------------------------

  router.get('/api/executions', { permission: 'execution.operate' }, (ctx) => ({
    items: executions.list(requireUser(ctx), { tab: ctx.query.tab, limit: ctx.query.limit }),
    counts: executions.counts(ctx.principal),
  }));

  const executionAction = (name) => (ctx) => {
    const exec = executions[name](requireUser(ctx), ctx.params.id, ctx.body);
    return requestResponse(ctx.principal, exec.request_id);
  };
  router.post('/api/executions/:id/claim', { permission: 'execution.operate' }, executionAction('claim'));
  router.post('/api/executions/:id/release', { permission: 'execution.operate' }, executionAction('release'));
  router.post('/api/executions/:id/complete', { permission: 'execution.operate' }, executionAction('complete'));
  router.post('/api/executions/:id/retry', { permission: 'execution.operate' }, executionAction('retry'));
  router.post('/api/executions/:id/documents/:documentId', { permission: 'execution.operate' }, (ctx) => {
    executions.recordDocument(requireUser(ctx), ctx.params.id, ctx.params.documentId, ctx.body);
    return requestResponse(ctx.principal, executions.getExec(ctx.params.id).request_id);
  });

  // Called by the organisation's executor, authenticated by its HMAC signature.
  router.post('/api/executions/:id/callback', { public: true, csrf: false, raw: true }, (ctx) =>
    executions.handleCallback(ctx.params.id, ctx.rawBody, ctx.req.headers, ctx.ip));

  // ----- routes: audit and reports ----------------------------------------

  router.get('/api/audit', { permission: 'audit.read', tokenScope: 'audit:read' }, (ctx) => audit.query(ctx.query));
  router.get('/api/audit/actions', { permission: 'audit.read', tokenScope: 'audit:read' }, () => ({ items: audit.distinctActions() }));

  router.get('/api/audit/verify', { permission: 'audit.read', tokenScope: 'audit:read' }, (ctx) => {
    const result = audit.verify();
    audit.append(ctx.principal, 'audit.verified', { details: { ok: result.ok, count: result.count, brokenAt: result.brokenAt ?? null } });
    return result;
  });

  router.get('/api/audit/export', { permission: 'audit.export', tokenScope: 'audit:read' }, (ctx) => {
    const format = ctx.query.format === 'jsonl' ? 'jsonl' : 'csv';
    const rows = audit.exportRows(ctx.query);
    const stamp = clock.now().toISOString().slice(0, 10);
    audit.append(ctx.principal, 'audit.exported', { details: { format, count: rows.length } });
    if (format === 'jsonl') {
      ctx.download({ body: rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), contentType: 'application/x-ndjson; charset=utf-8', filename: `audit-${stamp}.jsonl` });
      return;
    }
    const columns = [
      ['seq', (r) => r.seq], ['ts', (r) => r.ts], ['actor_type', (r) => r.actorType], ['actor', (r) => r.actorLabel], ['action', (r) => r.action],
      ['entity_type', (r) => r.entityType], ['entity_id', (r) => r.entityId], ['request_id', (r) => r.requestId], ['ip', (r) => r.ip],
      ['details', (r) => JSON.stringify(r.details)], ['prev_hash', (r) => r.prevHash], ['hash', (r) => r.hash],
    ].map(([header, value]) => ({ header, value }));
    ctx.download({ body: toCsv(columns, rows), contentType: 'text/csv; charset=utf-8', filename: `audit-${stamp}.csv` });
  });

  router.get('/api/reports/summary', { permission: 'report.read', tokenScope: 'reports:read' }, (ctx) => {
    const result = reports.summary(ctx.query);
    if (!result) throw fail.badRequest('invalid_range', 'from/to are not valid dates');
    return result;
  });

  // ----- routes: administration -------------------------------------------

  router.get('/api/admin/users', { permission: 'user.manage' }, (ctx) => users.list(ctx.query));
  router.post('/api/admin/users', { permission: 'user.manage' }, (ctx) => users.create(ctx.principal, ctx.body));
  router.put('/api/admin/users/:id', { permission: 'user.manage' }, (ctx) => ({ user: users.update(ctx.principal, ctx.params.id, ctx.body) }));
  router.post('/api/admin/users/:id/reset-password', { permission: 'user.manage' }, (ctx) => users.resetPassword(ctx.principal, ctx.params.id));

  router.get('/api/admin/departments', { permission: 'user.manage' }, () => ({ items: users.listDepartments({ includeInactive: true }) }));
  router.post('/api/admin/departments', { permission: 'user.manage' }, (ctx) => ({ department: users.createDepartment(ctx.principal, ctx.body) }));
  router.put('/api/admin/departments/:id', { permission: 'user.manage' }, (ctx) => ({ department: users.updateDepartment(ctx.principal, ctx.params.id, ctx.body) }));

  router.get('/api/admin/tokens', { permission: 'token.manage' }, () => ({ items: auth.listTokens() }));
  router.post('/api/admin/tokens', { permission: 'token.manage' }, (ctx) => auth.createToken(ctx.principal, ctx.body));
  router.delete('/api/admin/tokens/:id', { permission: 'token.manage' }, (ctx) => ({ token: auth.revokeToken(ctx.principal, ctx.params.id) }));

  router.get('/api/admin/system', { permission: 'system.read' }, () => ({
    version: config.version,
    node: process.version,
    authMode: config.authMode,
    demo: config.demo,
    baseUrl: config.baseUrl,
    policyVersion: policy.current().version,
    executor: {
      mode: policy.executorMode(),
      requestedMode: policy.current().policy.executor.mode,
      webhookConfigured: Boolean(config.executorWebhookUrl),
      webhookHost: config.executorWebhookUrl ? new URL(config.executorWebhookUrl).host : null,
    },
    notifications: {
      webhookConfigured: Boolean(config.notifyWebhookUrl),
      webhookHost: config.notifyWebhookUrl ? new URL(config.notifyWebhookUrl).host : null,
      signed: Boolean(config.notifyWebhookSecret),
    },
    outbox: outbox.stats(),
    sessions: auth.sessionCount(),
    counts: {
      users: users.count(),
      requests: db.get("SELECT count(*) AS n FROM requests WHERE status <> 'draft'").n,
      auditEntries: db.get('SELECT count(*) AS n FROM audit_log').n,
      openExecutions: executions.openCount(),
    },
    session: { idleMinutes: config.sessionIdleMinutes, maxHours: config.sessionMaxHours },
  }));

  // ----- request handling --------------------------------------------------

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin) {
      const forwardedHost = fromTrustedProxy(req, config) ? String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim() : '';
      const hosts = [req.headers.host, forwardedHost].filter(Boolean);
      try {
        return hosts.includes(new URL(origin).host);
      } catch {
        return false;
      }
    }
    const site = req.headers['sec-fetch-site'];
    return !site || site === 'same-origin' || site === 'none';
  }

  async function handleApi(req, res, url) {
    const matched = router.match(req.method, url.pathname);
    if (!matched) throw fail.notFound('unknown_endpoint', 'No such endpoint');
    if (matched.allowed) throw new HttpError(405, 'method_not_allowed', `Use ${matched.allowed.join(', ')}`);
    const { route, params } = matched;
    const options = route.options;
    const ip = clientIp(req, config);
    const extraHeaders = {};
    let responded = false;
    const ctx = {
      req,
      params,
      query: Object.fromEntries(url.searchParams),
      ip,
      principal: null,
      session: null,
      body: {},
      rawBody: Buffer.alloc(0),
      setHeader: (name, value) => {
        extraHeaders[name] = value;
      },
      download: (file) => {
        responded = true;
        sendDownload(res, file);
      },
    };

    // Who is calling: an API token, or a browser session.
    const bearer = req.headers.authorization;
    if (bearer && /^Bearer\s/i.test(bearer)) {
      ctx.principal = auth.resolveToken(bearer, ip);
      if (!options.tokenScope || !ctx.principal.scopes.includes(options.tokenScope)) {
        throw fail.forbidden('token_scope', 'This token is not allowed to call this endpoint');
      }
    } else {
      const session = auth.resolveSession(auth.sessionTokenFrom(req));
      if (session && config.authMode === 'header') {
        // Behind an identity proxy the header is the source of truth: a cookie
        // left over from someone else must not be honoured.
        const identity = auth.proxyIdentity(req);
        if (identity && identity.id === session.user.id) ctx.session = session;
      } else ctx.session = session;
      if (ctx.session) ctx.principal = users.principalFor(ctx.session.user, ip);
    }

    if (UNSAFE.has(req.method) && ctx.principal?.type !== 'token') {
      if (!sameOrigin(req)) throw fail.forbidden('bad_origin', 'Cross-site requests are not accepted');
      if (options.csrf !== false && ctx.session) {
        const sent = String(req.headers['x-csrf-token'] ?? '');
        if (!sent || !safeEqual(sent, ctx.session.csrfToken)) throw fail.forbidden('bad_csrf_token', 'Missing or wrong CSRF token');
      }
    }

    if (!options.public && !ctx.principal) throw fail.unauthorized();
    if (ctx.principal?.type === 'user' && ctx.session?.user.must_change_password && !PASSWORD_CHANGE_ALLOWED.has(`${req.method} ${route.pattern}`)) {
      throw fail.forbidden('password_change_required', 'Change your temporary password first');
    }
    if (options.permission && !can(ctx.principal, options.permission)) throw fail.forbidden();

    if (UNSAFE.has(req.method)) {
      ctx.rawBody = await readBody(req);
      if (!options.raw) ctx.body = parseJsonBody(req, ctx.rawBody);
    }

    const result = await route.handler(ctx);
    if (!responded) sendJson(res, 200, result ?? { ok: true }, extraHeaders);
  }

  async function handle(req, res) {
    const started = process.hrtime.bigint();
    for (const [name, value] of Object.entries(securityHeaders(req, config))) res.setHeader(name, value);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, { error: { code: 'bad_request', message: 'Malformed URL' } });
      return;
    }
    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/healthz';
    try {
      if (isApi) {
        await handleApi(req, res, url);
      } else if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'method_not_allowed', 'Use GET');
      } else if (!serveStatic(req, res, config.publicDir, url.pathname)) {
        // Unknown paths without a file extension get the app shell; missing assets get a 404.
        if (/\.[A-Za-z0-9]+$/.test(url.pathname) || !serveStatic(req, res, config.publicDir, '/index.html')) {
          throw fail.notFound();
        }
      }
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
      } else if (err instanceof HttpError) {
        const headers = err.status === 429 && err.details?.retryAfterSeconds ? { 'Retry-After': String(err.details.retryAfterSeconds) } : {};
        sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details } }, headers);
      } else {
        logger.error(`${req.method} ${url.pathname} failed`, err);
        sendJson(res, 500, { error: { code: 'internal_error', message: 'Something went wrong on the server' } });
      }
    } finally {
      if (isApi) {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        logger.debug(`${req.method} ${url.pathname} ${res.statusCode} ${ms.toFixed(1)}ms`);
      }
    }
  }

  function start() {
    outbox.start();
    sweeper.start();
  }

  function stop() {
    outbox.stop();
    sweeper.stop();
  }

  return { handle, services, router, start, stop, config, db, clock, logger };
}
