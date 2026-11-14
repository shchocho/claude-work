import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEMO_USERS } from './consts.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dept TEXT NOT NULL,
  title TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL
);

-- 암호화 해제 기록: 해제자 · 해제 일시 · 해제 파일 원본
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_dept TEXT NOT NULL,
  protected_name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  label_id TEXT NOT NULL,
  label_owner TEXT,
  protected_at TEXT,
  recipient_type TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  released_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  protected_sha256 TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  protected_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  adapter TEXT NOT NULL,
  device TEXT
);
CREATE INDEX IF NOT EXISTS idx_releases_user ON releases (user_id, released_at);

-- 송부 기록: 파일 원본 · 파일명 · 송부자 · 송부 일시
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL UNIQUE,
  release_id TEXT NOT NULL REFERENCES releases (id),
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_dept TEXT NOT NULL,
  file_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  file_sha256 TEXT NOT NULL,
  hash_match INTEGER NOT NULL,
  stored_path TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_detail TEXT NOT NULL,
  recipient_type TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  captured_offline INTEGER NOT NULL DEFAULT 0,
  device TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',
  review_note TEXT,
  reviewer_id TEXT,
  reviewer_name TEXT,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_transfers_user ON transfers (user_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_transfers_release ON transfers (release_id);

-- 해시 체인으로 연결한 감사 이벤트. 앞 이벤트의 해시를 다음 이벤트가 품는다.
CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
`;

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'center.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count === 0) {
    const insert = db.prepare('INSERT INTO users (id, name, dept, title, email, role) VALUES (?, ?, ?, ?, ?, ?)');
    for (const u of DEMO_USERS) insert.run(u.id, u.name, u.dept, u.title, u.email, u.role);
  }
  return db;
}

/** 여러 쓰기를 한 트랜잭션으로 묶는다. 중간에 실패하면 전부 되돌린다. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
