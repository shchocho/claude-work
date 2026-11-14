import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CHANNELS, LABELS, MEDIA_TYPES, RECIPIENT_TYPES, REVIEW_STATUSES } from './consts.js';
import { transaction } from './db.js';
import { HttpError } from './http.js';

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;

function text(value, { field, min = 0, max }) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v.length < min) {
    throw new HttpError(400, 'INVALID', min > 1 ? `${field}: ${min}자 이상 입력해 주세요.` : `${field}: 내용을 입력해 주세요.`);
  }
  if (v.length > max) throw new HttpError(400, 'INVALID', `${field}: ${max}자까지 입력할 수 있습니다.`);
  return v;
}

function oneOf(value, table, field) {
  if (typeof value !== 'string' || !Object.hasOwn(table, value)) {
    throw new HttpError(400, 'INVALID', `${field}: 항목을 선택해 주세요.`);
  }
  return value;
}

function dayStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${String(date.getFullYear()).slice(2)}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

export function createServices({ db, config, mip, mail, audit }) {
  const vaultDir = path.join(config.dataDir, 'vault');

  function store(relativePath, buffer) {
    const file = path.join(config.dataDir, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
  }

  function load(relativePath) {
    const file = path.normalize(path.join(config.dataDir, relativePath));
    if (!file.startsWith(vaultDir + path.sep)) throw new HttpError(500, 'STORAGE', '보관 파일 경로가 올바르지 않습니다.');
    try {
      return fs.readFileSync(file);
    } catch {
      throw new HttpError(500, 'STORAGE', '보관된 파일을 찾을 수 없습니다. 정보보호팀에 문의해 주세요.');
    }
  }

  function nextCode(prefix, table, at) {
    const stem = `${prefix}-${dayStamp(at)}-`;
    const row = db.prepare(`SELECT code FROM ${table} WHERE code LIKE ? ORDER BY code DESC LIMIT 1`).get(`${stem}%`);
    const next = row ? Number(row.code.slice(stem.length)) + 1 : 1;
    return stem + String(next).padStart(3, '0');
  }

  // ───────────────────────── 해제 ─────────────────────────

  async function inspectFile(user, { file, fileName }) {
    if (!file.length) throw new HttpError(400, 'EMPTY_FILE', '빈 파일입니다. 다른 파일을 선택해 주세요.');
    const info = await mip.inspect({ buffer: file, fileName, user });
    return { fileName, size: file.length, ...info };
  }

  function validateReleaseMeta(meta) {
    const acks = Array.isArray(meta.acks) ? meta.acks : [];
    if (acks.length !== 3 || !acks.every((a) => a === true)) {
      throw new HttpError(400, 'ACK_REQUIRED', '자가 승인 확인 항목 3개에 모두 동의해야 해제할 수 있습니다.');
    }
    return {
      fileName: text(meta.fileName, { field: '파일명', min: 1, max: 255 }),
      recipientType: oneOf(meta.recipientType, RECIPIENT_TYPES, '수신처 구분'),
      recipientName: text(meta.recipientName, { field: '수신처명', min: 2, max: 80 }),
      reason: text(meta.reason, { field: '해제 사유', min: 10, max: 500 }),
      device: typeof meta.device === 'string' ? meta.device.slice(0, 80) : null,
    };
  }

  /** 자가 승인 후 해제: 해제자 · 해제 일시 · 해제 파일 원본을 남긴다. */
  async function createRelease(user, { meta, file, now = new Date() }) {
    const input = validateReleaseMeta(meta);
    const info = await inspectFile(user, { file, fileName: input.fileName });
    if (!info.protected) {
      throw new HttpError(422, 'NOT_PROTECTED', '보호되지 않은 파일입니다. 암호화 해제 없이 그대로 사용할 수 있습니다.');
    }
    if (!info.supported) {
      throw new HttpError(
        422,
        'ADAPTER_REQUIRED',
        '실제 MIP 보호 파일로 보입니다. 이 서버는 모의 어댑터로 동작하고 있어 해제할 수 없습니다. MIP SDK 어댑터를 연결한 뒤 다시 시도해 주세요.'
      );
    }
    if (!info.canUnprotect) {
      audit.record({
        actor: user,
        action: 'release.denied',
        detail: { fileName: input.fileName, labelId: info.labelId, reason: info.denyReason },
        at: now,
      });
      throw new HttpError(403, 'NO_RIGHTS', `이 문서를 해제할 권한이 없습니다. ${info.denyReason ?? ''} 문서 소유자(${info.owner ?? '미상'})에게 권한을 요청해 주세요.`.replace(/\s+/g, ' '));
    }

    let plain;
    try {
      plain = await mip.unprotect({ buffer: file, fileName: input.fileName, user });
    } catch (error) {
      throw new HttpError(502, 'UNPROTECT_FAILED', `암호화를 해제하지 못했습니다. ${error.message} 잠시 후 다시 시도해 주세요.`);
    }

    const id = crypto.randomUUID();
    const protectedPath = path.join('vault', 'releases', id, 'protected.bin');
    const filePath = path.join('vault', 'releases', id, 'original.bin');
    store(protectedPath, file);
    store(filePath, plain.buffer);

    const releasedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + config.releaseTtlDays * 86_400_000).toISOString();
    const labelId = LABELS[info.labelId] ? info.labelId : 'confidential';
    const row = transaction(db, () => {
      const code = nextCode('REL', 'releases', now);
      db.prepare(
        `INSERT INTO releases (id, code, user_id, user_name, user_dept, protected_name, file_name, mime, size,
           label_id, label_owner, protected_at, recipient_type, recipient_name, reason,
           approved_at, released_at, expires_at, protected_sha256, file_sha256, protected_path, file_path, adapter, device)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, code, user.id, user.name, user.dept, input.fileName, plain.fileName, plain.mime, plain.buffer.length,
        labelId, info.owner ?? null, info.protectedAt ?? null, input.recipientType, input.recipientName, input.reason,
        releasedAt, releasedAt, expiresAt, sha256(file), sha256(plain.buffer), protectedPath, filePath, mip.name, input.device
      );
      audit.record({
        actor: user,
        action: 'release.created',
        targetType: 'release',
        targetId: id,
        detail: { code, fileName: plain.fileName, labelId, sha256: sha256(plain.buffer), recipient: input.recipientName },
        at: now,
      });
      return db.prepare('SELECT * FROM releases WHERE id = ?').get(id);
    });
    return presentRelease(row, [], now);
  }

  function presentRelease(row, transfers, now = new Date()) {
    const expired = now.toISOString() > row.expires_at;
    return {
      id: row.id,
      code: row.code,
      user: { id: row.user_id, name: row.user_name, dept: row.user_dept },
      protectedName: row.protected_name,
      fileName: row.file_name,
      mime: row.mime,
      size: row.size,
      labelId: row.label_id,
      labelOwner: row.label_owner,
      protectedAt: row.protected_at,
      recipientType: row.recipient_type,
      recipientName: row.recipient_name,
      reason: row.reason,
      releasedAt: row.released_at,
      expiresAt: row.expires_at,
      fileSha256: row.file_sha256,
      protectedSha256: row.protected_sha256,
      device: row.device,
      status: transfers.length ? 'sent' : expired ? 'expired' : 'ready',
      canSend: !expired,
      transfers,
    };
  }

  function presentTransfer(row) {
    return {
      id: row.id,
      code: row.code,
      clientId: row.client_id,
      releaseId: row.release_id,
      user: { id: row.user_id, name: row.user_name, dept: row.user_dept },
      fileName: row.file_name,
      size: row.size,
      fileSha256: row.file_sha256,
      hashMatch: row.hash_match === 1,
      channel: row.channel,
      detail: JSON.parse(row.channel_detail),
      recipientType: row.recipient_type,
      recipientName: row.recipient_name,
      sentAt: row.sent_at,
      receivedAt: row.received_at,
      capturedOffline: row.captured_offline === 1,
      device: row.device,
      review: {
        status: row.review_status,
        note: row.review_note,
        reviewer: row.reviewer_name,
        at: row.reviewed_at,
      },
    };
  }

  function listReleases(user, now = new Date()) {
    const rows = db.prepare('SELECT * FROM releases WHERE user_id = ? ORDER BY released_at DESC').all(user.id);
    const transfers = db.prepare('SELECT * FROM transfers WHERE user_id = ? ORDER BY sent_at DESC').all(user.id);
    const byRelease = Map.groupBy(transfers, (t) => t.release_id);
    return rows.map((row) => presentRelease(row, (byRelease.get(row.id) ?? []).map(presentTransfer), now));
  }

  function getOwnRelease(user, id) {
    const row = db.prepare('SELECT * FROM releases WHERE id = ?').get(id);
    if (!row || row.user_id !== user.id) throw new HttpError(404, 'NOT_FOUND', '해제 기록을 찾을 수 없습니다.');
    return row;
  }

  function fetchReleaseFile(user, id) {
    const row = getOwnRelease(user, id);
    audit.record({ actor: user, action: 'release.file.fetched', targetType: 'release', targetId: id, detail: { code: row.code } });
    return { buffer: load(row.file_path), fileName: row.file_name, mime: row.mime, sha256: row.file_sha256 };
  }

  // ───────────────────────── 송부 ─────────────────────────

  function validateChannelDetail(channel, raw, user) {
    const d = raw && typeof raw === 'object' ? raw : {};
    if (channel === 'media') {
      return {
        mediaType: oneOf(d.mediaType, MEDIA_TYPES, '매체 종류'),
        mediaTag: text(d.mediaTag ?? '', { field: '매체 관리번호', max: 60 }),
      };
    }
    if (channel === 'gw') {
      const to = (Array.isArray(d.to) ? d.to : []).map((v) => String(v).trim()).filter(Boolean);
      if (!to.length) throw new HttpError(400, 'INVALID', '받는 사람 메일 주소를 입력해 주세요.');
      if (to.length > 10) throw new HttpError(400, 'INVALID', '받는 사람은 10명까지 지정할 수 있습니다.');
      const bad = to.find((address) => !EMAIL.test(address));
      if (bad) throw new HttpError(400, 'INVALID', `메일 주소 형식이 올바르지 않습니다: ${bad}`);
      return {
        to,
        subject: text(d.subject, { field: '제목', min: 1, max: 120 }),
        body: text(d.body ?? '', { field: '본문', max: 2000 }),
      };
    }
    const address = text(d.address, { field: '개인 메일 주소', min: 1, max: 120 }).toLowerCase();
    if (!EMAIL.test(address)) throw new HttpError(400, 'INVALID', '개인 메일 주소 형식이 올바르지 않습니다.');
    const domain = address.split('@')[1];
    if (config.corpDomains.includes(domain)) {
      throw new HttpError(400, 'INVALID', `${domain}은(는) 회사 메일입니다. 회사 메일로 보내려면 송부 수단에서 G/W를 선택해 주세요.`);
    }
    return { address, body: text(d.body ?? '', { field: '메모', max: 500 }), owner: user.name };
  }

  /**
   * 송부 기록: 파일 원본 · 파일명 · 송부자 · 송부 일시.
   * 네트워크 미연결 상태에서 PC에 남겨 둔 기록은 capturedOffline=true 로 뒤늦게 들어온다.
   */
  async function createTransfer(user, { meta, file, now = new Date() }) {
    const clientId = text(meta.clientId, { field: '요청 식별자', min: 8, max: 64 });
    const existing = db.prepare('SELECT * FROM transfers WHERE client_id = ?').get(clientId);
    if (existing) {
      if (existing.user_id !== user.id) throw new HttpError(409, 'CONFLICT', '이미 다른 사용자가 등록한 요청입니다.');
      return { transfer: presentTransfer(existing), duplicate: true };
    }

    const release = getOwnRelease(user, text(meta.releaseId, { field: '해제 기록', min: 1, max: 64 }));
    const channel = oneOf(meta.channel, CHANNELS, '송부 수단');
    const detail = validateChannelDetail(channel, meta.detail, user);
    const recipientType = oneOf(meta.recipientType ?? release.recipient_type, RECIPIENT_TYPES, '수신처 구분');
    const recipientName = text(meta.recipientName ?? release.recipient_name, { field: '수신처명', min: 2, max: 80 });
    const capturedOffline = meta.capturedOffline === true;
    if (capturedOffline && channel !== 'media') {
      throw new HttpError(400, 'INVALID', '네트워크 미연결 상태에서는 외부저장매체 송부만 기록할 수 있습니다.');
    }

    // 오프라인 기록은 PC가 적어 둔 시각을 쓰되, 해제 이전이나 미래 시각은 서버 시각으로 바로잡는다.
    let sentAt = now;
    let clockAdjusted = false;
    if (capturedOffline) {
      const claimed = new Date(meta.sentAt);
      const valid = !Number.isNaN(claimed.getTime()) && claimed <= now && claimed.toISOString() >= release.released_at;
      if (valid) sentAt = claimed;
      else clockAdjusted = true;
    }
    if (sentAt.toISOString() > release.expires_at) {
      throw new HttpError(409, 'EXPIRED', '해제 후 송부 가능 기간이 지났습니다. 문서를 다시 해제한 뒤 송부해 주세요.');
    }

    const original = load(release.file_path);
    const sentFile = file?.length ? file : original;
    const fileHash = sha256(sentFile);
    const hashMatch = fileHash === release.file_sha256;

    const id = crypto.randomUUID();
    const storedPath = path.join('vault', 'transfers', id, 'sent.bin');
    store(storedPath, sentFile);

    if (channel === 'gw' || channel === 'pmail') {
      const to = channel === 'gw' ? detail.to : [detail.address];
      const sent = mail.send({
        from: { name: user.name, email: user.email },
        to,
        subject: channel === 'gw' ? detail.subject : `[개인메일 송부] ${release.file_name}`,
        text: detail.body,
        attachment: { name: release.file_name, mime: release.mime, buffer: sentFile },
        at: sentAt,
      });
      detail.messageId = sent.messageId;
      detail.connector = mail.name;
    }
    if (clockAdjusted) detail.clockAdjusted = true;

    const device = typeof meta.device === 'string' ? meta.device.slice(0, 80) : null;
    const row = transaction(db, () => {
      const code = nextCode('TRF', 'transfers', sentAt);
      db.prepare(
        `INSERT INTO transfers (id, code, client_id, release_id, user_id, user_name, user_dept, file_name, size,
           file_sha256, hash_match, stored_path, channel, channel_detail, recipient_type, recipient_name,
           sent_at, received_at, captured_offline, device)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, code, clientId, release.id, user.id, user.name, user.dept, release.file_name, sentFile.length,
        fileHash, hashMatch ? 1 : 0, storedPath, channel, JSON.stringify(detail), recipientType, recipientName,
        sentAt.toISOString(), now.toISOString(), capturedOffline ? 1 : 0, device
      );
      audit.record({
        actor: user,
        action: capturedOffline ? 'transfer.synced' : 'transfer.created',
        targetType: 'transfer',
        targetId: id,
        detail: { code, release: release.code, fileName: release.file_name, channel, recipient: recipientName, sha256: fileHash, hashMatch },
        at: now,
      });
      return db.prepare('SELECT * FROM transfers WHERE id = ?').get(id);
    });
    return { transfer: presentTransfer(row), duplicate: false };
  }

  // ───────────────────────── 감사 ─────────────────────────

  function auditFilters(query, alias) {
    const where = [];
    const params = [];
    const col = (name) => `${alias}.${name}`;
    if (query.q) {
      const like = `%${query.q.replace(/[%_\\]/g, '\\$&')}%`;
      const fields = alias === 't'
        ? ['t.code', 't.file_name', 't.user_name', 't.user_dept', 't.recipient_name', 'r.code']
        : ['r.code', 'r.file_name', 'r.user_name', 'r.user_dept', 'r.recipient_name'];
      where.push(`(${fields.map((f) => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      for (let i = 0; i < fields.length; i += 1) params.push(like);
    }
    if (query.recipientType && RECIPIENT_TYPES[query.recipientType]) {
      where.push(`${col('recipient_type')} = ?`);
      params.push(query.recipientType);
    }
    if (query.label && LABELS[query.label]) {
      where.push('r.label_id = ?');
      params.push(query.label);
    }
    const dateCol = alias === 't' ? 't.sent_at' : 'r.released_at';
    if (/^\d{4}-\d{2}-\d{2}$/.test(query.from ?? '')) {
      where.push(`${dateCol} >= ?`);
      params.push(new Date(`${query.from}T00:00:00`).toISOString());
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(query.to ?? '')) {
      where.push(`${dateCol} < ?`);
      params.push(new Date(new Date(`${query.to}T00:00:00`).getTime() + 86_400_000).toISOString());
    }
    return { where, params };
  }

  function auditTransfers(query = {}) {
    const { where, params } = auditFilters(query, 't');
    if (query.channel && CHANNELS[query.channel]) {
      where.push('t.channel = ?');
      params.push(query.channel);
    }
    if (query.review && REVIEW_STATUSES[query.review]) {
      where.push('t.review_status = ?');
      params.push(query.review);
    }
    if (query.offline === '1') where.push('t.captured_offline = 1');
    if (query.mismatch === '1') where.push('t.hash_match = 0');
    const rows = db.prepare(
      `SELECT t.*, r.code AS release_code, r.label_id, r.reason, r.released_at
         FROM transfers t JOIN releases r ON r.id = t.release_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY t.sent_at DESC LIMIT 500`
    ).all(...params);
    return rows.map((row) => ({
      ...presentTransfer(row),
      release: { code: row.release_code, labelId: row.label_id, reason: row.reason, releasedAt: row.released_at },
    }));
  }

  function auditReleases(query = {}, now = new Date()) {
    const { where, params } = auditFilters(query, 'r');
    const rows = db.prepare(
      `SELECT r.* FROM releases r ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.released_at DESC LIMIT 500`
    ).all(...params);
    const counts = new Map(
      db.prepare('SELECT release_id, COUNT(*) AS n FROM transfers GROUP BY release_id').all().map((r) => [r.release_id, r.n])
    );
    return rows.map((row) => {
      const transferCount = counts.get(row.id) ?? 0;
      const base = presentRelease(row, [], now);
      return { ...base, transfers: undefined, transferCount, status: transferCount ? 'sent' : base.status };
    });
  }

  function auditEvents({ limit = 200 } = {}) {
    return db
      .prepare('SELECT seq, ts, actor_name, action, target_type, target_id, detail, hash FROM audit_events ORDER BY seq DESC LIMIT ?')
      .all(Math.min(Number(limit) || 200, 1000))
      .map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
  }

  function auditStats(now = new Date()) {
    const transfers = db.prepare('SELECT channel, recipient_type, sent_at, review_status, hash_match, captured_offline FROM transfers').all();
    const releaseCount = db.prepare('SELECT COUNT(*) AS n FROM releases').get().n;
    const tally = (table, key) => Object.keys(table).map((id) => ({ id, count: transfers.filter((t) => t[key] === id).length }));
    const days = [];
    for (let i = 13; i >= 0; i -= 1) {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1);
      days.push({
        date: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`,
        count: transfers.filter((t) => t.sent_at >= start.toISOString() && t.sent_at < end.toISOString()).length,
      });
    }
    return {
      releases: releaseCount,
      transfers: transfers.length,
      pendingReview: transfers.filter((t) => t.review_status === 'pending').length,
      flagged: transfers.filter((t) => t.review_status === 'flagged').length,
      hashMismatch: transfers.filter((t) => t.hash_match === 0).length,
      capturedOffline: transfers.filter((t) => t.captured_offline === 1).length,
      byChannel: tally(CHANNELS, 'channel'),
      byRecipientType: tally(RECIPIENT_TYPES, 'recipient_type'),
      daily: days,
    };
  }

  function auditFile(actor, kind, id) {
    if (kind === 'transfer') {
      const row = db.prepare('SELECT * FROM transfers WHERE id = ?').get(id);
      if (!row) throw new HttpError(404, 'NOT_FOUND', '송부 기록을 찾을 수 없습니다.');
      const release = db.prepare('SELECT mime FROM releases WHERE id = ?').get(row.release_id);
      audit.record({ actor, action: 'audit.file.downloaded', targetType: 'transfer', targetId: id, detail: { code: row.code, fileName: row.file_name } });
      return { buffer: load(row.stored_path), fileName: row.file_name, mime: release?.mime };
    }
    const row = db.prepare('SELECT * FROM releases WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', '해제 기록을 찾을 수 없습니다.');
    audit.record({ actor, action: 'audit.file.downloaded', targetType: 'release', targetId: id, detail: { code: row.code, fileName: row.file_name } });
    return { buffer: load(row.file_path), fileName: row.file_name, mime: row.mime };
  }

  function reviewTransfer(actor, id, { status, note }, now = new Date()) {
    const reviewStatus = oneOf(status, REVIEW_STATUSES, '검토 결과');
    const reviewNote = text(note ?? '', { field: '검토 의견', min: reviewStatus === 'flagged' ? 5 : 0, max: 500 });
    const row = db.prepare('SELECT * FROM transfers WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', '송부 기록을 찾을 수 없습니다.');
    if (row.user_id === actor.id) {
      throw new HttpError(403, 'SELF_REVIEW', '본인이 송부한 건은 직접 검토할 수 없습니다. 다른 감사 담당자에게 요청해 주세요.');
    }
    transaction(db, () => {
      db.prepare('UPDATE transfers SET review_status = ?, review_note = ?, reviewer_id = ?, reviewer_name = ?, reviewed_at = ? WHERE id = ?')
        .run(reviewStatus, reviewNote || null, actor.id, actor.name, now.toISOString(), id);
      audit.record({
        actor,
        action: 'transfer.reviewed',
        targetType: 'transfer',
        targetId: id,
        detail: { code: row.code, status: reviewStatus, note: reviewNote || undefined },
        at: now,
      });
    });
    return presentTransfer(db.prepare('SELECT * FROM transfers WHERE id = ?').get(id));
  }

  function exportTransfersCsv(actor, query) {
    const rows = auditTransfers(query);
    // 스프레드시트가 수식으로 해석하지 않도록 위험한 첫 글자를 무력화한다.
    const cell = (value) => {
      let s = value == null ? '' : String(value);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const describe = (t) => {
      if (t.channel === 'media') return [MEDIA_TYPES[t.detail.mediaType], t.detail.mediaTag].filter(Boolean).join(' ');
      if (t.channel === 'gw') return t.detail.to.join('; ');
      return t.detail.address;
    };
    const header = ['송부번호', '파일명', '송부자', '부서', '송부 일시', '서버 저장 일시', '송부 수단', '수단 상세', '수신처 구분', '수신처', '등급', '해제번호', '해제 사유', '오프라인 기록', '원본 일치', 'SHA-256', '검토'];
    const lines = rows.map((t) =>
      [
        t.code, t.fileName, t.user.name, t.user.dept, t.sentAt, t.receivedAt, CHANNELS[t.channel], describe(t),
        RECIPIENT_TYPES[t.recipientType], t.recipientName, LABELS[t.release.labelId]?.name, t.release.code, t.release.reason,
        t.capturedOffline ? 'Y' : 'N', t.hashMatch ? 'Y' : 'N', t.fileSha256, REVIEW_STATUSES[t.review.status],
      ].map(cell).join(',')
    );
    audit.record({ actor, action: 'audit.exported', detail: { rows: rows.length } });
    return Buffer.from(`${String.fromCharCode(0xfeff)}${header.map(cell).join(',')}\r\n${lines.join('\r\n')}\r\n`, 'utf8');
  }

  return {
    inspectFile, createRelease, listReleases, fetchReleaseFile, createTransfer,
    auditTransfers, auditReleases, auditEvents, auditStats, auditFile, reviewTransfer, exportTransfersCsv,
  };
}
