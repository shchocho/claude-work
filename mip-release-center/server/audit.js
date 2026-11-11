// Append-only audit trail. Each entry stores the hash of the one before it, so
// editing or removing a row breaks every hash after it. The database triggers
// stop UPDATE/DELETE from application code; the chain is what makes tampering
// by someone with direct file access detectable, as long as a copy of the head
// hash is kept somewhere else (see the audit export and README).
import { canonicalJson, sha256Hex, parseJson, escapeLike, clampInt } from './util.js';

export const GENESIS_HASH = '0'.repeat(64);

function hashEntry(entry) {
  const body = canonicalJson({
    seq: entry.seq,
    ts: entry.ts,
    actorType: entry.actorType,
    actorId: entry.actorId,
    actorLabel: entry.actorLabel,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    requestId: entry.requestId,
    ip: entry.ip,
    details: entry.details,
  });
  return sha256Hex(entry.prevHash + '\n' + body);
}

function fromRow(row) {
  return {
    seq: row.seq,
    ts: row.ts,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorLabel: row.actor_label,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    requestId: row.request_id,
    ip: row.ip,
    details: parseJson(row.details, {}),
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

export function createAudit({ db, clock }) {
  /**
   * Record one event. `actor` is { type, id, label, ip }. Call it inside the
   * same transaction as the change it describes so the two cannot drift apart.
   */
  function append(actor, action, { entityType = null, entityId = null, requestId = null, details = {} } = {}) {
    return db.tx(() => {
      const last = db.get('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1');
      const entry = {
        seq: last ? last.seq + 1 : 1,
        ts: clock.now().toISOString(),
        actorType: actor.type,
        actorId: actor.id ?? null,
        actorLabel: actor.label ?? null,
        action,
        entityType,
        entityId,
        requestId,
        ip: actor.ip ?? null,
        // Round-trip through JSON so the hashed value is exactly what gets stored.
        details: JSON.parse(JSON.stringify(details ?? {})),
        prevHash: last ? last.hash : GENESIS_HASH,
      };
      entry.hash = hashEntry(entry);
      db.run(
        `INSERT INTO audit_log (seq, ts, actor_type, actor_id, actor_label, action, entity_type, entity_id, request_id, ip, details, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.seq, entry.ts, entry.actorType, entry.actorId, entry.actorLabel, entry.action,
        entry.entityType, entry.entityId, entry.requestId, entry.ip, JSON.stringify(entry.details),
        entry.prevHash, entry.hash,
      );
      return entry;
    });
  }

  /** Walk the whole chain and report the first entry that does not check out. */
  function verify() {
    let expectedSeq = 1;
    let prevHash = GENESIS_HASH;
    let count = 0;
    for (const row of db.prepare('SELECT * FROM audit_log ORDER BY seq').iterate()) {
      const entry = fromRow(row);
      let problem = null;
      if (entry.seq !== expectedSeq) problem = 'sequence_gap';
      else if (entry.prevHash !== prevHash) problem = 'chain_broken';
      else if (hashEntry(entry) !== entry.hash) problem = 'entry_modified';
      if (problem) {
        return { ok: false, count, brokenAt: entry.seq, expectedSeq, problem, headHash: prevHash };
      }
      prevHash = entry.hash;
      expectedSeq += 1;
      count += 1;
    }
    return { ok: true, count, headSeq: count, headHash: prevHash };
  }

  function buildWhere(filters) {
    const where = [];
    const params = [];
    if (filters.afterSeq !== undefined && filters.afterSeq !== '') {
      where.push('seq > ?');
      params.push(clampInt(filters.afterSeq, 0, 0, Number.MAX_SAFE_INTEGER));
    }
    if (filters.beforeSeq !== undefined && filters.beforeSeq !== '') {
      where.push('seq < ?');
      params.push(clampInt(filters.beforeSeq, 0, 0, Number.MAX_SAFE_INTEGER));
    }
    if (filters.action) {
      // "request." matches the whole family, "request.submitted" just one action.
      if (String(filters.action).endsWith('.')) {
        where.push("action LIKE ? ESCAPE '\\'");
        params.push(escapeLike(filters.action) + '%');
      } else {
        where.push('action = ?');
        params.push(String(filters.action));
      }
    }
    if (filters.actorId) {
      where.push('actor_id = ?');
      params.push(String(filters.actorId));
    }
    if (filters.requestId) {
      where.push('request_id = ?');
      params.push(String(filters.requestId));
    }
    if (filters.from) {
      where.push('ts >= ?');
      params.push(String(filters.from));
    }
    if (filters.to) {
      where.push('ts < ?');
      params.push(String(filters.to));
    }
    if (filters.q) {
      const like = '%' + escapeLike(String(filters.q).slice(0, 100)) + '%';
      where.push("(actor_label LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\' OR entity_id LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like);
    }
    return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
  }

  function query(filters = {}) {
    const limit = clampInt(filters.limit, 50, 1, 1000);
    const order = filters.order === 'asc' ? 'ASC' : 'DESC';
    const { clause, params } = buildWhere(filters);
    const rows = db.all(`SELECT * FROM audit_log ${clause} ORDER BY seq ${order} LIMIT ?`, ...params, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(fromRow);
    const total = db.get(`SELECT count(*) AS n FROM audit_log ${clause}`, ...params).n;
    return { items, hasMore, total };
  }

  /** Every matching entry in chain order, for exports. Capped to keep memory bounded. */
  function exportRows(filters = {}, cap = 200_000) {
    const { clause, params } = buildWhere(filters);
    return db.all(`SELECT * FROM audit_log ${clause} ORDER BY seq ASC LIMIT ?`, ...params, cap).map(fromRow);
  }

  function forRequest(requestId) {
    return db.all('SELECT * FROM audit_log WHERE request_id = ? ORDER BY seq', requestId).map(fromRow);
  }

  function distinctActions() {
    return db.all('SELECT DISTINCT action FROM audit_log ORDER BY action').map((r) => r.action);
  }

  return { append, verify, query, exportRows, forRequest, distinctActions };
}
