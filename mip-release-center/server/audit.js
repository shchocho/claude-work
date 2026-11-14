import crypto from 'node:crypto';

const GENESIS = '0'.repeat(64);

function eventHash(prevHash, event) {
  const payload = JSON.stringify([
    event.seq,
    event.ts,
    event.actor_id ?? null,
    event.actor_name ?? null,
    event.action,
    event.target_type ?? null,
    event.target_id ?? null,
    event.detail,
  ]);
  return crypto.createHash('sha256').update(prevHash).update('\n').update(payload).digest('hex');
}

export function createAuditLog(db) {
  const last = db.prepare('SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1');
  const insert = db.prepare(
    `INSERT INTO audit_events (seq, ts, actor_id, actor_name, action, target_type, target_id, detail, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  /** 감사 이벤트를 체인 끝에 덧붙인다. */
  function record({ actor, action, targetType = null, targetId = null, detail = {}, at = new Date() }) {
    const tail = last.get();
    const event = {
      seq: (tail?.seq ?? 0) + 1,
      ts: at.toISOString(),
      actor_id: actor?.id ?? null,
      actor_name: actor ? `${actor.name} (${actor.dept})` : null,
      action,
      target_type: targetType,
      target_id: targetId,
      detail: JSON.stringify(detail),
    };
    const prevHash = tail?.hash ?? GENESIS;
    const hash = eventHash(prevHash, event);
    insert.run(
      event.seq, event.ts, event.actor_id, event.actor_name, event.action,
      event.target_type, event.target_id, event.detail, prevHash, hash
    );
    return event.seq;
  }

  /** 체인 전체를 다시 계산해 위·변조 여부를 확인한다. */
  function verify() {
    const rows = db.prepare('SELECT * FROM audit_events ORDER BY seq').all();
    let prev = GENESIS;
    let expectedSeq = 1;
    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        return { ok: false, count: rows.length, brokenAt: expectedSeq, reason: '이벤트가 삭제되었거나 순번이 어긋났습니다.' };
      }
      if (row.prev_hash !== prev || row.hash !== eventHash(prev, row)) {
        return { ok: false, count: rows.length, brokenAt: row.seq, reason: '이벤트 내용이 기록 당시와 다릅니다.' };
      }
      prev = row.hash;
      expectedSeq += 1;
    }
    return { ok: true, count: rows.length, head: rows.length ? prev : null };
  }

  return { record, verify };
}
