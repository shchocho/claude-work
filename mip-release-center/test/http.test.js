import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeOrg, serve, content, doc, PASSWORD } from './helpers.js';

async function setup(overrides) {
  const ctx = makeApp(overrides);
  const org = await makeOrg(ctx);
  const server = await serve(ctx);
  return { ...ctx, org, ...server };
}

test('every response carries the security headers', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = s.client();
  for (const path of ['/api/session', '/', '/api/nope']) {
    const res = await c.get(path);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/, 'no inline or remote scripts');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  }
  assert.equal((await c.get('/api/session')).headers.get('cache-control'), 'no-store');
});

test('nothing but the session probe works without signing in', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = s.client();
  const session = await c.get('/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.json.user, null);
  assert.equal(session.json.app.demoAccounts, undefined, 'no demo hints outside demo mode');
  for (const path of ['/api/requests', '/api/policy', '/api/audit', '/api/admin/users', '/api/dashboard', '/api/approvals']) {
    const res = await c.get(path);
    assert.equal(res.status, 401, path);
    assert.equal(res.json.error.code, 'unauthenticated');
  }
  assert.equal((await c.get('/healthz')).json.status, 'ok');
});

test('sign-in, session cookie, sign-out', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = s.client();
  const bad = await c.login('alice', 'wrong-password');
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'invalid_credentials');
  const unknown = await c.login('nobody', 'wrong-password');
  assert.deepEqual([unknown.status, unknown.json.error.code], [401, 'invalid_credentials'], 'unknown logins look the same as wrong passwords');

  const ok = await c.login('ALICE');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.login, 'alice', 'logins are case-insensitive');
  assert.match(ok.headers.get('set-cookie'), /^mrc_sid=[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  assert.deepEqual(ok.json.user.permissions, ['request.create']);
  assert.equal(JSON.stringify(ok.json).includes('password_hash'), false);

  assert.equal((await c.get('/api/requests')).status, 200);
  assert.equal((await c.post('/api/logout')).status, 200);
  assert.equal((await c.get('/api/requests')).status, 401);
  const actions = s.services.audit.query({ action: 'auth.' }).items.map((e) => e.action);
  assert.deepEqual(actions, ['auth.logout', 'auth.login', 'auth.login_failed', 'auth.login_failed']);
});

test('repeated failures lock the account for a while', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = s.client();
  for (let i = 0; i < 5; i += 1) assert.equal((await c.login('bob', 'nope')).status, 401);
  const locked = await c.login('bob');
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error.code, 'too_many_attempts');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  // The same happens for a login that does not exist, so lockouts reveal nothing.
  for (let i = 0; i < 5; i += 1) await c.login('ghost', 'nope');
  assert.equal((await c.login('ghost', 'nope')).status, 429);
  s.clock.advance({ minutes: 16 });
  assert.equal((await c.login('bob')).status, 200);
});

test('too many attempts from one address are slowed down regardless of login', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = s.client();
  let status = 0;
  for (let i = 0; i < 31; i += 1) status = (await c.login(`user${i}`, 'nope')).status;
  assert.equal(status, 429);
  s.clock.advance({ minutes: 6 });
  assert.equal((await c.login('alice')).status, 200);
});

test('state-changing calls need the CSRF token and a same-site origin', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = s.client();
  await c.login('alice');
  c.forgetCsrf();
  const missing = await c.post('/api/requests', content());
  assert.deepEqual([missing.status, missing.json.error.code], [403, 'bad_csrf_token']);
  const wrong = await c.post('/api/requests', content(), { 'X-CSRF-Token': 'guess' });
  assert.deepEqual([wrong.status, wrong.json.error.code], [403, 'bad_csrf_token']);

  await c.get('/api/session');
  const crossSite = await c.post('/api/requests', content(), { Origin: 'https://evil.example' });
  assert.deepEqual([crossSite.status, crossSite.json.error.code], [403, 'bad_origin']);
  const fetchSite = await c.post('/api/requests', content(), { 'Sec-Fetch-Site': 'cross-site' });
  assert.deepEqual([fetchSite.status, fetchSite.json.error.code], [403, 'bad_origin']);
  const loginFromElsewhere = await s.client().post('/api/login', { login: 'alice', password: PASSWORD }, { Origin: 'https://evil.example' });
  assert.equal(loginFromElsewhere.status, 403);

  const ok = await c.post('/api/requests', content(), { Origin: s.base });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.request.status, 'draft');
});

test('sessions end after inactivity and at the absolute limit', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = s.client();
  await c.login('alice');
  s.clock.advance({ minutes: 29 });
  assert.equal((await c.get('/api/badges')).status, 200);
  s.clock.advance({ minutes: 31 });
  assert.equal((await c.get('/api/badges')).status, 401);

  await c.login('alice');
  for (let i = 0; i < 30; i += 1) {
    s.clock.advance({ minutes: 25 });
    if ((await c.get('/api/badges')).status === 401) {
      assert.ok(i >= 28, 'kept alive by activity until the 12 hour limit');
      return;
    }
  }
  assert.fail('session never reached its absolute limit');
});

test('permissions are enforced per endpoint', async (t) => {
  const s = await setup();
  t.after(s.close);
  const expectations = {
    alice: { '/api/admin/users': 403, '/api/audit': 403, '/api/reports/summary': 403, '/api/executions': 403, '/api/policy/versions': 403, '/api/policy': 200, '/api/admin/system': 403 },
    aud: { '/api/admin/users': 403, '/api/audit': 200, '/api/reports/summary': 200, '/api/executions': 403, '/api/policy/versions': 403, '/api/audit/export': 200 },
    sec1: { '/api/admin/users': 403, '/api/audit': 200, '/api/reports/summary': 200, '/api/policy/versions': 200, '/api/admin/tokens': 403 },
    op1: { '/api/executions': 200, '/api/audit': 403, '/api/admin/users': 403 },
    adm: { '/api/admin/users': 200, '/api/admin/tokens': 200, '/api/admin/system': 200, '/api/audit': 200, '/api/executions': 403 },
  };
  for (const [login, paths] of Object.entries(expectations)) {
    const c = s.client();
    await c.login(login);
    for (const [path, status] of Object.entries(paths)) assert.equal((await c.get(path)).status, status, `${login} ${path}`);
  }
  const alice = s.client();
  await alice.login('alice');
  assert.equal((await alice.put('/api/policy', { policy: {} })).status, 403);
  assert.equal((await alice.post('/api/admin/users', { login: 'mallory', name: 'M', roles: ['admin'] })).status, 403);
});

test('a temporary password must be changed before anything else', async (t) => {
  const s = await setup();
  t.after(s.close);
  const admin = s.client();
  await admin.login('adm');
  const created = await admin.post('/api/admin/users', { login: 'dave', name: 'Dave', roles: ['requester'] });
  assert.equal(created.status, 200);
  const temp = created.json.temporaryPassword;
  assert.match(temp, /^[A-Za-z2-9]{16}$/);
  assert.equal(created.json.user.mustChangePassword, true);

  const c = s.client();
  assert.equal((await c.login('dave', temp)).status, 200);
  const blocked = await c.get('/api/requests');
  assert.deepEqual([blocked.status, blocked.json.error.code], [403, 'password_change_required']);
  assert.equal((await c.get('/api/policy')).status, 200, 'the form texts are still readable');

  const codes = async (next, current = temp) => ((await c.post('/api/me/password', { current, next })).json.error?.details ?? []).map((e) => e.code);
  assert.deepEqual(await codes('short'), ['password_too_short']);
  assert.deepEqual(await codes('dave-dave-dave-dave'), ['password_contains_login']);
  assert.deepEqual(await codes('aaaaaaaaaaaaaa'), ['password_too_simple']);
  assert.deepEqual(await codes('Good-Enough-Pass-9', 'not-the-temp'), ['wrong_password']);
  assert.deepEqual(await codes(temp), ['password_unchanged']);
  assert.equal((await c.post('/api/me/password', { current: temp, next: 'Good-Enough-Pass-9' })).status, 200);
  assert.equal((await c.get('/api/requests')).status, 200);
  assert.equal((await s.client().login('dave', temp)).status, 401);
  assert.equal((await s.client().login('dave', 'Good-Enough-Pass-9')).status, 200);
});

test('administration guards: unique logins, last admin, self-deactivation, session revocation', async (t) => {
  const s = await setup();
  t.after(s.close);
  const admin = s.client();
  await admin.login('adm');
  const dup = await admin.post('/api/admin/users', { login: 'Alice', name: 'Other Alice' });
  assert.deepEqual(dup.json.error.details, [{ field: 'login', code: 'login_taken' }]);
  const badRole = await admin.post('/api/admin/users', { login: 'erin', name: 'Erin', roles: ['root'] });
  assert.deepEqual(badRole.json.error.details, [{ field: 'roles', code: 'invalid_roles' }]);

  const demote = await admin.put(`/api/admin/users/${s.org.ids.adm}`, { roles: ['requester'] });
  assert.deepEqual([demote.status, demote.json.error.code], [409, 'last_admin']);
  const cycle = await admin.put(`/api/admin/users/${s.org.ids.head}`, { managerId: s.org.ids.alice });
  assert.deepEqual(cycle.json.error.details, [{ field: 'managerId', code: 'cycle' }]);

  await admin.put(`/api/admin/users/${s.org.ids.bob}`, { roles: ['requester', 'admin'] });
  const self = await admin.put(`/api/admin/users/${s.org.ids.adm}`, { active: false });
  assert.deepEqual([self.status, self.json.error.code], [409, 'cannot_deactivate_self']);

  // Deactivating someone signs them out at once and blocks new sign-ins.
  const alice = s.client();
  await alice.login('alice');
  assert.equal((await admin.put(`/api/admin/users/${s.org.ids.alice}`, { active: false })).status, 200);
  assert.equal((await alice.get('/api/badges')).status, 401);
  assert.equal((await s.client().login('alice')).status, 401);
  const roleChange = s.services.audit.query({ action: 'user.roles_changed' }).items[0];
  assert.deepEqual(roleChange.details.changes.roles, { from: ['requester'], to: ['requester', 'admin'] });
});

test('API tokens are read-only, scoped and revocable', async (t) => {
  const s = await setup();
  t.after(s.close);
  const admin = s.client();
  await admin.login('adm');
  const created = await admin.post('/api/admin/tokens', { name: 'SIEM export', scopes: ['audit:read'], expiresInDays: 30 });
  assert.equal(created.status, 200);
  const secret = created.json.secret;
  assert.match(secret, /^mrc_[\w-]{40}$/);
  const listed = await admin.get('/api/admin/tokens');
  assert.equal(JSON.stringify(listed.json).includes(secret), false, 'the secret is shown once and never again');
  assert.equal(listed.json.items[0].hint, secret.slice(-4));

  const bearer = { Authorization: `Bearer ${secret}` };
  const api = s.client();
  const audit = await api.get('/api/audit?limit=5&order=asc', bearer);
  assert.equal(audit.status, 200);
  assert.equal(audit.json.items[0].seq, 1);
  assert.equal((await api.get('/api/audit/verify', bearer)).json.ok, true);
  assert.equal((await api.get('/api/audit/export?format=jsonl', bearer)).status, 200);
  const outOfScope = await api.get('/api/requests', bearer);
  assert.deepEqual([outOfScope.status, outOfScope.json.error.code], [403, 'token_scope']);
  assert.equal((await api.get('/api/admin/users', bearer)).status, 403);
  assert.equal((await api.post('/api/requests', content(), bearer)).status, 403, 'tokens cannot change anything');
  assert.equal((await api.get('/api/audit', { Authorization: 'Bearer mrc_notarealtoken' })).status, 401);
  assert.equal((await api.get('/api/audit', { Authorization: 'Bearer something-else' })).status, 401);

  const requestsToken = (await admin.post('/api/admin/tokens', { name: 'BI', scopes: ['requests:read', 'reports:read'] })).json.secret;
  assert.equal((await api.get('/api/requests', { Authorization: `Bearer ${requestsToken}` })).status, 200);
  assert.equal((await api.get('/api/reports/summary', { Authorization: `Bearer ${requestsToken}` })).status, 200);
  assert.equal((await api.get('/api/audit', { Authorization: `Bearer ${requestsToken}` })).status, 403);

  assert.equal((await admin.del(`/api/admin/tokens/${created.json.token.id}`)).status, 200);
  assert.equal((await api.get('/api/audit', bearer)).status, 401);
  s.clock.advance({ days: 1 });
  const expiring = (await admin.login('adm'), await admin.post('/api/admin/tokens', { name: 'Short', scopes: ['audit:read'], expiresInDays: 1 })).json.secret;
  s.clock.advance({ days: 2 });
  assert.equal((await api.get('/api/audit', { Authorization: `Bearer ${expiring}` })).status, 401);
  const invalid = await (await admin.login('adm'), admin.post('/api/admin/tokens', { name: '', scopes: ['everything'] }));
  assert.deepEqual(invalid.json.error.details.map((e) => e.field), ['name', 'scopes']);
});

test('the whole flow over HTTP, with the viewer flags the UI relies on', async (t) => {
  const s = await setup();
  t.after(s.close);
  const alice = s.client();
  const lead = s.client();
  const op = s.client();
  await alice.login('alice');
  await lead.login('lead');
  await op.login('op1');

  const preview = await alice.post('/api/requests/preview', content());
  assert.equal(preview.json.route.id, 'default');
  const created = await alice.post('/api/requests', content({ documents: [doc('a.docx'), doc('b.docx')] }));
  const id = created.json.request.id;
  assert.deepEqual(pickFlags(created.json.viewer), { canEdit: true, canDelete: true, canCancel: false, canDecide: false, canComment: false });

  const invalid = await alice.post(`/api/requests/${id}/submit`, {});
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.json.error.details, [{ field: 'acknowledged', code: 'required' }]);
  const sent = await alice.post(`/api/requests/${id}/submit`, { acknowledged: true });
  assert.equal(sent.json.request.status, 'pending');
  assert.deepEqual(pickFlags(sent.json.viewer), { canEdit: false, canDelete: false, canCancel: true, canDecide: false, canComment: true });
  assert.equal(sent.json.request.stages[0].assignees[0].name, 'Lead');
  assert.deepEqual(sent.json.request.timeline.map((e) => e.action), ['request.created', 'request.submitted']);

  assert.equal((await lead.get('/api/badges')).json.approvals, 1);
  const inbox = await lead.get('/api/approvals');
  assert.equal(inbox.json.items[0].request.id, id);
  const seen = await lead.get(`/api/requests/${id}`);
  assert.deepEqual(pickFlags(seen.json.viewer), { canEdit: false, canDelete: false, canCancel: false, canDecide: true, canComment: true });
  assert.equal((await alice.post(`/api/requests/${id}/decisions`, { decision: 'approve' })).status, 403);
  const decided = await lead.post(`/api/requests/${id}/decisions`, { decision: 'approve', comment: 'OK' });
  assert.equal(decided.json.request.status, 'approved');
  assert.equal(decided.json.viewer.canDecide, false);
  assert.equal((await lead.get('/api/approvals?state=done')).json.items[0].decision, 'approve');

  const queue = await op.get('/api/executions?tab=queue');
  const execId = queue.json.items[0].execution.id;
  assert.equal(queue.json.counts.queue, 1);
  const claimed = await op.post(`/api/executions/${execId}/claim`);
  assert.equal(claimed.json.request.status, 'executing');
  assert.equal(claimed.json.viewer.execution.isMine, true);
  for (const d of claimed.json.request.documents) {
    assert.equal((await op.post(`/api/executions/${execId}/documents/${d.id}`, { status: 'done', hashVerified: true })).status, 200);
  }
  const done = await op.post(`/api/executions/${execId}/complete`, { message: 'Released copies placed in the handover folder' });
  assert.equal(done.json.request.status, 'completed');
  assert.deepEqual(done.json.request.documents.map((d) => d.execStatus), ['done', 'done']);

  const mine = await alice.get('/api/requests?scope=mine&counts=true');
  assert.deepEqual(mine.json.counts, { completed: 1 });
  const notes = await alice.get('/api/notifications');
  assert.deepEqual(notes.json.items.map((n) => n.type), ['request_completed', 'request_approved']);
  assert.equal((await alice.post('/api/notifications/read', { all: true })).json.unread, 0);
  const dashboard = await alice.get('/api/dashboard');
  assert.equal(dashboard.json.mine.recent[0].id, id);
  assert.equal(dashboard.json.organisation, undefined, 'organisation-wide numbers are for privileged roles');

  // Someone unrelated cannot see it or even tell that it exists.
  const bob = s.client();
  await bob.login('bob');
  const hidden = await bob.get(`/api/requests/${id}`);
  const missing = await bob.get('/api/requests/req_doesnotexist');
  assert.deepEqual([hidden.status, hidden.json.error.code], [missing.status, missing.json.error.code]);
  assert.equal(hidden.status, 404);
});

function pickFlags(viewer) {
  const { canEdit, canDelete, canCancel, canDecide, canComment } = viewer;
  return { canEdit, canDelete, canCancel, canDecide, canComment };
}

test('malformed requests get clear errors', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = s.client();
  await c.login('alice');
  const cases = [
    [await c.post('/api/requests', '{not json'), 400, 'invalid_json'],
    [await c.post('/api/requests', '[1,2]'), 400, 'invalid_json'],
    [await c.post('/api/requests', 'title=x', { 'Content-Type': 'application/x-www-form-urlencoded' }), 415, 'unsupported_media_type'],
    [await c.post('/api/requests', JSON.stringify({ title: 'x'.repeat(1100 * 1024) })), 413, 'payload_too_large'],
    [await c.get('/api/unknown'), 404, 'unknown_endpoint'],
    [await c.del('/api/session'), 405, 'method_not_allowed'],
    [await c.get('/api/reports/summary?from=garbage'), 403, 'forbidden'],
  ];
  for (const [res, status, code] of cases) assert.deepEqual([res.status, res.json?.error?.code], [status, code]);
});

test('static files: app shell, fallback, and no way out of the public folder', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = s.client();
  const index = await c.get('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /^text\/html/);
  assert.match(index.text, /<div id="app"/);
  const etag = index.headers.get('etag');
  assert.equal((await c.get('/', { 'If-None-Match': etag })).status, 304);
  assert.equal((await c.get('/some/deep/link')).text, index.text, 'unknown paths get the app shell');
  assert.equal((await c.get('/js/missing.js')).status, 404);
  for (const path of ['/%2e%2e/package.json', '/..%2fserver/app.js', '/js/%2e%2e/%2e%2e/server/app.js', '/%2e%2e%5cserver%5capp.js']) {
    const res = await c.get(path);
    assert.ok(res.status === 404 || res.text === index.text, `${path} must not leave the public folder`);
    assert.equal(res.text.includes('createApp'), false);
    assert.equal(res.text.includes('"scripts"'), false);
  }
  assert.equal((await c.post('/')).status, 405);
});

test('audit endpoints: query, verify and export record who used them', async (t) => {
  const s = await setup();
  t.after(s.close);
  const aud = s.client();
  await aud.login('aud');
  const verify = await aud.get('/api/audit/verify');
  assert.equal(verify.json.ok, true);
  const csv = await aud.get('/api/audit/export?format=csv');
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /^attachment; filename="audit-\d{4}-\d\d-\d\d\.csv"$/);
  assert.ok(csv.text.startsWith('﻿seq,ts,'));
  const jsonl = await aud.get('/api/audit/export?format=jsonl');
  const lines = jsonl.text.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].seq, 1);
  assert.match(lines[0].hash, /^[0-9a-f]{64}$/);
  const recent = (await aud.get('/api/audit?limit=3')).json.items.map((e) => e.action);
  assert.deepEqual(recent, ['audit.exported', 'audit.exported', 'audit.verified']);
  assert.ok((await aud.get('/api/audit/actions')).json.items.includes('auth.login'));
});

test('identity from a trusted proxy header signs users in and provisions them', async (t) => {
  const s = await setup({ authMode: 'header', trustProxy: true });
  t.after(s.close);
  const anon = s.client();
  assert.equal((await anon.get('/api/session')).json.user, null);
  assert.equal((await anon.login('alice')).status, 409, 'password sign-in is off in this mode');

  const who = { 'x-forwarded-email': 'alice' };
  const c = s.client();
  const session = await c.get('/api/session', who);
  assert.equal(session.json.user.login, 'alice');
  assert.equal((await c.get('/api/requests', who)).status, 200);
  assert.equal((await c.post('/api/requests', content(), who)).status, 200, 'CSRF token from the session still applies');

  // The same browser arriving as someone else does not inherit the old session.
  const asBob = await c.get('/api/requests', { 'x-forwarded-email': 'bob' });
  assert.equal(asBob.status, 401);
  assert.equal((await c.get('/api/session', { 'x-forwarded-email': 'bob' })).json.user.login, 'bob');

  const fresh = await s.client().get('/api/session', { 'x-forwarded-email': 'new.person@example.com', 'x-forwarded-preferred-username': 'New Person' });
  assert.deepEqual([fresh.json.user.name, fresh.json.user.roles], ['New Person', ['requester']]);
  assert.ok(s.services.audit.query({ action: 'user.provisioned' }).total === 1);
});

test('the proxy header is ignored unless the caller is a listed proxy', async (t) => {
  const s = await setup({ authMode: 'header', trustProxy: true, trustedProxies: ['203.0.113.7'] });
  t.after(s.close);
  const res = await s.client().get('/api/session', { 'x-forwarded-email': 'adm' });
  assert.equal(res.json.user, null);
});

test('policy editing over HTTP: validate, simulate, save', async (t) => {
  const s = await setup();
  t.after(s.close);
  const sec = s.client();
  await sec.login('sec1');
  const current = (await sec.get('/api/policy')).json;
  assert.equal(current.version, 1);
  const draft = structuredClone(current.policy);
  draft.routes[3].stages[0].minApprovals = 9;
  const check = await sec.post('/api/policy/validate', { policy: draft });
  assert.deepEqual(check.json, { valid: false, errors: [{ path: 'routes[3].stages[0].minApprovals', code: 'out_of_range', params: { min: 1, max: 5 } }] });
  assert.equal((await sec.put('/api/policy', { policy: draft, baseVersion: 1 })).status, 422);

  draft.routes[3].stages[0].minApprovals = 1;
  draft.routes[3].stages.push({ name: { en: 'Security' }, approver: { type: 'role', role: 'security' }, minApprovals: 1, slaHours: 12, optional: false });
  const sim = await sec.post('/api/policy/simulate', { policy: draft, sample: { requesterId: s.org.ids.alice, action: 'remove_protection', labelIds: ['internal'], external: false } });
  assert.equal(sim.json.route.id, 'default');
  assert.deepEqual(sim.json.stages.map((st) => st.assignees.map((u) => u.name)), [['Lead'], ['Sec1', 'Sec2']]);
  const saved = await sec.put('/api/policy', { policy: draft, baseVersion: 1, note: 'Security reviews everything' });
  assert.equal(saved.json.version, 2);
  assert.equal((await sec.get('/api/policy/versions')).json.items.length, 2);
  assert.equal((await sec.get('/api/policy/versions/1')).json.policy.routes[3].stages.length, 1);
});
