// Time-based housekeeping: overdue reminders, expiry of stale requests and of
// approvals that were never carried out, and pruning of short-lived rows.
import { SYSTEM_ACTOR } from './rbac.js';
import { addDays, parseJson } from './util.js';

export function createSweeper({ db, clock, audit, policy, notifier, requests, auth, outbox, config, logger }) {
  const core = requests.core;
  let timer = null;

  function remindOverdue(at) {
    const stages = db.all(
      `SELECT s.* FROM request_stages s JOIN requests r ON r.id = s.request_id
       WHERE r.status = 'pending' AND s.status = 'active' AND s.due_at IS NOT NULL AND s.due_at < ? AND s.overdue_notified_at IS NULL`,
      at,
    );
    for (const stage of stages) {
      db.tx(() => {
        const row = core.getRow(stage.request_id);
        const stageName = parseJson(stage.name, {});
        db.run('UPDATE request_stages SET overdue_notified_at = ? WHERE id = ?', at, stage.id);
        audit.append(SYSTEM_ACTOR, 'approval.overdue', { entityType: 'stage', entityId: stage.id, requestId: row.id, details: { stageName, dueAt: stage.due_at } });
        const assignees = core.assigneeIdsOf(stage.id);
        const delegates = assignees.flatMap((id) => core.activeDelegatesOf(id));
        notifier.push([...assignees, ...delegates], 'approval_overdue', {
          requestId: row.id,
          payload: core.notifyPayload(row, { stageName, dueAt: stage.due_at }),
          exclude: [row.requester_id],
        });
      });
    }
    return stages.length;
  }

  function expire(row, reason) {
    db.tx(() => {
      const fresh = core.getRow(row.id);
      if (fresh.status !== row.status) return;
      core.voidOpenStages(fresh);
      core.cancelOpenExecutions(fresh, 'request expired');
      core.setStatus(fresh, 'expired', { status_reason: reason });
      audit.append(SYSTEM_ACTOR, 'request.expired', { entityType: 'request', entityId: fresh.id, requestId: fresh.id, details: { reason, previousStatus: fresh.status } });
      notifier.push([fresh.requester_id], 'request_expired', { requestId: fresh.id, payload: core.notifyPayload(fresh, { reason }) });
    });
  }

  /** One pass. Returns what it did so callers and tests can see it. */
  function run() {
    const rules = policy.current().policy.rules;
    const now = clock.now();
    const at = now.toISOString();
    const result = { overdue: remindOverdue(at), expiredWaiting: 0, expiredApprovals: 0 };

    const staleCutoff = addDays(now, -rules.pendingExpiryDays).toISOString();
    for (const row of db.all("SELECT * FROM requests WHERE status IN ('pending', 'returned') AND updated_at < ?", staleCutoff)) {
      expire(row, 'no_activity');
      result.expiredWaiting += 1;
    }
    for (const row of db.all("SELECT * FROM requests WHERE status = 'approved' AND approval_valid_until IS NOT NULL AND approval_valid_until < ?", at)) {
      expire(row, 'approval_validity');
      result.expiredApprovals += 1;
    }
    auth.purgeExpiredSessions();
    notifier.purgeOld();
    outbox.purgeOld();
    return result;
  }

  function safeRun() {
    try {
      const result = run();
      if (result.overdue || result.expiredWaiting || result.expiredApprovals) logger.info('sweep', result);
    } catch (err) {
      logger.error('sweep failed', err);
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(safeRun, config.sweepIntervalSeconds * 1000);
    timer.unref();
    setImmediate(safeRun);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { run, start, stop };
}
