// SQLite access through Node's built-in driver. All calls are synchronous, so a
// transaction body runs without interleaving with other requests as long as it
// never awaits; tx() enforces that.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  {
    version: 1,
    sql: `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES departments(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  email TEXT,
  title TEXT,
  department_id TEXT REFERENCES departments(id),
  manager_id TEXT REFERENCES users(id),
  roles TEXT NOT NULL DEFAULT '[]',
  password_hash TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  locale TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX users_department ON users(department_id);
CREATE INDEX users_manager ON users(manager_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
) WITHOUT ROWID;
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE delegations (
  id TEXT PRIMARY KEY,
  from_user_id TEXT NOT NULL REFERENCES users(id),
  to_user_id TEXT NOT NULL REFERENCES users(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX delegations_to ON delegations(to_user_id, ends_at);
CREATE INDEX delegations_from ON delegations(from_user_id, ends_at);

CREATE TABLE policy_versions (
  version INTEGER PRIMARY KEY,
  policy TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_by_label TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID;

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  number TEXT UNIQUE,
  requester_id TEXT NOT NULL REFERENCES users(id),
  department_id TEXT REFERENCES departments(id),
  title TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  target_label_id TEXT,
  reason_id TEXT,
  justification TEXT NOT NULL DEFAULT '',
  external INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  acknowledged_at TEXT,
  status TEXT NOT NULL,
  status_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  current_stage_id TEXT,
  top_label_id TEXT,
  top_label_rank INTEGER,
  document_count INTEGER NOT NULL DEFAULT 0,
  route_id TEXT,
  policy_version INTEGER,
  approval_valid_until TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  decided_at TEXT,
  completed_at TEXT,
  closed_at TEXT
);
CREATE INDEX requests_requester ON requests(requester_id, created_at);
CREATE INDEX requests_status ON requests(status, updated_at);
CREATE INDEX requests_submitted ON requests(submitted_at);

CREATE TABLE request_documents (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  location TEXT,
  label_id TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  note TEXT,
  exec_status TEXT NOT NULL DEFAULT 'pending',
  exec_note TEXT,
  exec_hash_verified INTEGER,
  exec_at TEXT,
  exec_by TEXT
);
CREATE INDEX request_documents_request ON request_documents(request_id, position);
CREATE INDEX request_documents_sha ON request_documents(sha256);

CREATE TABLE request_recipients (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  organization TEXT NOT NULL,
  name TEXT,
  email TEXT
);
CREATE INDEX request_recipients_request ON request_recipients(request_id, position);

CREATE TABLE request_stages (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  approver_spec TEXT NOT NULL,
  min_approvals INTEGER NOT NULL DEFAULT 1,
  sla_hours INTEGER,
  status TEXT NOT NULL,
  note TEXT,
  activated_at TEXT,
  due_at TEXT,
  completed_at TEXT,
  overdue_notified_at TEXT
);
CREATE INDEX request_stages_request ON request_stages(request_id, revision, position);
CREATE INDEX request_stages_status ON request_stages(status, due_at);

CREATE TABLE stage_assignees (
  stage_id TEXT NOT NULL REFERENCES request_stages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (stage_id, user_id)
) WITHOUT ROWID;
CREATE INDEX stage_assignees_user ON stage_assignees(user_id);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL REFERENCES request_stages(id) ON DELETE CASCADE,
  approver_id TEXT NOT NULL REFERENCES users(id),
  seat_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (stage_id, approver_id),
  UNIQUE (stage_id, seat_id)
);
CREATE INDEX decisions_request ON decisions(request_id, created_at);
CREATE INDEX decisions_approver ON decisions(approver_id, created_at);

CREATE TABLE request_cc (
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (request_id, user_id)
) WITHOUT ROWID;
CREATE INDEX request_cc_user ON request_cc(user_id);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX comments_request ON comments(request_id, created_at);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  operator_id TEXT REFERENCES users(id),
  external_ref TEXT,
  message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX executions_request ON executions(request_id, attempt);
CREATE INDEX executions_status ON executions(status, created_at);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  request_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, read_at, created_at);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX outbox_due ON outbox(status, next_attempt_at);

CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_label TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  request_id TEXT,
  ip TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX audit_request ON audit_log(request_id, seq);
CREATE INDEX audit_action ON audit_log(action, seq);
CREATE INDEX audit_actor ON audit_log(actor_id, seq);
CREATE INDEX audit_ts ON audit_log(ts);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`,
  },
];

function bindable(value, index) {
  if (value === undefined) throw new TypeError(`SQL parameter ${index + 1} is undefined`);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

export class Db {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.statements = new Map();
    this.depth = 0;
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  migrate() {
    const current = this.raw.prepare('PRAGMA user_version').get().user_version;
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        this.raw.exec(m.sql);
        this.raw.exec(`PRAGMA user_version = ${m.version}`);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }

  prepare(sql) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  run(sql, ...params) {
    return this.prepare(sql).run(...params.map(bindable));
  }

  get(sql, ...params) {
    return this.prepare(sql).get(...params.map(bindable)) ?? null;
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...params.map(bindable));
  }

  /** Run fn atomically. Nested calls join the outer transaction through a savepoint. */
  tx(fn) {
    const outer = this.depth === 0;
    const savepoint = `sp_${this.depth}`;
    this.raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth += 1;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        throw new Error('tx() callback must be synchronous');
      }
      this.depth -= 1;
      this.raw.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      this.depth -= 1;
      this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw err;
    }
  }

  getMeta(key, fallback = null) {
    const row = this.get('SELECT value FROM meta WHERE key = ?', key);
    return row ? row.value : fallback;
  }

  setMeta(key, value) {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }

  /** Consistent copy of the database into a new file (for backups). */
  backupTo(target) {
    if (fs.existsSync(target)) throw new Error(`Backup target already exists: ${target}`);
    this.raw.prepare('VACUUM INTO ?').run(target);
  }

  close() {
    this.statements.clear();
    this.raw.close();
  }
}

export function openDatabase(file) {
  return new Db(file);
}

/** SQLite reports a UNIQUE violation with extended code 2067 (1555 for primary keys). */
export function isUniqueViolation(err) {
  return err?.code === 'ERR_SQLITE_ERROR' && (err.errcode === 2067 || err.errcode === 1555);
}
