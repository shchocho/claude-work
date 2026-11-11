// Shared test setup: an app on an in-memory database with a clock the test
// controls, a small organisation, and an HTTP client that behaves like the SPA.
import http from 'node:http';
import { testConfig } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { SYSTEM_ACTOR } from '../server/rbac.js';
import { sha256Hex } from '../server/util.js';

export const PASSWORD = 'Correct-Horse-42';

export function makeClock(start = '2026-03-02T09:00:00.000Z') {
  const clock = {
    t: new Date(start).getTime(),
    now() {
      return new Date(this.t);
    },
    advance({ minutes = 0, hours = 0, days = 0 } = {}) {
      this.t += minutes * 60_000 + hours * 3600_000 + days * 86400_000;
    },
  };
  return clock;
}

export function makeApp(overrides = {}, { fetchImpl } = {}) {
  const config = testConfig(overrides);
  const db = openDatabase(':memory:');
  const clock = makeClock();
  const app = createApp({ config, db, clock, fetchImpl });
  return { app, db, clock, services: app.services };
}

/** A two-level organisation with every role represented. */
export async function makeOrg(ctx) {
  const { users } = ctx.services;
  const division = users.createDepartment(SYSTEM_ACTOR, { name: 'Division' });
  const team = users.createDepartment(SYSTEM_ACTOR, { name: 'Team', parentId: division.id });
  const other = users.createDepartment(SYSTEM_ACTOR, { name: 'Other' });
  const ids = {};
  const add = async (login, roles, departmentId, manager) => {
    const { user } = await users.create(SYSTEM_ACTOR, {
      login, name: login[0].toUpperCase() + login.slice(1), roles, departmentId, managerId: manager ? ids[manager] : null, password: PASSWORD,
    });
    ids[login] = user.id;
  };
  await add('head', ['requester', 'approver'], division.id, null);
  await add('lead', ['requester', 'approver'], team.id, 'head');
  await add('alice', ['requester'], team.id, 'lead');
  await add('bob', ['requester'], team.id, 'lead');
  await add('carol', ['requester'], other.id, null);
  await add('sec1', ['requester', 'security'], other.id, null);
  await add('sec2', ['requester', 'security'], other.id, null);
  await add('op1', ['requester', 'operator'], other.id, null);
  await add('op2', ['operator'], other.id, null);
  await add('aud', ['auditor'], other.id, null);
  await add('adm', ['admin'], other.id, null);
  const as = (login) => users.principalFor(users.rowById(ids[login]), '192.0.2.1');
  return { ids, as, departments: { division: division.id, team: team.id, other: other.id } };
}

export function doc(name, labelId = 'internal', extra = {}) {
  return { name, labelId, location: 'https://files.example/site/' + name, sizeBytes: 1024, sha256: sha256Hex(name), note: '', ...extra };
}

/** Valid request content; override any field. */
export function content(overrides = {}) {
  return {
    title: 'Quarterly report for the archive',
    action: 'remove_protection',
    reasonId: 'archive',
    justification: 'Needed for the records system, which applies its own access control.',
    external: false,
    documents: [doc('report.docx')],
    recipients: [],
    ...overrides,
  };
}

/** Create and submit a request in one go. */
export function submitted(ctx, org, login = 'alice', overrides = {}) {
  const { requests } = ctx.services;
  const draft = requests.createDraft(org.as(login), content(overrides));
  return requests.submit(org.as(login), draft.id, { acknowledged: true });
}

export function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code ?? err.message;
  }
  return null;
}

export function detailsOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.details;
  }
  return null;
}

/** Run the app on an ephemeral port and return a cookie-aware client factory. */
export async function serve(ctx) {
  const server = http.createServer((req, res) => ctx.app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    let csrf = '';
    async function call(method, path, body, headers = {}) {
      const init = { method, headers: { ...headers }, redirect: 'manual' };
      if (cookie) init.headers.Cookie = cookie;
      if (csrf && method !== 'GET' && !('X-CSRF-Token' in init.headers)) init.headers['X-CSRF-Token'] = csrf;
      if (body !== undefined) {
        init.headers['Content-Type'] ??= 'application/json';
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const res = await fetch(base + path, init);
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      // Decode by hand: fetch's own text() would drop the BOM that CSV downloads start with.
      const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // not JSON (static file or download)
      }
      if (json?.csrfToken) csrf = json.csrfToken;
      return { status: res.status, json, text, headers: res.headers };
    }
    return {
      get: (path, headers) => call('GET', path, undefined, headers),
      post: (path, body = {}, headers) => call('POST', path, body, headers),
      put: (path, body = {}, headers) => call('PUT', path, body, headers),
      del: (path, headers) => call('DELETE', path, undefined, headers),
      login: (login, password = PASSWORD) => call('POST', '/api/login', { login, password }),
      forgetCsrf: () => {
        csrf = '';
      },
      get cookie() {
        return cookie;
      },
    };
  }

  return { base, client, close: () => new Promise((resolve) => server.close(resolve)) };
}
