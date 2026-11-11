// Release requests: content, validation against the policy, submission into an
// approval route, and the read side (lists, detail, export). Approval decisions
// and execution live in approvals.js and executions.js and share the helpers
// exposed as `requests.core`.
import { fail } from './http.js';
import { can } from './rbac.js';
import { isEmail } from './users.js';
import { newId, parseJson, isDateOnly, escapeLike, clampInt, addDays, toCsv, canonicalJson, sha256Hex } from './util.js';

export const STATUSES = ['draft', 'pending', 'returned', 'approved', 'executing', 'completed', 'partial', 'failed', 'rejected', 'cancelled', 'expired'];

const TRANSITIONS = {
  draft: ['pending'],
  pending: ['approved', 'rejected', 'returned', 'cancelled', 'expired'],
  returned: ['pending', 'cancelled', 'expired'],
  approved: ['executing', 'completed', 'failed', 'cancelled', 'expired'],
  executing: ['completed', 'partial', 'failed', 'approved'],
  failed: ['approved'],
  partial: ['approved'],
  completed: [],
  rejected: [],
  cancelled: [],
  expired: [],
};
const CLOSED = new Set(['completed', 'partial', 'failed', 'rejected', 'cancelled', 'expired']);
const OPERATOR_VISIBLE = new Set(['approved', 'executing', 'completed', 'partial', 'failed']);
const SHA256 = /^[0-9a-f]{64}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function cleanText(value, { multiline = false } = {}) {
  let text = value.replace(CONTROL_CHARS, '');
  if (!multiline) text = text.replace(/[\r\n\t]+/g, ' ');
  else text = text.replace(/\r\n?/g, '\n');
  return text.trim();
}

export function createRequests({ db, clock, audit, users, policy, notifier }) {
  const now = () => clock.now();
  const nowIso = () => clock.now().toISOString();

  // ----- storage helpers (shared with approvals/executions) ----------------

  const getRow = (id) => (id ? db.get('SELECT * FROM requests WHERE id = ?', id) : null);
  const documentsOf = (id) => db.all('SELECT * FROM request_documents WHERE request_id = ? ORDER BY position', id);
  const recipientsOf = (id) => db.all('SELECT * FROM request_recipients WHERE request_id = ? ORDER BY position', id);
  const stagesOf = (id, revision) => db.all('SELECT * FROM request_stages WHERE request_id = ? AND revision = ? ORDER BY position', id, revision);
  const allStagesOf = (id) => db.all('SELECT * FROM request_stages WHERE request_id = ? ORDER BY revision, position', id);
  const stageById = (id) => (id ? db.get('SELECT * FROM request_stages WHERE id = ?', id) : null);
  const assigneeIdsOf = (stageId) => db.all('SELECT user_id FROM stage_assignees WHERE stage_id = ?', stageId).map((r) => r.user_id);
  const decisionsOfStage = (stageId) => db.all('SELECT * FROM decisions WHERE stage_id = ? ORDER BY created_at, rowid', stageId);
  const ccIdsOf = (id) => db.all('SELECT user_id FROM request_cc WHERE request_id = ?', id).map((r) => r.user_id);

  /** Move a request to a new status. Rejects moves the workflow does not allow. */
  function setStatus(row, status, fields = {}) {
    if (!TRANSITIONS[row.status]?.includes(status)) {
      throw fail.conflict('invalid_transition', `Cannot move a request from ${row.status} to ${status}`, { from: row.status, to: status });
    }
    const at = nowIso();
    const next = {
      status,
      updated_at: at,
      closed_at: CLOSED.has(status) ? at : null,
      ...fields,
    };
    const keys = Object.keys(next);
    db.run(
      `UPDATE requests SET ${keys.map((k) => `${k} = ?`).join(', ')}, version = version + 1 WHERE id = ?`,
      ...keys.map((k) => next[k]), row.id,
    );
    return getRow(row.id);
  }

  function touch(id, fields = {}) {
    const next = { updated_at: nowIso(), ...fields };
    const keys = Object.keys(next);
    db.run(`UPDATE requests SET ${keys.map((k) => `${k} = ?`).join(', ')}, version = version + 1 WHERE id = ?`, ...keys.map((k) => next[k]), id);
    return getRow(id);
  }

  /** Delegations that let `userId` act for someone else right now. */
  function activeDelegationsTo(userId) {
    const at = nowIso();
    return db.all(
      'SELECT * FROM delegations WHERE to_user_id = ? AND revoked_at IS NULL AND starts_at <= ? AND ends_at > ?',
      userId, at, at,
    );
  }

  function activeDelegatesOf(userId) {
    const at = nowIso();
    return db
      .all('SELECT to_user_id FROM delegations WHERE from_user_id = ? AND revoked_at IS NULL AND starts_at <= ? AND ends_at > ?', userId, at, at)
      .map((r) => r.to_user_id);
  }

  function notifyPayload(row, extra = {}) {
    return { number: row.number, title: row.title, ...extra };
  }

  /** Start a stage: it becomes the one awaiting decisions and its approvers are told. */
  function activateStage(row, stage, actorName) {
    const at = now();
    const dueAt = stage.sla_hours ? new Date(at.getTime() + stage.sla_hours * 3600_000).toISOString() : null;
    db.run('UPDATE request_stages SET status = ?, activated_at = ?, due_at = ?, overdue_notified_at = NULL WHERE id = ?', 'active', at.toISOString(), dueAt, stage.id);
    db.run('UPDATE requests SET current_stage_id = ? WHERE id = ?', stage.id, row.id);
    const assignees = assigneeIdsOf(stage.id);
    const delegates = assignees.flatMap((id) => activeDelegatesOf(id));
    notifier.push([...assignees, ...delegates], 'approval_requested', {
      requestId: row.id,
      payload: notifyPayload(row, { stageName: parseJson(stage.name, {}), requesterName: actorName ?? users.briefById(row.requester_id)?.name ?? '' }),
      exclude: [row.requester_id],
    });
  }

  // ----- access ------------------------------------------------------------

  function relationOf(principal, row) {
    if (principal.type !== 'user') {
      return { isRequester: false, read: row.status !== 'draft' && can(principal, 'request.read.all') };
    }
    const userId = principal.id;
    const isRequester = row.requester_id === userId;
    if (isRequester) return { isRequester, read: true };
    if (row.status === 'draft') return { isRequester, read: false };
    if (can(principal, 'request.read.all')) return { isRequester, read: true };
    if (can(principal, 'execution.operate') && OPERATOR_VISIBLE.has(row.status)) return { isRequester, read: true };
    const involved = db.get(
      `SELECT 1 AS x WHERE
         EXISTS (SELECT 1 FROM request_stages s JOIN stage_assignees a ON a.stage_id = s.id WHERE s.request_id = ? AND a.user_id = ?)
         OR EXISTS (SELECT 1 FROM decisions d WHERE d.request_id = ? AND d.approver_id = ?)
         OR EXISTS (SELECT 1 FROM request_cc c WHERE c.request_id = ? AND c.user_id = ?)`,
      row.id, userId, row.id, userId, row.id, userId,
    );
    if (involved) return { isRequester, read: true };
    if (row.status === 'pending' && row.current_stage_id) {
      const assignees = assigneeIdsOf(row.current_stage_id);
      if (activeDelegationsTo(userId).some((d) => assignees.includes(d.from_user_id))) return { isRequester, read: true };
    }
    return { isRequester, read: false };
  }

  function readable(principal, id) {
    const row = getRow(id);
    // Same answer for "missing" and "not yours" so ids cannot be probed.
    if (!row || !relationOf(principal, row).read) throw fail.notFound('request_not_found', 'Request not found');
    return row;
  }

  // ----- content -----------------------------------------------------------

  /**
   * Clean request content and check it against the policy. Drafts get the
   * lenient pass (shape and lengths); submission adds the business rules.
   */
  function normalizeContent(input, pol, { strict }) {
    const errors = [];
    const err = (field, code, params) => errors.push(params ? { field, code, params } : { field, code });
    const str = (value, field, max, opts) => {
      if (value === undefined || value === null) return '';
      if (typeof value !== 'string') {
        err(field, 'invalid');
        return '';
      }
      const text = cleanText(value, opts);
      if (text.length > max) {
        err(field, 'too_long', { max });
        return text.slice(0, max);
      }
      return text;
    };
    const rules = pol.rules;
    const out = {
      title: str(input.title, 'title', 120),
      action: str(input.action, 'action', 40),
      reasonId: str(input.reasonId, 'reasonId', 40) || null,
      justification: str(input.justification, 'justification', 4000, { multiline: true }),
      targetLabelId: str(input.targetLabelId, 'targetLabelId', 40) || null,
      dueDate: null,
    };
    if (input.dueDate) {
      if (isDateOnly(input.dueDate)) out.dueDate = input.dueDate;
      else err('dueDate', 'invalid_date');
    }

    const action = out.action ? policy.actionOf(pol, out.action) : null;
    if (out.action && (!action || !action.enabled)) err('action', 'unknown_action');
    const reason = out.reasonId ? policy.reasonOf(pol, out.reasonId) : null;
    if (out.reasonId && (!reason || !reason.enabled)) err('reasonId', 'unknown_reason');

    // documents
    let docsIn = input.documents ?? [];
    if (!Array.isArray(docsIn)) {
      err('documents', 'invalid');
      docsIn = [];
    }
    if (docsIn.length > rules.maxDocumentsPerRequest) err('documents', 'too_many', { max: rules.maxDocumentsPerRequest });
    out.documents = docsIn.slice(0, rules.maxDocumentsPerRequest).map((doc, i) => {
      const f = `documents[${i}]`;
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        err(f, 'invalid');
        return { name: '', location: '', labelId: null, sizeBytes: null, sha256: null, note: '' };
      }
      let sizeBytes = null;
      if (doc.sizeBytes !== undefined && doc.sizeBytes !== null && doc.sizeBytes !== '') {
        if (Number.isSafeInteger(doc.sizeBytes) && doc.sizeBytes >= 0) sizeBytes = doc.sizeBytes;
        else err(`${f}.sizeBytes`, 'invalid');
      }
      let sha256 = null;
      if (doc.sha256) {
        const hex = String(doc.sha256).trim().toLowerCase();
        if (SHA256.test(hex)) sha256 = hex;
        else err(`${f}.sha256`, 'invalid_hash');
      }
      const labelId = str(doc.labelId, `${f}.labelId`, 40) || null;
      if (labelId && !policy.labelOf(pol, labelId)) err(`${f}.labelId`, 'unknown_label');
      return {
        name: str(doc.name, `${f}.name`, 255),
        location: str(doc.location, `${f}.location`, 1000),
        labelId,
        sizeBytes,
        sha256,
        note: str(doc.note, `${f}.note`, 500),
      };
    });

    const targetLabel = out.targetLabelId ? policy.labelOf(pol, out.targetLabelId) : null;
    if (out.targetLabelId && !targetLabel) err('targetLabelId', 'unknown_label');
    if (action && !action.requiresTargetLabel) out.targetLabelId = null;

    // Naming a recipient means the document leaves its normal audience, so the
    // request is treated as external whenever the reason or the action says so.
    out.external = Boolean(input.external) || Boolean(reason?.external) || Boolean(action?.requiresRecipients);
    let recipientsIn = input.recipients ?? [];
    if (!Array.isArray(recipientsIn)) {
      err('recipients', 'invalid');
      recipientsIn = [];
    }
    if (recipientsIn.length > 20) err('recipients', 'too_many', { max: 20 });
    out.recipients = out.external
      ? recipientsIn.slice(0, 20).map((rec, i) => {
          const f = `recipients[${i}]`;
          if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
            err(f, 'invalid');
            return { organization: '', name: '', email: '' };
          }
          const email = str(rec.email, `${f}.email`, 254);
          if (email && !isEmail(email)) err(`${f}.email`, 'invalid_email');
          return { organization: str(rec.organization, `${f}.organization`, 120), name: str(rec.name, `${f}.name`, 80), email };
        })
      : [];

    if (!strict) return { value: out, errors };

    if (!out.title) err('title', 'required');
    if (!out.action) err('action', 'required');
    if (!out.reasonId) err('reasonId', 'required');
    if (out.justification.length < rules.minJustificationLength) err('justification', 'too_short', { min: rules.minJustificationLength });
    if (!out.documents.length) err('documents', 'required');

    const seenHashes = new Map();
    const seenPaths = new Map();
    out.documents.forEach((doc, i) => {
      const f = `documents[${i}]`;
      if (!doc.name) err(`${f}.name`, 'required');
      const label = doc.labelId ? policy.labelOf(pol, doc.labelId) : null;
      if (!doc.labelId) err(`${f}.labelId`, 'required');
      else if (label) {
        if (!label.releasable) err(`${f}.labelId`, 'label_not_releasable');
        else if (action?.requiresProtectedSource && !label.protected) err(`${f}.labelId`, 'label_not_protected');
        else if (action?.targetMustBeLower && targetLabel && !(targetLabel.rank < label.rank)) err(`${f}.labelId`, 'target_not_lower');
      }
      if (rules.requireLocation && !doc.location) err(`${f}.location`, 'required');
      if (doc.location && rules.locationPrefixes.length) {
        const lower = doc.location.toLowerCase();
        if (!rules.locationPrefixes.some((p) => lower.startsWith(p.toLowerCase()))) err(`${f}.location`, 'location_not_allowed');
      }
      if (rules.requireHash && !doc.sha256) err(`${f}.sha256`, 'required');
      // The same file listed twice: same hash, or same name at the same location.
      // Equal names without a location only count when no hash tells them apart.
      const pathKey = `${doc.location}\u0000${doc.name}`.toLowerCase();
      const comparablePath = Boolean(doc.name) && (Boolean(doc.location) || !doc.sha256);
      let duplicateOf = null;
      if (doc.sha256 && seenHashes.has(doc.sha256)) duplicateOf = seenHashes.get(doc.sha256);
      else if (comparablePath && seenPaths.has(pathKey)) duplicateOf = seenPaths.get(pathKey);
      if (duplicateOf !== null) err(f, 'duplicate_document', { other: duplicateOf });
      else {
        if (doc.sha256) seenHashes.set(doc.sha256, i);
        if (comparablePath) seenPaths.set(pathKey, i);
      }
    });

    if (action?.requiresTargetLabel) {
      if (!out.targetLabelId) err('targetLabelId', 'required');
      else if (targetLabel && !targetLabel.releasable) err('targetLabelId', 'label_not_releasable');
    }
    if (out.external) {
      if (!out.recipients.length) err('recipients', 'required');
      out.recipients.forEach((rec, i) => {
        if (!rec.organization) err(`recipients[${i}].organization`, 'required');
        if (action?.requiresRecipientEmail && !rec.email) err(`recipients[${i}].email`, 'required');
      });
    }
    if (out.dueDate) {
      const earliest = addDays(now(), -1).toISOString().slice(0, 10);
      if (out.dueDate < earliest) err('dueDate', 'date_in_past');
    }
    return { value: out, errors };
  }

  function contentOf(row) {
    return {
      title: row.title,
      action: row.action,
      reasonId: row.reason_id,
      justification: row.justification,
      targetLabelId: row.target_label_id,
      dueDate: row.due_date,
      external: Boolean(row.external),
      documents: documentsOf(row.id).map((d) => ({ name: d.name, location: d.location ?? '', labelId: d.label_id, sizeBytes: d.size_bytes, sha256: d.sha256, note: d.note ?? '' })),
      recipients: recipientsOf(row.id).map((r) => ({ organization: r.organization, name: r.name ?? '', email: r.email ?? '' })),
    };
  }

  function writeContent(id, value, pol) {
    const top = policy.topLabel(pol, value.documents.map((d) => d.labelId).filter(Boolean));
    db.run(
      `UPDATE requests SET title = ?, action = ?, reason_id = ?, justification = ?, target_label_id = ?, due_date = ?, external = ?,
         top_label_id = ?, top_label_rank = ?, document_count = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      value.title, value.action, value.reasonId, value.justification, value.targetLabelId, value.dueDate, value.external,
      top?.id ?? null, top?.rank ?? null, value.documents.length, nowIso(), id,
    );
    db.run('DELETE FROM request_documents WHERE request_id = ?', id);
    value.documents.forEach((doc, i) => {
      db.run(
        'INSERT INTO request_documents (id, request_id, position, name, location, label_id, size_bytes, sha256, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        newId('doc'), id, i, doc.name, doc.location || null, doc.labelId, doc.sizeBytes, doc.sha256, doc.note || null,
      );
    });
    db.run('DELETE FROM request_recipients WHERE request_id = ?', id);
    value.recipients.forEach((rec, i) => {
      db.run(
        'INSERT INTO request_recipients (id, request_id, position, organization, name, email) VALUES (?, ?, ?, ?, ?, ?)',
        newId('rcp'), id, i, rec.organization, rec.name || null, rec.email || null,
      );
    });
  }

  function requireRequester(principal) {
    if (principal.type !== 'user' || !can(principal, 'request.create')) throw fail.forbidden('cannot_create_requests');
  }

  function createDraft(principal, input) {
    requireRequester(principal);
    const pol = policy.current().policy;
    const { value, errors } = normalizeContent(input ?? {}, pol, { strict: false });
    if (errors.length) throw fail.invalid(errors);
    return db.tx(() => {
      const id = newId('req');
      const at = nowIso();
      db.run(
        'INSERT INTO requests (id, requester_id, department_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        id, principal.id, principal.user.department_id, 'draft', at, at,
      );
      writeContent(id, value, pol);
      audit.append(principal, 'request.created', { entityType: 'request', entityId: id, requestId: id, details: { title: value.title } });
      return getRow(id);
    });
  }

  function editable(principal, id, version) {
    const row = getRow(id);
    if (!row || row.requester_id !== principal.id || principal.type !== 'user') throw fail.notFound('request_not_found', 'Request not found');
    if (!['draft', 'returned'].includes(row.status)) throw fail.conflict('not_editable', 'Only drafts and returned requests can be edited');
    if (version !== undefined && version !== null && Number(version) !== row.version) {
      throw fail.conflict('stale_version', 'The request was changed elsewhere', { currentVersion: row.version });
    }
    return row;
  }

  function updateDraft(principal, id, input) {
    const pol = policy.current().policy;
    const { value, errors } = normalizeContent(input ?? {}, pol, { strict: false });
    if (errors.length) throw fail.invalid(errors);
    return db.tx(() => {
      editable(principal, id, input?.version);
      writeContent(id, value, pol);
      return getRow(id);
    });
  }

  function deleteDraft(principal, id) {
    return db.tx(() => {
      const row = editable(principal, id);
      if (row.status !== 'draft') throw fail.conflict('not_deletable', 'Only drafts can be deleted');
      db.run('DELETE FROM requests WHERE id = ?', id);
      audit.append(principal, 'request.deleted', { entityType: 'request', entityId: id, requestId: id, details: { title: row.title } });
      return { deleted: true };
    });
  }

  function nextNumber(pol) {
    const year = now().getFullYear();
    const name = `request:${year}`;
    db.run('INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1', name);
    const value = db.get('SELECT value FROM counters WHERE name = ?', name).value;
    return `${pol.numbering.prefix}-${year}-${String(value).padStart(5, '0')}`;
  }

  function factsOf(pol, value, requester) {
    return policy.factsFor(pol, {
      action: value.action,
      labelIds: value.documents.map((d) => d.labelId).filter(Boolean),
      external: value.external,
      reasonId: value.reasonId,
      departmentId: requester.department_id,
      documentCount: value.documents.length,
    });
  }

  /** Send a draft (or a returned request) into its approval route. */
  function submit(principal, id, { acknowledged = false, version } = {}) {
    const current = policy.current();
    const pol = current.policy;
    return db.tx(() => {
      const row = editable(principal, id, version);
      const requester = users.rowById(row.requester_id);
      const { value, errors } = normalizeContent(contentOf(row), pol, { strict: true });
      if (pol.rules.requireAcknowledgement && acknowledged !== true) errors.push({ field: 'acknowledged', code: 'required' });
      if (errors.length) throw fail.invalid(errors);

      const facts = factsOf(pol, value, requester);
      const route = policy.resolveRoute(pol, facts);
      if (!route) throw fail.unprocessable('no_route', 'No approval route matches this request');
      const { stages, cc } = policy.buildStages(pol, route, requester);

      writeContent(id, value, pol);
      const revision = row.revision + 1;
      const number = row.number ?? nextNumber(pol);
      const at = nowIso();
      const stageRows = stages.map((stage, position) => {
        const stageId = newId('stg');
        db.run(
          `INSERT INTO request_stages (id, request_id, revision, position, name, approver_spec, min_approvals, sla_hours, status, note, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          stageId, id, revision, position, JSON.stringify(stage.name), JSON.stringify(stage.approverSpec), stage.minApprovals, stage.slaHours,
          stage.skipped ? 'skipped' : 'waiting', stage.note, stage.skipped ? at : null,
        );
        for (const user of stage.assignees) db.run('INSERT INTO stage_assignees (stage_id, user_id) VALUES (?, ?)', stageId, user.id);
        return { id: stageId, ...stage };
      });
      db.run('DELETE FROM request_cc WHERE request_id = ?', id);
      for (const user of cc) db.run('INSERT INTO request_cc (request_id, user_id) VALUES (?, ?)', id, user.id);

      const resubmitted = row.status === 'returned';
      const updated = setStatus(row, 'pending', {
        number,
        revision,
        route_id: route.id,
        policy_version: current.version,
        department_id: requester.department_id,
        submitted_at: row.submitted_at ?? at,
        acknowledged_at: pol.rules.requireAcknowledgement ? at : row.acknowledged_at,
        status_reason: null,
        decided_at: null,
      });
      const first = stageRows.find((s) => !s.skipped);
      activateStage(updated, stageById(first.id), requester.name);

      audit.append(principal, resubmitted ? 'request.resubmitted' : 'request.submitted', {
        entityType: 'request',
        entityId: id,
        requestId: id,
        details: {
          number,
          revision,
          title: value.title,
          action: value.action,
          targetLabelId: value.targetLabelId,
          reasonId: value.reasonId,
          external: value.external,
          routeId: route.id,
          routeName: route.name,
          policyVersion: current.version,
          contentHash: sha256Hex(canonicalJson(value)),
          documents: value.documents.map((d) => ({ name: d.name, location: d.location, labelId: d.labelId, sizeBytes: d.sizeBytes, sha256: d.sha256 })),
          recipients: value.recipients,
          stages: stageRows.map((s) => ({ name: s.name, skipped: s.skipped, note: s.note, minApprovals: s.minApprovals, assignees: s.assignees.map((u) => u.name) })),
        },
      });
      return getRow(id);
    });
  }

  /** What the approval route would be for this content, without saving anything. */
  function previewRoute(principal, input) {
    requireRequester(principal);
    const current = policy.current();
    const pol = current.policy;
    const { value } = normalizeContent(input ?? {}, pol, { strict: false });
    const labelIds = value.documents.map((d) => d.labelId).filter(Boolean);
    const warnings = duplicateWarnings(value.documents, input?.id ?? null);
    if (!value.action || !labelIds.length) return { ready: false, external: value.external, warnings };
    const requester = principal.user;
    const facts = factsOf(pol, value, requester);
    const route = policy.resolveRoute(pol, facts);
    if (!route) return { ready: true, external: value.external, error: { code: 'no_route' }, warnings };
    try {
      const { stages, cc } = policy.buildStages(pol, route, requester);
      return {
        ready: true,
        external: value.external,
        route: { id: route.id, name: route.name },
        stages: stages.map((s) => ({
          name: s.name,
          minApprovals: s.minApprovals,
          slaHours: s.slaHours,
          skipped: s.skipped,
          note: s.note,
          assignees: s.assignees.map((u) => users.brief(u)),
        })),
        cc: cc.map((u) => users.brief(u)),
        warnings,
      };
    } catch (err) {
      if (err.status === 422) return { ready: true, external: value.external, route: { id: route.id, name: route.name }, error: { code: err.code, details: err.details }, warnings };
      throw err;
    }
  }

  /** Documents (by hash) that already sit in another open request. */
  function duplicateWarnings(documents, selfId) {
    const warnings = [];
    documents.forEach((doc, index) => {
      if (!doc.sha256) return;
      const other = db.get(
        `SELECT r.id, r.number, r.status FROM request_documents d JOIN requests r ON r.id = d.request_id
         WHERE d.sha256 = ? AND r.id <> ? AND r.status IN ('pending', 'returned', 'approved', 'executing') LIMIT 1`,
        doc.sha256, selfId ?? '',
      );
      if (other) warnings.push({ code: 'document_in_open_request', index, number: other.number });
    });
    return warnings;
  }

  function voidOpenStages(row) {
    db.run("UPDATE request_stages SET status = 'void', completed_at = ? WHERE request_id = ? AND revision = ? AND status IN ('waiting', 'active')", nowIso(), row.id, row.revision);
    db.run('UPDATE requests SET current_stage_id = NULL WHERE id = ?', row.id);
  }

  function cancelOpenExecutions(row, message) {
    const open = db.all("SELECT * FROM executions WHERE request_id = ? AND status IN ('queued', 'dispatching')", row.id);
    for (const exec of open) {
      db.run('UPDATE executions SET status = ?, message = ?, finished_at = ? WHERE id = ?', 'cancelled', message, nowIso(), exec.id);
      db.run("UPDATE outbox SET status = 'failed', last_error = 'cancelled' WHERE kind = 'execution.dispatch' AND ref_id = ? AND status = 'pending'", exec.id);
    }
  }

  function cancel(principal, id, { reason } = {}) {
    if (principal.type !== 'user') throw fail.forbidden();
    const text = typeof reason === 'string' ? cleanText(reason, { multiline: true }).slice(0, 500) : '';
    return db.tx(() => {
      const row = readable(principal, id);
      const isRequester = row.requester_id === principal.id;
      if (!isRequester && !can(principal, 'stage.reassign')) throw fail.forbidden('cannot_cancel');
      if (!isRequester && text.length < 5) throw fail.invalid([{ field: 'reason', code: 'required' }]);
      if (!['pending', 'returned', 'approved'].includes(row.status)) throw fail.conflict('not_cancellable', 'This request can no longer be cancelled');
      const stageAssignees = row.current_stage_id ? assigneeIdsOf(row.current_stage_id) : [];
      voidOpenStages(row);
      cancelOpenExecutions(row, 'request cancelled');
      const updated = setStatus(row, 'cancelled', { status_reason: text || null });
      audit.append(principal, 'request.cancelled', { entityType: 'request', entityId: id, requestId: id, details: { reason: text, by: isRequester ? 'requester' : 'officer', previousStatus: row.status } });
      notifier.push([...stageAssignees, row.requester_id], 'request_cancelled', { requestId: id, payload: notifyPayload(row, { actorName: principal.user.name }), exclude: [principal.id] });
      return updated;
    });
  }

  function clone(principal, id) {
    requireRequester(principal);
    const pol = policy.current().policy;
    return db.tx(() => {
      const source = readable(principal, id);
      if (source.requester_id !== principal.id) throw fail.forbidden('not_your_request');
      const { value } = normalizeContent(contentOf(source), pol, { strict: false });
      value.dueDate = null;
      const newRequestId = newId('req');
      const at = nowIso();
      db.run('INSERT INTO requests (id, requester_id, department_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', newRequestId, principal.id, principal.user.department_id, 'draft', at, at);
      writeContent(newRequestId, value, pol);
      audit.append(principal, 'request.created', { entityType: 'request', entityId: newRequestId, requestId: newRequestId, details: { title: value.title, clonedFrom: source.number ?? source.id } });
      return getRow(newRequestId);
    });
  }

  function addComment(principal, id, body) {
    if (principal.type !== 'user') throw fail.forbidden();
    const text = typeof body === 'string' ? cleanText(body, { multiline: true }) : '';
    if (!text) throw fail.invalid([{ field: 'body', code: 'required' }]);
    if (text.length > 2000) throw fail.invalid([{ field: 'body', code: 'too_long', params: { max: 2000 } }]);
    return db.tx(() => {
      const row = readable(principal, id);
      if (row.status === 'draft') throw fail.conflict('not_commentable');
      const commentId = newId('cmt');
      db.run('INSERT INTO comments (id, request_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)', commentId, id, principal.id, text, nowIso());
      audit.append(principal, 'comment.added', { entityType: 'comment', entityId: commentId, requestId: id, details: { body: text } });
      const participants = [
        row.requester_id,
        ...db.all('SELECT DISTINCT approver_id AS id FROM decisions WHERE request_id = ?', id).map((r) => r.id),
        ...(row.current_stage_id ? assigneeIdsOf(row.current_stage_id) : []),
        ...db.all('SELECT DISTINCT author_id AS id FROM comments WHERE request_id = ?', id).map((r) => r.id),
      ];
      notifier.push(participants, 'comment_added', { requestId: id, payload: notifyPayload(row, { actorName: principal.user.name }), exclude: [principal.id] });
      return { id: commentId };
    });
  }

  // ----- read side ---------------------------------------------------------

  function stageView(stage) {
    const at = nowIso();
    const decisions = decisionsOfStage(stage.id);
    return {
      id: stage.id,
      revision: stage.revision,
      position: stage.position,
      name: parseJson(stage.name, {}),
      status: stage.status,
      minApprovals: stage.min_approvals,
      slaHours: stage.sla_hours,
      note: stage.note,
      activatedAt: stage.activated_at,
      dueAt: stage.due_at,
      completedAt: stage.completed_at,
      overdue: stage.status === 'active' && Boolean(stage.due_at) && stage.due_at < at,
      assignees: assigneeIdsOf(stage.id).map((userId) => ({
        ...users.briefById(userId),
        delegates: stage.status === 'active' || stage.status === 'waiting' ? activeDelegatesOf(userId).map((d) => users.briefById(d)).filter(Boolean) : [],
      })),
      decisions: decisions.map((d) => ({
        id: d.id,
        decision: d.decision,
        comment: d.comment ?? '',
        createdAt: d.created_at,
        approver: users.briefById(d.approver_id),
        onBehalfOf: d.seat_id !== d.approver_id ? users.briefById(d.seat_id) : null,
      })),
    };
  }

  function summary(row) {
    const requester = users.briefById(row.requester_id);
    let currentStage = null;
    if (row.status === 'pending' && row.current_stage_id) {
      const stage = stageById(row.current_stage_id);
      if (stage) {
        currentStage = {
          name: parseJson(stage.name, {}),
          dueAt: stage.due_at,
          overdue: Boolean(stage.due_at) && stage.due_at < nowIso(),
          assignees: assigneeIdsOf(stage.id).map((u) => users.briefById(u)?.name ?? ''),
        };
      }
    }
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      action: row.action,
      reasonId: row.reason_id,
      status: row.status,
      external: Boolean(row.external),
      requester,
      departmentName: users.departmentById(row.department_id)?.name ?? '',
      topLabelId: row.top_label_id,
      documentCount: row.document_count,
      dueDate: row.due_date,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      submittedAt: row.submitted_at,
      decidedAt: row.decided_at,
      completedAt: row.completed_at,
      approvalValidUntil: row.approval_valid_until,
      currentStage,
    };
  }

  function executionView(exec) {
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

  function documentView(doc) {
    return {
      id: doc.id,
      name: doc.name,
      location: doc.location ?? '',
      labelId: doc.label_id,
      sizeBytes: doc.size_bytes,
      sha256: doc.sha256,
      note: doc.note ?? '',
      execStatus: doc.exec_status,
      execNote: doc.exec_note ?? '',
      execHashVerified: doc.exec_hash_verified === null ? null : Boolean(doc.exec_hash_verified),
      execAt: doc.exec_at,
    };
  }

  /** Full request for the detail page. `viewer` is filled in by the API layer. */
  function detail(principal, id) {
    const row = readable(principal, id);
    const stages = allStagesOf(id).map(stageView);
    const timeline = audit.forRequest(id).map((e) => ({
      seq: e.seq,
      ts: e.ts,
      action: e.action,
      actor: { type: e.actorType, id: e.actorId, label: e.actorLabel },
      details: e.details,
    }));
    return {
      ...summary(row),
      targetLabelId: row.target_label_id,
      justification: row.justification,
      statusReason: row.status_reason ?? '',
      revision: row.revision,
      version: row.version,
      routeId: row.route_id,
      policyVersion: row.policy_version,
      acknowledgedAt: row.acknowledged_at,
      closedAt: row.closed_at,
      documents: documentsOf(id).map(documentView),
      recipients: recipientsOf(id).map((r) => ({ organization: r.organization, name: r.name ?? '', email: r.email ?? '' })),
      stages: stages.filter((s) => s.revision === row.revision),
      previousStages: stages.filter((s) => s.revision !== row.revision),
      cc: ccIdsOf(id).map((u) => users.briefById(u)).filter(Boolean),
      executions: db.all('SELECT * FROM executions WHERE request_id = ? ORDER BY attempt', id).map(executionView),
      comments: db.all('SELECT * FROM comments WHERE request_id = ? ORDER BY created_at, rowid', id).map((c) => ({ id: c.id, author: users.briefById(c.author_id), body: c.body, createdAt: c.created_at })),
      timeline,
      names: policy.snapshotNames(row.policy_version),
    };
  }

  function buildListQuery(principal, filters) {
    const where = [];
    const params = [];
    const scope = filters.scope ?? 'mine';
    if (principal.type !== 'user') {
      if (!can(principal, 'request.read.all')) throw fail.forbidden();
      where.push("r.status <> 'draft'");
    } else if (scope === 'all') {
      if (!can(principal, 'request.read.all')) throw fail.forbidden('scope_not_allowed');
      where.push("(r.status <> 'draft' OR r.requester_id = ?)");
      params.push(principal.id);
    } else if (scope === 'involved') {
      where.push(`r.status <> 'draft' AND r.requester_id <> ? AND (
        EXISTS (SELECT 1 FROM request_stages s JOIN stage_assignees a ON a.stage_id = s.id WHERE s.request_id = r.id AND a.user_id = ?)
        OR EXISTS (SELECT 1 FROM decisions d WHERE d.request_id = r.id AND d.approver_id = ?)
        OR EXISTS (SELECT 1 FROM request_cc c WHERE c.request_id = r.id AND c.user_id = ?))`);
      params.push(principal.id, principal.id, principal.id, principal.id);
    } else {
      where.push('r.requester_id = ?');
      params.push(principal.id);
    }
    if (filters.status) {
      const list = String(filters.status).split(',').filter((s) => STATUSES.includes(s));
      if (list.length) {
        where.push(`r.status IN (${list.map(() => '?').join(', ')})`);
        params.push(...list);
      }
    }
    for (const [key, column] of [['action', 'r.action'], ['reasonId', 'r.reason_id'], ['departmentId', 'r.department_id'], ['requesterId', 'r.requester_id']]) {
      if (filters[key]) {
        where.push(`${column} = ?`);
        params.push(String(filters[key]));
      }
    }
    if (filters.labelId) {
      where.push('EXISTS (SELECT 1 FROM request_documents d WHERE d.request_id = r.id AND d.label_id = ?)');
      params.push(String(filters.labelId));
    }
    if (filters.external === 'true' || filters.external === 'false') {
      where.push('r.external = ?');
      params.push(filters.external === 'true');
    }
    if (filters.from) {
      where.push('COALESCE(r.submitted_at, r.created_at) >= ?');
      params.push(String(filters.from));
    }
    if (filters.to) {
      where.push('COALESCE(r.submitted_at, r.created_at) < ?');
      params.push(String(filters.to));
    }
    if (filters.q) {
      const like = '%' + escapeLike(String(filters.q).trim().slice(0, 100)) + '%';
      where.push(`(r.number LIKE ? ESCAPE '\\' OR r.title LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM request_documents d WHERE d.request_id = r.id AND (d.name LIKE ? ESCAPE '\\' OR d.sha256 = ?))
        OR EXISTS (SELECT 1 FROM users u WHERE u.id = r.requester_id AND u.name LIKE ? ESCAPE '\\'))`);
      params.push(like, like, like, String(filters.q).trim().toLowerCase(), like);
    }
    return { clause: 'WHERE ' + where.join(' AND '), params };
  }

  // Ties fall back to insertion order so paging is stable.
  const SORTS = {
    updated: 'r.updated_at DESC, r.rowid DESC',
    submitted: 'COALESCE(r.submitted_at, r.created_at) DESC, r.rowid DESC',
    oldest: 'COALESCE(r.submitted_at, r.created_at) ASC, r.rowid ASC',
    due: "COALESCE(r.due_date, '9999-12-31') ASC, r.updated_at DESC, r.rowid DESC",
  };

  function list(principal, filters = {}) {
    const { clause, params } = buildListQuery(principal, filters);
    const pageSize = clampInt(filters.pageSize, 20, 1, 100);
    const page = clampInt(filters.page, 1, 1, 100000);
    const total = db.get(`SELECT count(*) AS n FROM requests r ${clause}`, ...params).n;
    const rows = db.all(
      `SELECT r.* FROM requests r ${clause} ORDER BY ${SORTS[filters.sort] ?? SORTS.updated} LIMIT ? OFFSET ?`,
      ...params, pageSize, (page - 1) * pageSize,
    );
    return { items: rows.map(summary), total, page, pageSize };
  }

  function statusCounts(principal, filters = {}) {
    const { clause, params } = buildListQuery(principal, { ...filters, status: undefined });
    const out = {};
    for (const row of db.all(`SELECT r.status AS status, count(*) AS n FROM requests r ${clause} GROUP BY r.status`, ...params)) out[row.status] = row.n;
    return out;
  }

  function exportCsv(principal, filters = {}) {
    const { clause, params } = buildListQuery(principal, filters);
    const rows = db.all(`SELECT r.* FROM requests r ${clause} ORDER BY COALESCE(r.submitted_at, r.created_at) DESC LIMIT 20000`, ...params);
    const pol = policy.current().policy;
    const nameOf = (item) => item?.name?.ko ?? item?.name?.en ?? '';
    const columns = [
      { header: 'number', value: (r) => r.number ?? '' },
      { header: 'status', value: (r) => r.status },
      { header: 'title', value: (r) => r.title },
      { header: 'action', value: (r) => nameOf(policy.actionOf(pol, r.action)) || r.action },
      { header: 'reason', value: (r) => nameOf(policy.reasonOf(pol, r.reason_id)) || r.reason_id },
      { header: 'top_label', value: (r) => nameOf(policy.labelOf(pol, r.top_label_id)) || r.top_label_id },
      { header: 'target_label', value: (r) => (r.target_label_id ? nameOf(policy.labelOf(pol, r.target_label_id)) || r.target_label_id : '') },
      { header: 'documents', value: (r) => r.document_count },
      { header: 'external', value: (r) => (r.external ? 'Y' : 'N') },
      { header: 'requester', value: (r) => users.briefById(r.requester_id)?.name ?? '' },
      { header: 'department', value: (r) => users.departmentById(r.department_id)?.name ?? '' },
      { header: 'submitted_at', value: (r) => r.submitted_at },
      { header: 'decided_at', value: (r) => r.decided_at },
      { header: 'completed_at', value: (r) => r.completed_at },
      { header: 'due_date', value: (r) => r.due_date },
      { header: 'route', value: (r) => r.route_id },
      { header: 'policy_version', value: (r) => r.policy_version },
    ];
    audit.append(principal, 'request.exported', { details: { count: rows.length, filters: sanitizeFilters(filters) } });
    return toCsv(columns, rows);
  }

  function sanitizeFilters(filters) {
    const out = {};
    for (const key of ['scope', 'status', 'action', 'reasonId', 'departmentId', 'requesterId', 'labelId', 'external', 'from', 'to', 'q']) {
      if (filters[key] !== undefined && filters[key] !== '') out[key] = String(filters[key]).slice(0, 100);
    }
    return out;
  }

  return {
    createDraft,
    updateDraft,
    deleteDraft,
    submit,
    previewRoute,
    cancel,
    clone,
    addComment,
    detail,
    list,
    statusCounts,
    exportCsv,
    summary,
    readable,
    relationOf,
    core: {
      getRow,
      documentsOf,
      recipientsOf,
      stagesOf,
      stageById,
      assigneeIdsOf,
      decisionsOfStage,
      ccIdsOf,
      setStatus,
      touch,
      activateStage,
      activeDelegationsTo,
      activeDelegatesOf,
      notifyPayload,
      voidOpenStages,
      cancelOpenExecutions,
      cleanText,
    },
  };
}
