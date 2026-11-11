// People and departments. Users are never deleted, only deactivated, because
// requests, decisions and audit entries keep pointing at them.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fail } from './http.js';
import { isUniqueViolation } from './db.js';
import { ROLES, permissionsForRoles } from './rbac.js';
import { newId, parseJson, escapeLike, clampInt, uniq } from './util.js';

const scrypt = promisify(crypto.scrypt);
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{1,99}$/;
const EMAIL_PATTERN = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
const LOCALES = ['ko', 'en'];

export function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN.test(value);
}

export async function hashPassword(password, params) {
  const { N, r, p } = params;
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 64, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger)) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  try {
    const key = await scrypt(String(password).normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

export function passwordNeedsRehash(stored, params) {
  const parts = String(stored ?? '').split('$');
  return parts.length !== 6 || Number(parts[1]) !== params.N || Number(parts[2]) !== params.r || Number(parts[3]) !== params.p;
}

/** A temporary password that is easy to read out and type: no look-alike characters. */
export function generatePassword(length = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

export function createUsers({ db, clock, audit, config }) {
  const now = () => clock.now().toISOString();

  // ----- departments -------------------------------------------------------

  function departmentById(id) {
    return id ? db.get('SELECT * FROM departments WHERE id = ?', id) : null;
  }

  function publicDepartment(row) {
    return { id: row.id, name: row.name, parentId: row.parent_id, active: Boolean(row.active) };
  }

  function listDepartments({ includeInactive = false } = {}) {
    const rows = db.all(`SELECT * FROM departments ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name COLLATE NOCASE`);
    return rows.map(publicDepartment);
  }

  /** The department and everything above it, nearest first. */
  function departmentChain(id) {
    const chain = [];
    const seen = new Set();
    let current = departmentById(id);
    while (current && !seen.has(current.id)) {
      chain.push(current);
      seen.add(current.id);
      current = departmentById(current.parent_id);
    }
    return chain;
  }

  function checkDepartmentInput(input, selfId) {
    const errors = [];
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) errors.push({ field: 'name', code: 'required' });
    else if (name.length > 80) errors.push({ field: 'name', code: 'too_long', params: { max: 80 } });
    const parentId = input.parentId || null;
    if (parentId) {
      if (!departmentById(parentId)) errors.push({ field: 'parentId', code: 'unknown_department' });
      else if (selfId && departmentChain(parentId).some((d) => d.id === selfId)) {
        errors.push({ field: 'parentId', code: 'cycle' });
      }
    }
    if (errors.length) throw fail.invalid(errors);
    return { name, parentId };
  }

  function createDepartment(actor, input) {
    const { name, parentId } = checkDepartmentInput(input, null);
    return db.tx(() => {
      const id = newId('dep');
      db.run('INSERT INTO departments (id, name, parent_id, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)', id, name, parentId, now(), now());
      audit.append(actor, 'department.created', { entityType: 'department', entityId: id, details: { name, parentId } });
      return publicDepartment(departmentById(id));
    });
  }

  function updateDepartment(actor, id, input) {
    const existing = departmentById(id);
    if (!existing) throw fail.notFound();
    const { name, parentId } = checkDepartmentInput({ name: input.name ?? existing.name, parentId: input.parentId === undefined ? existing.parent_id : input.parentId }, id);
    const active = input.active === undefined ? Boolean(existing.active) : Boolean(input.active);
    return db.tx(() => {
      db.run('UPDATE departments SET name = ?, parent_id = ?, active = ?, updated_at = ? WHERE id = ?', name, parentId, active, now(), id);
      audit.append(actor, 'department.updated', {
        entityType: 'department',
        entityId: id,
        details: { before: { name: existing.name, parentId: existing.parent_id, active: Boolean(existing.active) }, after: { name, parentId, active } },
      });
      return publicDepartment(departmentById(id));
    });
  }

  // ----- users -------------------------------------------------------------

  function rowById(id) {
    return id ? db.get('SELECT * FROM users WHERE id = ?', id) : null;
  }

  function rowByLogin(login) {
    return login ? db.get('SELECT * FROM users WHERE login = ?', String(login).trim()) : null;
  }

  function rolesOf(row) {
    return parseJson(row.roles, []).filter((r) => ROLES.includes(r));
  }

  /** What other signed-in users may see about a person. */
  function brief(row) {
    if (!row) return null;
    const department = departmentById(row.department_id);
    return {
      id: row.id,
      name: row.name,
      title: row.title ?? '',
      departmentId: row.department_id,
      departmentName: department?.name ?? '',
      active: Boolean(row.active),
    };
  }

  function briefById(id) {
    return brief(rowById(id));
  }

  function full(row) {
    if (!row) return null;
    const manager = rowById(row.manager_id);
    const roles = rolesOf(row);
    return {
      ...brief(row),
      login: row.login,
      email: row.email ?? '',
      managerId: row.manager_id,
      managerName: manager?.name ?? '',
      roles,
      permissions: permissionsForRoles(roles),
      locale: row.locale ?? null,
      hasPassword: Boolean(row.password_hash),
      mustChangePassword: Boolean(row.must_change_password),
      lockedUntil: row.locked_until,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function principalFor(row, ip) {
    const roles = rolesOf(row);
    return {
      type: 'user',
      id: row.id,
      label: `${row.name} <${row.login}>`,
      ip: ip ?? null,
      roles,
      permissions: permissionsForRoles(roles),
      user: row,
    };
  }

  function managerChain(userId) {
    const chain = [];
    const seen = new Set([userId]);
    let current = rowById(rowById(userId)?.manager_id);
    while (current && !seen.has(current.id)) {
      chain.push(current);
      seen.add(current.id);
      current = rowById(current.manager_id);
    }
    return chain;
  }

  function activeWithRole(role) {
    return db
      .all('SELECT * FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE')
      .filter((row) => rolesOf(row).includes(role));
  }

  function activeAdminCount(excludingId) {
    return activeWithRole('admin').filter((u) => u.id !== excludingId).length;
  }

  function normalizeInput(input, existing) {
    const errors = [];
    const out = {};
    const text = (field, max, { required = false } = {}) => {
      if (input[field] === undefined) return existing ? undefined : required ? (errors.push({ field, code: 'required' }), undefined) : '';
      if (typeof input[field] !== 'string') {
        errors.push({ field, code: 'invalid' });
        return undefined;
      }
      const value = input[field].trim();
      if (required && !value) errors.push({ field, code: 'required' });
      else if (value.length > max) errors.push({ field, code: 'too_long', params: { max } });
      return value;
    };

    if (!existing) {
      const login = typeof input.login === 'string' ? input.login.trim() : '';
      if (!login) errors.push({ field: 'login', code: 'required' });
      else if (!LOGIN_PATTERN.test(login)) errors.push({ field: 'login', code: 'invalid_login' });
      out.login = login;
    }
    out.name = text('name', 80, { required: true });
    out.title = text('title', 80);
    const email = text('email', 254);
    if (email) {
      if (!isEmail(email)) errors.push({ field: 'email', code: 'invalid_email' });
    }
    out.email = email;

    if (input.departmentId !== undefined) {
      out.departmentId = input.departmentId || null;
      if (out.departmentId && !departmentById(out.departmentId)) errors.push({ field: 'departmentId', code: 'unknown_department' });
    } else if (!existing) out.departmentId = null;

    if (input.managerId !== undefined) {
      out.managerId = input.managerId || null;
      if (out.managerId) {
        const manager = rowById(out.managerId);
        if (!manager) errors.push({ field: 'managerId', code: 'unknown_user' });
        else if (existing && (manager.id === existing.id || managerChain(manager.id).some((m) => m.id === existing.id))) {
          errors.push({ field: 'managerId', code: 'cycle' });
        }
      }
    } else if (!existing) out.managerId = null;

    if (input.roles !== undefined) {
      if (!Array.isArray(input.roles) || input.roles.some((r) => !ROLES.includes(r))) {
        errors.push({ field: 'roles', code: 'invalid_roles' });
      } else out.roles = uniq(input.roles).sort((a, b) => ROLES.indexOf(a) - ROLES.indexOf(b));
    } else if (!existing) out.roles = ['requester'];

    if (input.active !== undefined) out.active = Boolean(input.active);
    else if (!existing) out.active = true;

    if (input.locale !== undefined) {
      out.locale = input.locale || null;
      if (out.locale && !LOCALES.includes(out.locale)) errors.push({ field: 'locale', code: 'invalid' });
    }
    return { out, errors };
  }

  function checkPasswordPolicy(password, login) {
    const errors = [];
    if (typeof password !== 'string' || password.length < config.passwordMinLength) {
      errors.push({ field: 'password', code: 'password_too_short', params: { min: config.passwordMinLength } });
    } else if (password.length > 200) {
      errors.push({ field: 'password', code: 'too_long', params: { max: 200 } });
    } else if (login && password.toLowerCase().includes(String(login).toLowerCase())) {
      errors.push({ field: 'password', code: 'password_contains_login' });
    } else if (new Set(password).size < 5) {
      errors.push({ field: 'password', code: 'password_too_simple' });
    }
    return errors;
  }

  /** Create an account. Without a password a temporary one is generated and returned once. */
  async function create(actor, input) {
    const { out, errors } = normalizeInput(input, null);
    let password = input.password;
    let temporary = false;
    if (input.passwordless) password = null;
    else if (password === undefined || password === null || password === '') {
      password = generatePassword();
      temporary = true;
    } else errors.push(...checkPasswordPolicy(password, out.login));
    if (errors.length) throw fail.invalid(errors);
    if (rowByLogin(out.login)) throw fail.invalid([{ field: 'login', code: 'login_taken' }]);

    const passwordHash = password ? await hashPassword(password, config.scrypt) : null;
    const id = newId('usr');
    try {
      db.tx(() => {
        db.run(
          `INSERT INTO users (id, login, name, email, title, department_id, manager_id, roles, password_hash, must_change_password, active, locale, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, out.login, out.name, out.email || null, out.title || null, out.departmentId, out.managerId,
          JSON.stringify(out.roles), passwordHash, temporary || Boolean(input.mustChangePassword), out.active, out.locale ?? null, now(), now(),
        );
        audit.append(actor, 'user.created', {
          entityType: 'user',
          entityId: id,
          details: { login: out.login, name: out.name, roles: out.roles, departmentId: out.departmentId, managerId: out.managerId },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw fail.invalid([{ field: 'login', code: 'login_taken' }]);
      throw err;
    }
    return { user: full(rowById(id)), temporaryPassword: temporary ? password : undefined };
  }

  function update(actor, id, input) {
    const existing = rowById(id);
    if (!existing) throw fail.notFound();
    const { out, errors } = normalizeInput(input, existing);
    if (errors.length) throw fail.invalid(errors);

    const beforeRoles = rolesOf(existing);
    const nextRoles = out.roles ?? beforeRoles;
    const nextActive = out.active ?? Boolean(existing.active);
    const losingAdmin = beforeRoles.includes('admin') && existing.active && (!nextRoles.includes('admin') || !nextActive);
    if (losingAdmin && activeAdminCount(id) === 0) throw fail.conflict('last_admin', 'At least one active administrator is required');
    if (actor.type === 'user' && actor.id === id && !nextActive) throw fail.conflict('cannot_deactivate_self');

    const next = {
      name: out.name ?? existing.name,
      email: out.email === undefined ? existing.email : out.email || null,
      title: out.title === undefined ? existing.title : out.title || null,
      departmentId: out.departmentId === undefined ? existing.department_id : out.departmentId,
      managerId: out.managerId === undefined ? existing.manager_id : out.managerId,
      roles: nextRoles,
      active: nextActive,
      locale: out.locale === undefined ? existing.locale : out.locale,
    };
    const before = {
      name: existing.name,
      email: existing.email,
      title: existing.title,
      departmentId: existing.department_id,
      managerId: existing.manager_id,
      roles: beforeRoles,
      active: Boolean(existing.active),
      locale: existing.locale,
    };
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    if (!changed.length) return full(existing);

    return db.tx(() => {
      db.run(
        `UPDATE users SET name = ?, email = ?, title = ?, department_id = ?, manager_id = ?, roles = ?, active = ?, locale = ?, updated_at = ? WHERE id = ?`,
        next.name, next.email, next.title, next.departmentId, next.managerId, JSON.stringify(next.roles), next.active, next.locale, now(), id,
      );
      if (!next.active) db.run('DELETE FROM sessions WHERE user_id = ?', id);
      const diff = {};
      for (const key of changed) diff[key] = { from: before[key], to: next[key] };
      const action = changed.includes('roles') ? 'user.roles_changed' : changed.includes('active') ? (next.active ? 'user.activated' : 'user.deactivated') : 'user.updated';
      audit.append(actor, action, { entityType: 'user', entityId: id, details: { login: existing.login, changes: diff } });
      return full(rowById(id));
    });
  }

  async function resetPassword(actor, id) {
    const existing = rowById(id);
    if (!existing) throw fail.notFound();
    const password = generatePassword();
    const passwordHash = await hashPassword(password, config.scrypt);
    db.tx(() => {
      db.run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', passwordHash, now(), id);
      db.run('DELETE FROM sessions WHERE user_id = ?', id);
      audit.append(actor, 'user.password_reset', { entityType: 'user', entityId: id, details: { login: existing.login } });
    });
    return { temporaryPassword: password };
  }

  /** Change your own password. Other sessions of the same user are signed out. */
  async function changeOwnPassword(actor, current, next, keepSessionHash) {
    const row = rowById(actor.id);
    if (!row || !row.password_hash) throw fail.conflict('password_not_supported');
    if (!(await verifyPassword(String(current ?? ''), row.password_hash))) {
      throw fail.invalid([{ field: 'current', code: 'wrong_password' }]);
    }
    const errors = checkPasswordPolicy(next, row.login);
    if (!errors.length && next === current) errors.push({ field: 'password', code: 'password_unchanged' });
    if (errors.length) throw fail.invalid(errors);
    const passwordHash = await hashPassword(next, config.scrypt);
    db.tx(() => {
      db.run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', passwordHash, now(), row.id);
      db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', row.id, keepSessionHash ?? '');
      audit.append(actor, 'user.password_changed', { entityType: 'user', entityId: row.id });
    });
  }

  function setLocale(actor, locale) {
    if (!LOCALES.includes(locale)) throw fail.invalid([{ field: 'locale', code: 'invalid' }]);
    db.run('UPDATE users SET locale = ?, updated_at = ? WHERE id = ?', locale, now(), actor.id);
    return full(rowById(actor.id));
  }

  function list(filters = {}) {
    const where = [];
    const params = [];
    if (filters.q) {
      const like = '%' + escapeLike(String(filters.q).slice(0, 80)) + '%';
      where.push("(u.name LIKE ? ESCAPE '\\' OR u.login LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    if (filters.departmentId) {
      where.push('u.department_id = ?');
      params.push(String(filters.departmentId));
    }
    if (filters.active === 'true' || filters.active === 'false') {
      where.push('u.active = ?');
      params.push(filters.active === 'true');
    }
    let rows = db.all(`SELECT u.* FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.name COLLATE NOCASE, u.login`, ...params);
    if (filters.role && ROLES.includes(filters.role)) rows = rows.filter((row) => rolesOf(row).includes(filters.role));
    const pageSize = clampInt(filters.pageSize, 50, 1, 200);
    const page = clampInt(filters.page, 1, 1, 100000);
    return {
      items: rows.slice((page - 1) * pageSize, page * pageSize).map(full),
      total: rows.length,
      page,
      pageSize,
    };
  }

  /** Name lookup for pickers (delegate, reassignment, manager). Active users only. */
  function directory(q, limit = 20) {
    const text = String(q ?? '').trim().slice(0, 80);
    const like = '%' + escapeLike(text) + '%';
    return db
      .all(
        `SELECT * FROM users WHERE active = 1 AND (name LIKE ? ESCAPE '\\' OR login LIKE ? ESCAPE '\\')
         ORDER BY name COLLATE NOCASE LIMIT ?`,
        like, like, clampInt(limit, 20, 1, 50),
      )
      .map((row) => ({ ...brief(row), login: row.login }));
  }

  function count() {
    return db.get('SELECT count(*) AS n FROM users').n;
  }

  return {
    departmentById,
    listDepartments,
    departmentChain,
    createDepartment,
    updateDepartment,
    rowById,
    rowByLogin,
    rolesOf,
    brief,
    briefById,
    full,
    principalFor,
    managerChain,
    activeWithRole,
    create,
    update,
    resetPassword,
    changeOwnPassword,
    checkPasswordPolicy,
    setLocale,
    list,
    directory,
    count,
  };
}
