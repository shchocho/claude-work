// Approval decisions, delegation and reassignment. The only way to decide on a
// stage is to be one of its named approvers or an approver's active delegate;
// no role grants it.
import { fail } from './http.js';
import { can } from './rbac.js';
import { newId, parseJson, addDays, clampInt } from './util.js';

const DECISIONS = ['approve', 'reject', 'return'];

export function createApprovals({ db, clock, audit, users, policy, notifier, requests, executions }) {
  const core = requests.core;
  const now = () => clock.now();
  const nowIso = () => clock.now().toISOString();

  /**
   * May this user decide on the request's active stage, and in whose seat?
   * A seat is an assigned approver; a delegate decides in the assignee's seat.
   */
  function capacity(userRow, row, stage) {
    if (row.status !== 'pending' || !stage || stage.status !== 'active' || stage.id !== row.current_stage_id) {
      return { can: false, code: 'stage_not_active', seats: [] };
    }
    if (userRow.id === row.requester_id) return { can: false, code: 'own_request', seats: [] };
    const assignees = core.assigneeIdsOf(stage.id);
    const decisions = core.decisionsOfStage(stage.id);
    if (decisions.some((d) => d.approver_id === userRow.id)) return { can: false, code: 'already_decided', seats: [] };
    const takenSeats = new Set(decisions.map((d) => d.seat_id));

    let seats = [];
    if (assignees.includes(userRow.id) && !takenSeats.has(userRow.id)) seats.push(userRow.id);
    for (const delegation of core.activeDelegationsTo(userRow.id)) {
      const principal = users.rowById(delegation.from_user_id);
      if (!principal?.active || !assignees.includes(principal.id) || takenSeats.has(principal.id)) continue;
      if (!seats.includes(principal.id)) seats.push(principal.id);
    }
    if (!seats.length) return { can: false, code: assignees.includes(userRow.id) ? 'already_decided' : 'not_approver', seats: [] };

    if (policy.current().policy.rules.distinctApprovers) {
      const earlier = db.all(
        `SELECT d.approver_id, d.seat_id FROM decisions d JOIN request_stages s ON s.id = d.stage_id
         WHERE d.request_id = ? AND s.revision = ? AND s.position < ? AND d.decision = 'approve'`,
        row.id, row.revision, stage.position,
      );
      const used = new Set(earlier.flatMap((d) => [d.approver_id, d.seat_id]));
      if (used.has(userRow.id)) return { can: false, code: 'approved_earlier_stage', seats: [] };
      seats = seats.filter((seat) => !used.has(seat));
      if (!seats.length) return { can: false, code: 'approved_earlier_stage', seats: [] };
    }
    return { can: true, code: null, seats };
  }

  function capacityFor(principal, row) {
    if (principal.type !== 'user') return { can: false, code: 'not_approver', seats: [] };
    return capacity(principal.user, row, core.stageById(row.current_stage_id));
  }

  function candidateRows(userId) {
    const seatIds = [userId, ...core.activeDelegationsTo(userId).map((d) => d.from_user_id)];
    return db.all(
      `SELECT DISTINCT r.*, s.due_at AS stage_due_at FROM requests r
       JOIN request_stages s ON s.id = r.current_stage_id AND s.status = 'active'
       JOIN stage_assignees a ON a.stage_id = s.id
       WHERE r.status = 'pending' AND r.requester_id <> ? AND a.user_id IN (${seatIds.map(() => '?').join(', ')})
       ORDER BY COALESCE(s.due_at, '9999-12-31') ASC, r.submitted_at ASC`,
      userId, ...seatIds,
    );
  }

  /** Requests waiting for this user's decision, most urgent first. */
  function inbox(principal) {
    if (principal.type !== 'user') return [];
    const items = [];
    for (const row of candidateRows(principal.id)) {
      const stage = core.stageById(row.current_stage_id);
      const cap = capacity(principal.user, row, stage);
      if (!cap.can) continue;
      items.push({
        request: requests.summary(row),
        actingFor: cap.seats.filter((seat) => seat !== principal.id).map((seat) => users.briefById(seat)),
        ownSeat: cap.seats.includes(principal.id),
      });
    }
    return items;
  }

  function pendingCount(principal) {
    return inbox(principal).length;
  }

  /** Decisions this user has made, newest first. */
  function history(principal, { limit } = {}) {
    if (principal.type !== 'user') return [];
    const rows = db.all(
      `SELECT d.*, s.name AS stage_name FROM decisions d JOIN request_stages s ON s.id = d.stage_id
       WHERE d.approver_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`,
      principal.id, clampInt(limit, 50, 1, 200),
    );
    return rows.map((d) => ({
      request: requests.summary(core.getRow(d.request_id)),
      decision: d.decision,
      comment: d.comment ?? '',
      decidedAt: d.created_at,
      stageName: parseJson(d.stage_name, {}),
      onBehalfOf: d.seat_id !== d.approver_id ? users.briefById(d.seat_id) : null,
    }));
  }

  function decide(principal, requestId, input = {}) {
    if (principal.type !== 'user') throw fail.forbidden();
    const decision = input.decision;
    if (!DECISIONS.includes(decision)) throw fail.invalid([{ field: 'decision', code: 'invalid' }]);
    const comment = typeof input.comment === 'string' ? core.cleanText(input.comment, { multiline: true }) : '';
    if (comment.length > 2000) throw fail.invalid([{ field: 'comment', code: 'too_long', params: { max: 2000 } }]);
    const rules = policy.current().policy.rules;
    if (!comment && (decision !== 'approve' || rules.requireCommentOnApproval)) throw fail.invalid([{ field: 'comment', code: 'required' }]);

    return db.tx(() => {
      const row = requests.readable(principal, requestId);
      const stage = core.stageById(row.current_stage_id);
      const cap = capacity(principal.user, row, stage);
      if (!cap.can) throw fail.forbidden(cap.code, 'You cannot decide on this request right now');
      // Prefer the user's own seat; otherwise the seat explicitly asked for, else the first delegated one.
      const seat = cap.seats.includes(principal.id) ? principal.id : cap.seats.includes(input.onBehalfOf) ? input.onBehalfOf : cap.seats[0];
      const at = nowIso();
      const stageName = parseJson(stage.name, {});
      const onBehalfOf = seat !== principal.id ? users.briefById(seat) : null;

      db.run(
        'INSERT INTO decisions (id, request_id, stage_id, approver_id, seat_id, decision, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        newId('dec'), row.id, stage.id, principal.id, seat, decision, comment || null, at,
      );
      const actionName = { approve: 'approval.approved', reject: 'approval.rejected', return: 'approval.returned' }[decision];
      audit.append(principal, actionName, {
        entityType: 'stage',
        entityId: stage.id,
        requestId: row.id,
        details: { stageName, stagePosition: stage.position, revision: row.revision, comment, onBehalfOf: onBehalfOf ? { id: onBehalfOf.id, name: onBehalfOf.name } : null },
      });
      const payload = core.notifyPayload(row, { stageName, actorName: principal.user.name });

      if (decision === 'reject' || decision === 'return') {
        db.run('UPDATE request_stages SET status = ?, completed_at = ? WHERE id = ?', decision === 'reject' ? 'rejected' : 'returned', at, stage.id);
        core.voidOpenStages(row);
        const status = decision === 'reject' ? 'rejected' : 'returned';
        const updated = core.setStatus(row, status, { decided_at: decision === 'reject' ? at : null, status_reason: comment });
        notifier.push([row.requester_id], decision === 'reject' ? 'request_rejected' : 'request_returned', { requestId: row.id, payload });
        return updated;
      }

      const approvals = core.decisionsOfStage(stage.id).filter((d) => d.decision === 'approve').length;
      if (approvals < stage.min_approvals) return core.touch(row.id);

      db.run('UPDATE request_stages SET status = ?, completed_at = ? WHERE id = ?', 'approved', at, stage.id);
      const next = core.stagesOf(row.id, row.revision).find((s) => s.status === 'waiting');
      if (next) {
        const touched = core.touch(row.id);
        core.activateStage(touched, next);
        return core.getRow(row.id);
      }
      const validUntil = addDays(now(), rules.approvalValidityDays).toISOString();
      const approved = core.setStatus(row, 'approved', { decided_at: at, approval_valid_until: validUntil, current_stage_id: null });
      audit.append(principal, 'request.approved', { entityType: 'request', entityId: row.id, requestId: row.id, details: { validUntil, revision: row.revision } });
      notifier.push([row.requester_id], 'request_approved', { requestId: row.id, payload: { ...payload, validUntil } });
      notifier.push(core.ccIdsOf(row.id), 'request_approved_cc', { requestId: row.id, payload, exclude: [row.requester_id, principal.id] });
      executions.enqueue(approved, principal);
      return core.getRow(row.id);
    });
  }

  /** Replace the approvers of an open stage, for absences and departures. */
  function reassign(principal, requestId, stageId, input = {}) {
    if (principal.type !== 'user' || !can(principal, 'stage.reassign')) throw fail.forbidden();
    const reason = typeof input.reason === 'string' ? core.cleanText(input.reason, { multiline: true }).slice(0, 500) : '';
    const userIds = Array.isArray(input.userIds) ? [...new Set(input.userIds.filter((u) => typeof u === 'string'))] : [];
    const errors = [];
    if (reason.length < 5) errors.push({ field: 'reason', code: 'required' });
    if (!userIds.length || userIds.length > 10) errors.push({ field: 'userIds', code: 'required' });
    if (errors.length) throw fail.invalid(errors);

    return db.tx(() => {
      const row = requests.readable(principal, requestId);
      const stage = core.stageById(stageId);
      if (!stage || stage.request_id !== row.id || stage.revision !== row.revision) throw fail.notFound('stage_not_found', 'Stage not found');
      if (row.status !== 'pending' || !['active', 'waiting'].includes(stage.status)) throw fail.conflict('stage_not_open', 'Only open stages can be reassigned');
      const rows = userIds.map((id) => users.rowById(id));
      if (rows.some((u) => !u || !u.active)) throw fail.invalid([{ field: 'userIds', code: 'unknown_user' }]);
      if (rows.some((u) => u.id === row.requester_id)) throw fail.invalid([{ field: 'userIds', code: 'requester_cannot_approve' }]);
      if (rows.length < stage.min_approvals) throw fail.invalid([{ field: 'userIds', code: 'not_enough_approvers', params: { min: stage.min_approvals } }]);

      const before = core.assigneeIdsOf(stage.id);
      db.run('DELETE FROM stage_assignees WHERE stage_id = ?', stage.id);
      for (const user of rows) db.run('INSERT INTO stage_assignees (stage_id, user_id) VALUES (?, ?)', stage.id, user.id);
      db.run("UPDATE request_stages SET note = 'reassigned' WHERE id = ?", stage.id);
      core.touch(row.id);
      const stageName = parseJson(stage.name, {});
      audit.append(principal, 'approval.reassigned', {
        entityType: 'stage',
        entityId: stage.id,
        requestId: row.id,
        details: { stageName, reason, from: before.map((id) => users.briefById(id)?.name ?? id), to: rows.map((u) => u.name) },
      });
      if (stage.status === 'active') {
        notifier.push(rows.map((u) => u.id).filter((id) => !before.includes(id)), 'approval_requested', {
          requestId: row.id,
          payload: core.notifyPayload(row, { stageName, requesterName: users.briefById(row.requester_id)?.name ?? '' }),
        });
      }
      return core.getRow(row.id);
    });
  }

  // ----- delegation --------------------------------------------------------

  function delegationView(d) {
    const at = nowIso();
    const state = d.revoked_at ? 'revoked' : d.ends_at <= at ? 'ended' : d.starts_at > at ? 'upcoming' : 'active';
    return {
      id: d.id,
      from: users.briefById(d.from_user_id),
      to: users.briefById(d.to_user_id),
      startsAt: d.starts_at,
      endsAt: d.ends_at,
      reason: d.reason ?? '',
      state,
      createdAt: d.created_at,
    };
  }

  function listDelegations(principal, { all = false } = {}) {
    const cutoff = addDays(now(), -30).toISOString();
    const rows = all && can(principal, 'user.manage')
      ? db.all('SELECT * FROM delegations WHERE ends_at > ? ORDER BY starts_at DESC LIMIT 300', cutoff)
      : db.all('SELECT * FROM delegations WHERE (from_user_id = ? OR to_user_id = ?) AND ends_at > ? ORDER BY starts_at DESC LIMIT 100', principal.id, principal.id, cutoff);
    return rows.map(delegationView);
  }

  function createDelegation(principal, input = {}) {
    if (principal.type !== 'user') throw fail.forbidden();
    const rules = policy.current().policy.rules;
    const errors = [];
    let fromId = principal.id;
    if (input.fromUserId && input.fromUserId !== principal.id) {
      if (!can(principal, 'user.manage')) throw fail.forbidden('cannot_delegate_for_others');
      fromId = String(input.fromUserId);
    }
    const from = users.rowById(fromId);
    const to = users.rowById(input.toUserId);
    if (!from) errors.push({ field: 'fromUserId', code: 'unknown_user' });
    if (!to || !to.active) errors.push({ field: 'toUserId', code: 'unknown_user' });
    else if (to.id === fromId) errors.push({ field: 'toUserId', code: 'cannot_delegate_to_self' });
    const startsAt = input.startsAt ? new Date(input.startsAt) : now();
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt.getTime())) errors.push({ field: 'startsAt', code: 'invalid_date' });
    if (Number.isNaN(endsAt.getTime())) errors.push({ field: 'endsAt', code: 'invalid_date' });
    else if (!Number.isNaN(startsAt.getTime())) {
      if (endsAt <= startsAt || endsAt <= now()) errors.push({ field: 'endsAt', code: 'date_in_past' });
      else if (endsAt.getTime() - startsAt.getTime() > rules.maxDelegationDays * 86400_000) {
        errors.push({ field: 'endsAt', code: 'delegation_too_long', params: { max: rules.maxDelegationDays } });
      }
    }
    const reason = typeof input.reason === 'string' ? core.cleanText(input.reason).slice(0, 200) : '';
    if (errors.length) throw fail.invalid(errors);

    return db.tx(() => {
      const overlap = db.get(
        'SELECT 1 AS x FROM delegations WHERE from_user_id = ? AND to_user_id = ? AND revoked_at IS NULL AND starts_at < ? AND ends_at > ?',
        fromId, to.id, endsAt.toISOString(), startsAt.toISOString(),
      );
      if (overlap) throw fail.conflict('delegation_overlap', 'A delegation to this person already covers that period');
      const id = newId('dlg');
      db.run(
        'INSERT INTO delegations (id, from_user_id, to_user_id, starts_at, ends_at, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, fromId, to.id, startsAt.toISOString(), endsAt.toISOString(), reason || null, principal.id, nowIso(),
      );
      audit.append(principal, 'delegation.created', {
        entityType: 'delegation',
        entityId: id,
        details: { from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name }, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), reason },
      });
      notifier.push([to.id, ...(fromId !== principal.id ? [fromId] : [])], 'delegation_created', {
        payload: { fromName: from.name, toName: to.name, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
      });
      return delegationView(db.get('SELECT * FROM delegations WHERE id = ?', id));
    });
  }

  function revokeDelegation(principal, id) {
    return db.tx(() => {
      const row = db.get('SELECT * FROM delegations WHERE id = ?', id);
      if (!row || (row.from_user_id !== principal.id && !can(principal, 'user.manage'))) throw fail.notFound();
      if (row.revoked_at || row.ends_at <= nowIso()) return delegationView(row);
      db.run('UPDATE delegations SET revoked_at = ? WHERE id = ?', nowIso(), id);
      audit.append(principal, 'delegation.revoked', {
        entityType: 'delegation', entityId: id,
        details: { from: users.briefById(row.from_user_id)?.name, to: users.briefById(row.to_user_id)?.name },
      });
      return delegationView(db.get('SELECT * FROM delegations WHERE id = ?', id));
    });
  }

  return { capacityFor, inbox, pendingCount, history, decide, reassign, listDelegations, createDelegation, revokeDelegation };
}
