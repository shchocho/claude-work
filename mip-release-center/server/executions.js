// Carrying out an approved request. This app never opens, decrypts or changes a
// document. An execution is a work order: an operator does the work with the
// organisation's own authorised tooling and records the outcome here (manual),
// or the order is handed to an endpoint the organisation runs under its own
// Microsoft account and rights, which reports back (webhook).
import { fail } from './http.js';
import { can, SYSTEM_ACTOR } from './rbac.js';
import { signPayload } from './outbox.js';
import { newId, parseJson, safeEqual, clampInt } from './util.js';

const DOC_RESULTS = ['done', 'failed', 'skipped'];
const OPEN_STATUSES = ['queued', 'claimed', 'dispatching', 'running'];
const CALLBACK_TOLERANCE_SECONDS = 300;

export function createExecutions({ db, clock, audit, users, policy, notifier, requests, outbox, config, logger }) {
  const core = requests.core;
  const nowIso = () => clock.now().toISOString();
  const getExec = (id) => (id ? db.get('SELECT * FROM executions WHERE id = ?', id) : null);
  const latestFor = (requestId) => db.get('SELECT * FROM executions WHERE request_id = ? ORDER BY attempt DESC LIMIT 1', requestId);

  function operatorIds() {
    return users.activeWithRole('operator').map((u) => u.id);
  }

  function dispatchPayload(row, exec) {
    const pol = policy.current().policy;
    const label = (id) => {
      const found = id ? policy.labelOf(pol, id) : null;
      return id ? { id, externalId: found?.externalId ?? '', name: found?.name ?? {} } : null;
    };
    const requester = users.rowById(row.requester_id);
    return {
      type: 'execution.dispatch',
      executionId: exec.id,
      attempt: exec.attempt,
      callbackUrl: `${config.baseUrl}/api/executions/${exec.id}/callback`,
      request: {
        id: row.id,
        number: row.number,
        title: row.title,
        action: row.action,
        targetLabel: label(row.target_label_id),
        reasonId: row.reason_id,
        external: Boolean(row.external),
        approvedAt: row.decided_at,
        validUntil: row.approval_valid_until,
        requester: { login: requester?.login ?? '', name: requester?.name ?? '', email: requester?.email ?? '' },
        url: `${config.baseUrl}/#/requests/${row.id}`,
      },
      documents: core
        .documentsOf(row.id)
        .filter((d) => d.exec_status !== 'done')
        .map((d) => ({ id: d.id, name: d.name, location: d.location ?? '', label: label(d.label_id), sizeBytes: d.size_bytes, sha256: d.sha256 })),
      recipients: core.recipientsOf(row.id).map((r) => ({ organization: r.organization, name: r.name ?? '', email: r.email ?? '' })),
    };
  }

  /** Close an execution from the per-document results and move the request with it. */
  function finish(exec, row, actor, { message = '', extra = {} } = {}) {
    const docs = core.documentsOf(row.id);
    const counts = { done: 0, failed: 0, skipped: 0 };
    for (const doc of docs) counts[doc.exec_status] = (counts[doc.exec_status] ?? 0) + 1;
    const outcome = counts.done === docs.length ? 'succeeded' : counts.done === 0 ? 'failed' : 'partial';
    const at = nowIso();
    db.run('UPDATE executions SET status = ?, message = ?, finished_at = ? WHERE id = ?', outcome, message || null, at, exec.id);
    const status = outcome === 'succeeded' ? 'completed' : outcome;
    const updated = core.setStatus(row, status, { completed_at: status === 'failed' ? null : at });
    audit.append(actor, 'execution.completed', {
      entityType: 'execution',
      entityId: exec.id,
      requestId: row.id,
      details: { outcome, counts, message, attempt: exec.attempt, mode: exec.mode, ...extra },
    });
    const type = { completed: 'request_completed', partial: 'request_partial', failed: 'request_failed' }[status];
    notifier.push([row.requester_id, ...(status === 'completed' ? core.ccIdsOf(row.id) : [])], type, {
      requestId: row.id,
      payload: core.notifyPayload(row, { counts }),
      exclude: actor.type === 'user' ? [actor.id] : [],
    });
    return updated;
  }

  /** Create the work order for a request that has just been approved (or is being retried). */
  function enqueue(row, actor) {
    const mode = policy.executorMode();
    const previous = latestFor(row.id);
    const exec = {
      id: newId('exe'),
      attempt: (previous?.attempt ?? 0) + 1,
      mode,
      status: mode === 'webhook' ? 'dispatching' : 'queued',
    };
    db.run(
      'INSERT INTO executions (id, request_id, attempt, mode, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      exec.id, row.id, exec.attempt, exec.mode, exec.status, nowIso(),
    );
    audit.append(actor, 'execution.queued', { entityType: 'execution', entityId: exec.id, requestId: row.id, details: { mode, attempt: exec.attempt } });
    if (mode === 'webhook') {
      outbox.enqueue('execution.dispatch', dispatchPayload(row, exec), exec.id);
    } else if (mode === 'simulate') {
      // Demo only: nothing is touched, every document is simply marked as handled.
      const at = nowIso();
      db.run("UPDATE request_documents SET exec_status = 'done', exec_note = 'simulated', exec_at = ? WHERE request_id = ? AND exec_status <> 'done'", at, row.id);
      db.run('UPDATE executions SET started_at = ? WHERE id = ?', at, exec.id);
      finish(getExec(exec.id), core.getRow(row.id), SYSTEM_ACTOR, { message: 'simulated', extra: { simulated: true } });
    } else {
      notifier.push(operatorIds(), 'execution_queued', { requestId: row.id, payload: core.notifyPayload(row), exclude: [row.requester_id] });
    }
    return getExec(exec.id);
  }

  function requireOperator(principal) {
    if (principal.type !== 'user' || !can(principal, 'execution.operate')) throw fail.forbidden('not_operator');
  }

  function loadOpen(execId) {
    const exec = getExec(execId);
    if (!exec) throw fail.notFound('execution_not_found', 'Execution not found');
    const row = core.getRow(exec.request_id);
    return { exec, row };
  }

  function claim(principal, execId) {
    requireOperator(principal);
    const rules = policy.current().policy.rules;
    return db.tx(() => {
      const { exec, row } = loadOpen(execId);
      const takeover = exec.status === 'dispatching' || exec.status === 'running';
      if (exec.status !== 'queued' && !takeover) throw fail.conflict('execution_not_claimable', 'This execution cannot be claimed', { status: exec.status });
      if (rules.operatorMustDifferFromRequester && row.requester_id === principal.id) {
        throw fail.forbidden('operator_is_requester', 'You cannot carry out your own request');
      }
      if (rules.operatorMustDifferFromApprovers) {
        const approved = db.get('SELECT 1 AS x FROM decisions WHERE request_id = ? AND (approver_id = ? OR seat_id = ?)', row.id, principal.id, principal.id);
        if (approved) throw fail.forbidden('operator_is_approver', 'You approved this request and cannot also carry it out');
      }
      const at = nowIso();
      db.run('UPDATE executions SET status = ?, operator_id = ?, started_at = COALESCE(started_at, ?) WHERE id = ?', 'claimed', principal.id, at, exec.id);
      if (takeover) {
        db.run("UPDATE outbox SET status = 'failed', last_error = 'taken over' WHERE kind = 'execution.dispatch' AND ref_id = ? AND status = 'pending'", exec.id);
      }
      if (row.status === 'approved') core.setStatus(row, 'executing');
      else core.touch(row.id);
      audit.append(principal, takeover ? 'execution.taken_over' : 'execution.claimed', {
        entityType: 'execution', entityId: exec.id, requestId: row.id, details: { attempt: exec.attempt, mode: exec.mode },
      });
      return getExec(exec.id);
    });
  }

  function mine(principal, execId) {
    const { exec, row } = loadOpen(execId);
    if (exec.status !== 'claimed') throw fail.conflict('execution_not_claimed', 'Claim this execution first', { status: exec.status });
    if (exec.operator_id !== principal.id) throw fail.forbidden('not_your_execution', 'Another operator is handling this execution');
    return { exec, row };
  }

  function release(principal, execId) {
    requireOperator(principal);
    return db.tx(() => {
      const { exec, row } = mine(principal, execId);
      db.run('UPDATE executions SET status = ?, operator_id = NULL WHERE id = ?', 'queued', exec.id);
      core.setStatus(row, 'approved');
      audit.append(principal, 'execution.released', { entityType: 'execution', entityId: exec.id, requestId: row.id, details: { attempt: exec.attempt } });
      notifier.push(operatorIds(), 'execution_queued', { requestId: row.id, payload: core.notifyPayload(row), exclude: [principal.id, row.requester_id] });
      return getExec(exec.id);
    });
  }

  function recordDocument(principal, execId, documentId, input) {
    requireOperator(principal);
    const rules = policy.current().policy.rules;
    const status = input?.status;
    if (![...DOC_RESULTS, 'pending'].includes(status)) throw fail.invalid([{ field: 'status', code: 'invalid' }]);
    const note = typeof input.note === 'string' ? core.cleanText(input.note, { multiline: true }) : '';
    if (note.length > 500) throw fail.invalid([{ field: 'note', code: 'too_long', params: { max: 500 } }]);
    if ((status === 'failed' || status === 'skipped') && !note) throw fail.invalid([{ field: 'note', code: 'required' }]);
    const hashVerified = input.hashVerified === true ? true : input.hashVerified === false ? false : null;
    return db.tx(() => {
      const { exec, row } = mine(principal, execId);
      const doc = db.get('SELECT * FROM request_documents WHERE id = ? AND request_id = ?', documentId, row.id);
      if (!doc) throw fail.notFound('document_not_found', 'Document not found');
      if (status === 'done' && rules.requireHash && doc.sha256 && hashVerified !== true) {
        throw fail.invalid([{ field: 'hashVerified', code: 'hash_verification_required' }]);
      }
      if (status === 'pending') {
        db.run("UPDATE request_documents SET exec_status = 'pending', exec_note = NULL, exec_hash_verified = NULL, exec_at = NULL, exec_by = NULL WHERE id = ?", doc.id);
      } else {
        db.run(
          'UPDATE request_documents SET exec_status = ?, exec_note = ?, exec_hash_verified = ?, exec_at = ?, exec_by = ? WHERE id = ?',
          status, note || null, hashVerified, nowIso(), principal.id, doc.id,
        );
      }
      core.touch(row.id);
      audit.append(principal, 'execution.document_recorded', {
        entityType: 'document', entityId: doc.id, requestId: row.id,
        details: { executionId: exec.id, name: doc.name, status, note, hashVerified },
      });
      return { id: doc.id, execStatus: status };
    });
  }

  function complete(principal, execId, input = {}) {
    requireOperator(principal);
    const message = typeof input.message === 'string' ? core.cleanText(input.message, { multiline: true }).slice(0, 1000) : '';
    return db.tx(() => {
      const { exec, row } = mine(principal, execId);
      const pending = core.documentsOf(row.id).filter((d) => d.exec_status === 'pending');
      if (pending.length) throw fail.unprocessable('documents_pending', 'Record a result for every document first', { pending: pending.length });
      finish(exec, row, principal, { message });
      return getExec(exec.id);
    });
  }

  /** Try again for the documents that did not succeed, while the approval is still valid. */
  function retry(principal, execId) {
    requireOperator(principal);
    return db.tx(() => {
      const { exec, row } = loadOpen(execId);
      const latest = latestFor(row.id);
      if (latest.id !== exec.id || !['failed', 'partial'].includes(exec.status) || !['failed', 'partial'].includes(row.status)) {
        throw fail.conflict('execution_not_retryable', 'This execution cannot be retried', { status: exec.status });
      }
      if (!row.approval_valid_until || row.approval_valid_until <= nowIso()) {
        throw fail.conflict('approval_expired', 'The approval is no longer valid; a new request is needed');
      }
      db.run("UPDATE request_documents SET exec_status = 'pending', exec_note = NULL, exec_hash_verified = NULL, exec_at = NULL, exec_by = NULL WHERE request_id = ? AND exec_status IN ('failed', 'skipped')", row.id);
      const reopened = core.setStatus(row, 'approved', { completed_at: null });
      audit.append(principal, 'execution.retried', { entityType: 'execution', entityId: exec.id, requestId: row.id, details: { attempt: exec.attempt } });
      return enqueue(reopened, principal);
    });
  }

  // ----- webhook executor --------------------------------------------------

  function markRunning(exec, row, externalRef) {
    db.run('UPDATE executions SET status = ?, started_at = COALESCE(started_at, ?), external_ref = COALESCE(?, external_ref) WHERE id = ?', 'running', nowIso(), externalRef, exec.id);
    if (row.status === 'approved') core.setStatus(row, 'executing');
  }

  function cleanRef(value) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
  }

  outbox.on('delivered', 'execution.dispatch', (outboxRow, response) => {
    db.tx(() => {
      const exec = getExec(outboxRow.ref_id);
      if (!exec || exec.status !== 'dispatching') return;
      const row = core.getRow(exec.request_id);
      const externalRef = cleanRef(response?.externalRef);
      markRunning(exec, row, externalRef);
      audit.append(SYSTEM_ACTOR, 'execution.dispatched', { entityType: 'execution', entityId: exec.id, requestId: row.id, details: { attempt: exec.attempt, externalRef } });
    });
  });

  outbox.on('gaveUp', 'execution.dispatch', (outboxRow, error) => {
    db.tx(() => {
      const exec = getExec(outboxRow.ref_id);
      if (!exec || exec.status !== 'dispatching') return;
      const row = core.getRow(exec.request_id);
      const message = `dispatch failed: ${error}`;
      db.run('UPDATE executions SET status = ?, message = ?, finished_at = ? WHERE id = ?', 'failed', message, nowIso(), exec.id);
      if (row.status === 'approved') core.setStatus(row, 'failed');
      audit.append(SYSTEM_ACTOR, 'execution.dispatch_failed', { entityType: 'execution', entityId: exec.id, requestId: row.id, details: { attempt: exec.attempt, error } });
      notifier.push([...operatorIds(), row.requester_id], 'request_failed', { requestId: row.id, payload: core.notifyPayload(row, { dispatch: true }) });
    });
  });

  /**
   * Result reported by the organisation's executor. The caller proves itself
   * with an HMAC over "<timestamp>.<body>" using the shared secret.
   */
  function handleCallback(execId, rawBody, headers, ip) {
    if (!config.executorWebhookSecret) throw fail.notFound();
    const timestamp = String(headers['x-mrc-timestamp'] ?? '');
    const signature = String(headers['x-mrc-signature'] ?? '');
    const skew = Math.abs(Math.floor(clock.now().getTime() / 1000) - Number(timestamp));
    if (!/^\d{9,12}$/.test(timestamp) || !(skew <= CALLBACK_TOLERANCE_SECONDS)) throw fail.unauthorized('invalid_signature', 'Timestamp missing or too old');
    if (!safeEqual(signature, signPayload(config.executorWebhookSecret, timestamp, rawBody.toString('utf8')))) {
      throw fail.unauthorized('invalid_signature', 'Signature does not match');
    }
    const body = parseJson(rawBody.toString('utf8'), null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail.badRequest('invalid_json');
    const actor = { type: 'system', id: null, label: 'executor', ip: ip ?? null };

    return db.tx(() => {
      const exec = getExec(execId);
      if (!exec) throw fail.notFound('execution_not_found', 'Execution not found');
      if (exec.status !== 'dispatching' && exec.status !== 'running') return { ok: true, ignored: true, status: exec.status };
      let row = core.getRow(exec.request_id);
      markRunning(exec, row, cleanRef(body.externalRef));
      row = core.getRow(row.id);

      const results = Array.isArray(body.documents) ? body.documents.slice(0, 500) : [];
      const at = nowIso();
      let recorded = 0;
      for (const item of results) {
        if (!item || typeof item !== 'object' || !DOC_RESULTS.includes(item.status)) continue;
        const doc = db.get('SELECT * FROM request_documents WHERE id = ? AND request_id = ?', String(item.id ?? ''), row.id);
        if (!doc || doc.exec_status === 'done') continue;
        let status = item.status;
        let note = typeof item.note === 'string' ? core.cleanText(item.note, { multiline: true }).slice(0, 500) : '';
        let hashVerified = null;
        const reported = typeof item.sha256 === 'string' ? item.sha256.trim().toLowerCase() : '';
        if (reported && doc.sha256) {
          hashVerified = reported === doc.sha256;
          // A different file than the one approved must never count as done.
          if (!hashVerified && status === 'done') {
            status = 'failed';
            note = `hash mismatch${note ? ': ' + note : ''}`.slice(0, 500);
          }
        }
        db.run('UPDATE request_documents SET exec_status = ?, exec_note = ?, exec_hash_verified = ?, exec_at = ?, exec_by = NULL WHERE id = ?', status, note || null, hashVerified, at, doc.id);
        recorded += 1;
      }
      const pending = core.documentsOf(row.id).filter((d) => d.exec_status === 'pending');
      const final = body.final === true || !pending.length;
      audit.append(actor, 'execution.callback_received', { entityType: 'execution', entityId: exec.id, requestId: row.id, details: { recorded, final } });
      if (final) {
        for (const doc of pending) {
          db.run("UPDATE request_documents SET exec_status = 'failed', exec_note = 'no result reported', exec_at = ? WHERE id = ?", at, doc.id);
        }
        const message = typeof body.message === 'string' ? core.cleanText(body.message, { multiline: true }).slice(0, 1000) : '';
        finish(getExec(exec.id), row, actor, { message });
      } else core.touch(row.id);
      return { ok: true, final, status: getExec(exec.id).status };
    });
  }

  // ----- read side ---------------------------------------------------------

  function view(exec) {
    return {
      id: exec.id,
      attempt: exec.attempt,
      mode: exec.mode,
      status: exec.status,
      operator: users.briefById(exec.operator_id),
      externalRef: exec.external_ref,
      message: exec.message ?? '',
      createdAt: exec.created_at,
      startedAt: exec.started_at,
      finishedAt: exec.finished_at,
    };
  }

  function list(principal, { tab = 'queue', limit } = {}) {
    requireOperator(principal);
    const filters = {
      queue: ["e.status = 'queued'", []],
      mine: ["e.status = 'claimed' AND e.operator_id = ?", [principal.id]],
      active: ["e.status IN ('claimed', 'dispatching', 'running')", []],
      done: ["e.status IN ('succeeded', 'partial', 'failed', 'cancelled')", []],
    };
    const [clause, params] = filters[tab] ?? filters.queue;
    const order = tab === 'done' ? 'e.finished_at DESC' : 'e.created_at ASC';
    const rows = db.all(`SELECT e.* FROM executions e WHERE ${clause} ORDER BY ${order} LIMIT ?`, ...params, clampInt(limit, 100, 1, 200));
    return rows.map((exec) => {
      const row = core.getRow(exec.request_id);
      return { execution: view(exec), request: requests.summary(row), isLatest: latestFor(row.id).id === exec.id };
    });
  }

  function counts(principal) {
    if (principal.type !== 'user' || !can(principal, 'execution.operate')) return { queue: 0, mine: 0 };
    return {
      queue: db.get("SELECT count(*) AS n FROM executions WHERE status = 'queued'").n,
      mine: db.get("SELECT count(*) AS n FROM executions WHERE status = 'claimed' AND operator_id = ?", principal.id).n,
    };
  }

  function openCount() {
    return db.get(`SELECT count(*) AS n FROM executions WHERE status IN (${OPEN_STATUSES.map(() => '?').join(', ')})`, ...OPEN_STATUSES).n;
  }

  return { enqueue, claim, release, recordDocument, complete, retry, handleCallback, list, counts, view, getExec, latestFor, openCount, logger };
}
