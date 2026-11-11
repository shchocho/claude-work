// Sign-in, sessions and API tokens.
import { fail, parseCookies, serializeCookie, isSecureRequest, fromTrustedProxy } from './http.js';
import { hashPassword, verifyPassword, passwordNeedsRehash } from './users.js';
import { TOKEN_SCOPES, permissionsForScopes } from './rbac.js';
import { newId, randomToken, sha256Hex, parseJson, addHours, addMinutes, addDays } from './util.js';

export const SESSION_COOKIE = 'mrc_sid';
const TOKEN_PREFIX = 'mrc_';
const IP_WINDOW_MS = 5 * 60_000;
const IP_MAX_ATTEMPTS = 30;

export function createAuth({ db, clock, audit, config, users }) {
  const now = () => clock.now();
  const attemptsByIp = new Map();
  const failuresByUnknownLogin = new Map();
  let dummyHash = null;

  function noteIpAttempt(ip) {
    const t = now().getTime();
    if (attemptsByIp.size > 5000) {
      for (const [key, times] of attemptsByIp) {
        if (!times.some((x) => x > t - IP_WINDOW_MS)) attemptsByIp.delete(key);
      }
    }
    const times = (attemptsByIp.get(ip) ?? []).filter((x) => x > t - IP_WINDOW_MS);
    if (times.length >= IP_MAX_ATTEMPTS) {
      throw fail.tooMany(Math.ceil((times[0] + IP_WINDOW_MS - t) / 1000));
    }
    times.push(t);
    attemptsByIp.set(ip, times);
  }

  function createSession(userId, { ip, userAgent }) {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const at = now();
    db.run(
      'INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      sha256Hex(token), userId, csrfToken, at.toISOString(), at.toISOString(),
      addHours(at, config.sessionMaxHours).toISOString(), ip ?? null, String(userAgent ?? '').slice(0, 300),
    );
    return { token, csrfToken };
  }

  function resolveSession(token) {
    if (!token) return null;
    const tokenHash = sha256Hex(token);
    const session = db.get('SELECT * FROM sessions WHERE token_hash = ?', tokenHash);
    if (!session) return null;
    const at = now();
    const idleLimit = addMinutes(session.last_seen_at, config.sessionIdleMinutes);
    if (at >= new Date(session.expires_at) || at >= idleLimit) {
      db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
      return null;
    }
    const user = users.rowById(session.user_id);
    if (!user || !user.active) {
      db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
      return null;
    }
    if (at.getTime() - new Date(session.last_seen_at).getTime() > 60_000) {
      db.run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', at.toISOString(), tokenHash);
    }
    return { tokenHash, csrfToken: session.csrf_token, user, expiresAt: session.expires_at };
  }

  function sessionCookie(req, token) {
    const secure = config.cookieSecure === 'true' || (config.cookieSecure === 'auto' && isSecureRequest(req, config));
    return serializeCookie(SESSION_COOKIE, token, { secure, maxAge: token ? config.sessionMaxHours * 3600 : 0 });
  }

  function sessionTokenFrom(req) {
    return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
  }

  async function login({ login, password }, { ip, userAgent }) {
    if (config.authMode !== 'local') throw fail.conflict('local_login_disabled');
    if (typeof login !== 'string' || typeof password !== 'string' || !login.trim() || !password) {
      throw fail.invalid([{ field: 'login', code: 'required' }]);
    }
    noteIpAttempt(ip ?? 'unknown');
    const name = login.trim().slice(0, 100);
    const key = name.toLowerCase();
    const at = now();
    const row = users.rowByLogin(name);

    if (row?.locked_until && new Date(row.locked_until) > at) {
      throw fail.tooMany(Math.ceil((new Date(row.locked_until) - at) / 1000));
    }
    const unknown = failuresByUnknownLogin.get(key);
    if (!row && unknown?.lockedUntil > at.getTime()) {
      throw fail.tooMany(Math.ceil((unknown.lockedUntil - at.getTime()) / 1000));
    }

    // Verify against a throwaway hash when there is no account, so response time
    // does not reveal which logins exist.
    dummyHash ??= await hashPassword(randomToken(12), config.scrypt);
    const ok = await verifyPassword(password, row?.password_hash ?? dummyHash);

    if (!row || !row.password_hash || !ok || !row.active) {
      const reason = !row ? 'unknown_login' : !row.active ? 'inactive' : 'wrong_password';
      if (row) {
        const failures = row.failed_logins + 1;
        const lock = failures >= config.loginMaxFailures;
        db.tx(() => {
          db.run(
            'UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?',
            lock ? 0 : failures, lock ? addMinutes(at, config.loginLockMinutes).toISOString() : row.locked_until, row.id,
          );
          audit.append({ type: 'user', id: row.id, label: `${row.name} <${row.login}>`, ip }, 'auth.login_failed', {
            entityType: 'user', entityId: row.id, details: { reason, locked: lock },
          });
        });
      } else {
        if (failuresByUnknownLogin.size > 5000) failuresByUnknownLogin.clear();
        const entry = unknown ?? { count: 0, lockedUntil: 0 };
        entry.count += 1;
        if (entry.count >= config.loginMaxFailures) {
          entry.count = 0;
          entry.lockedUntil = at.getTime() + config.loginLockMinutes * 60_000;
        }
        failuresByUnknownLogin.set(key, entry);
        audit.append({ type: 'system', id: null, label: 'anonymous', ip }, 'auth.login_failed', { details: { reason, login: name } });
      }
      throw fail.unauthorized('invalid_credentials', 'Login or password is incorrect');
    }

    const upgraded = passwordNeedsRehash(row.password_hash, config.scrypt) ? await hashPassword(password, config.scrypt) : null;
    const session = db.tx(() => {
      db.run(
        'UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ?, password_hash = COALESCE(?, password_hash) WHERE id = ?',
        at.toISOString(), upgraded, row.id,
      );
      const created = createSession(row.id, { ip, userAgent });
      audit.append({ type: 'user', id: row.id, label: `${row.name} <${row.login}>`, ip }, 'auth.login', { entityType: 'user', entityId: row.id });
      return created;
    });
    return { ...session, user: users.rowById(row.id) };
  }

  function logout(session, actor) {
    db.tx(() => {
      db.run('DELETE FROM sessions WHERE token_hash = ?', session.tokenHash);
      audit.append(actor, 'auth.logout', { entityType: 'user', entityId: actor.id });
    });
  }

  /** Identity asserted by the reverse proxy (header mode). Returns a user row or null. */
  function proxyIdentity(req) {
    if (config.authMode !== 'header' || !fromTrustedProxy(req, config)) return null;
    const value = String(req.headers[config.authHeader] ?? '').trim();
    if (!value || value.length > 100) return null;
    let row = users.rowByLogin(value);
    if (!row && config.ssoAutoProvision && /^[A-Za-z0-9][A-Za-z0-9._@+-]{1,99}$/.test(value)) {
      const displayName = String(req.headers[config.authNameHeader] ?? '').trim().slice(0, 80) || value.split('@')[0];
      const id = newId('usr');
      const at = now().toISOString();
      db.tx(() => {
        db.run(
          `INSERT INTO users (id, login, name, email, roles, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          id, value, displayName, value.includes('@') ? value : null, JSON.stringify(['requester']), at, at,
        );
        audit.append({ type: 'system', id: null, label: 'sso', ip: null }, 'user.provisioned', {
          entityType: 'user', entityId: id, details: { login: value, name: displayName },
        });
      });
      row = users.rowById(id);
    }
    return row && row.active ? row : null;
  }

  function startProxySession(row, { ip, userAgent }) {
    return db.tx(() => {
      db.run('UPDATE users SET last_login_at = ? WHERE id = ?', now().toISOString(), row.id);
      const created = createSession(row.id, { ip, userAgent });
      audit.append({ type: 'user', id: row.id, label: `${row.name} <${row.login}>`, ip }, 'auth.login', {
        entityType: 'user', entityId: row.id, details: { via: 'proxy' },
      });
      return created;
    });
  }

  // ----- API tokens --------------------------------------------------------

  function publicToken(row) {
    return {
      id: row.id,
      name: row.name,
      hint: row.token_hint,
      scopes: parseJson(row.scopes, []),
      createdBy: users.briefById(row.created_by)?.name ?? '',
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    };
  }

  function createToken(actor, input) {
    const errors = [];
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) errors.push({ field: 'name', code: 'required' });
    else if (name.length > 80) errors.push({ field: 'name', code: 'too_long', params: { max: 80 } });
    const scopes = Array.isArray(input.scopes) ? [...new Set(input.scopes)] : [];
    if (!scopes.length || scopes.some((s) => !(s in TOKEN_SCOPES))) errors.push({ field: 'scopes', code: 'invalid_scopes' });
    let expiresAt = null;
    if (input.expiresInDays !== undefined && input.expiresInDays !== null && input.expiresInDays !== '') {
      const days = Number(input.expiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > 3650) errors.push({ field: 'expiresInDays', code: 'out_of_range', params: { min: 1, max: 3650 } });
      else expiresAt = addDays(now(), days).toISOString();
    }
    if (errors.length) throw fail.invalid(errors);
    const secret = TOKEN_PREFIX + randomToken(30);
    const id = newId('tok');
    db.tx(() => {
      db.run(
        'INSERT INTO api_tokens (id, name, token_hash, token_hint, scopes, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, name, sha256Hex(secret), secret.slice(-4), JSON.stringify(scopes), actor.id, now().toISOString(), expiresAt,
      );
      audit.append(actor, 'token.created', { entityType: 'token', entityId: id, details: { name, scopes, expiresAt } });
    });
    return { token: publicToken(db.get('SELECT * FROM api_tokens WHERE id = ?', id)), secret };
  }

  function listTokens() {
    return db.all('SELECT * FROM api_tokens ORDER BY created_at DESC').map(publicToken);
  }

  function revokeToken(actor, id) {
    const row = db.get('SELECT * FROM api_tokens WHERE id = ?', id);
    if (!row) throw fail.notFound();
    if (row.revoked_at) return publicToken(row);
    db.tx(() => {
      db.run('UPDATE api_tokens SET revoked_at = ? WHERE id = ?', now().toISOString(), id);
      audit.append(actor, 'token.revoked', { entityType: 'token', entityId: id, details: { name: row.name } });
    });
    return publicToken(db.get('SELECT * FROM api_tokens WHERE id = ?', id));
  }

  function resolveToken(header, ip) {
    const match = /^Bearer\s+(\S+)$/i.exec(String(header ?? ''));
    if (!match) return null;
    if (!match[1].startsWith(TOKEN_PREFIX)) throw fail.unauthorized('invalid_token');
    const row = db.get('SELECT * FROM api_tokens WHERE token_hash = ?', sha256Hex(match[1]));
    const at = now();
    if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at) <= at)) throw fail.unauthorized('invalid_token');
    if (!row.last_used_at || at.getTime() - new Date(row.last_used_at).getTime() > 60_000) {
      db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', at.toISOString(), row.id);
    }
    const scopes = parseJson(row.scopes, []);
    return {
      type: 'token',
      id: row.id,
      label: `token:${row.name}`,
      ip: ip ?? null,
      roles: [],
      scopes,
      permissions: permissionsForScopes(scopes),
      user: null,
    };
  }

  function purgeExpiredSessions() {
    const at = now();
    const idleCutoff = addMinutes(at, -config.sessionIdleMinutes).toISOString();
    return db.run('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?', at.toISOString(), idleCutoff).changes;
  }

  function sessionCount() {
    return db.get('SELECT count(*) AS n FROM sessions').n;
  }

  return {
    login,
    logout,
    createSession,
    resolveSession,
    sessionCookie,
    sessionTokenFrom,
    proxyIdentity,
    startProxySession,
    createToken,
    listTokens,
    revokeToken,
    resolveToken,
    purgeExpiredSessions,
    sessionCount,
  };
}
