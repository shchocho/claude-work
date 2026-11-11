// Figures for the reports page and the dashboard.
import { addDays, median } from './util.js';

function hoursBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3600_000;
}

function distribution(values) {
  if (!values.length) return { count: 0, medianHours: null, averageHours: null, p90Hours: null };
  const sorted = [...values].sort((x, y) => x - y);
  const round = (n) => Math.round(n * 10) / 10;
  return {
    count: sorted.length,
    medianHours: round(median(sorted)),
    averageHours: round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
    p90Hours: round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]),
  };
}

export function createReports({ db, clock, users }) {
  const nowIso = () => clock.now().toISOString();

  /** Organisation-wide figures for requests submitted in [from, to). */
  function summary({ from, to, departmentId } = {}) {
    const end = to ? new Date(to) : clock.now();
    const start = from ? new Date(from) : addDays(end, -90);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    const where = ['r.submitted_at IS NOT NULL', 'r.submitted_at >= ?', 'r.submitted_at < ?'];
    const params = [start.toISOString(), end.toISOString()];
    if (departmentId) {
      where.push('r.department_id = ?');
      params.push(String(departmentId));
    }
    const clause = 'WHERE ' + where.join(' AND ');
    const group = (expr) =>
      db.all(`SELECT ${expr} AS key, count(*) AS n FROM requests r ${clause} GROUP BY key ORDER BY n DESC`, ...params).map((r) => ({ key: r.key, count: r.n }));

    const rows = db.all(`SELECT r.status, r.external, r.submitted_at, r.decided_at, r.completed_at FROM requests r ${clause}`, ...params);
    const toDecision = [];
    const toCompletion = [];
    for (const row of rows) {
      if (row.decided_at) toDecision.push(hoursBetween(row.submitted_at, row.decided_at));
      if (row.completed_at && row.decided_at) toCompletion.push(hoursBetween(row.decided_at, row.completed_at));
    }
    const stageRows = db.all(
      `SELECT s.due_at, s.completed_at FROM request_stages s JOIN requests r ON r.id = s.request_id
       ${clause} AND s.status IN ('approved', 'rejected', 'returned') AND s.due_at IS NOT NULL`,
      ...params,
    );
    const decisionRows = db.all(
      `SELECT d.decision AS key, count(*) AS n FROM decisions d JOIN requests r ON r.id = d.request_id ${clause} GROUP BY d.decision`,
      ...params,
    );
    const byDepartment = db
      .all(`SELECT r.department_id AS key, count(*) AS n FROM requests r ${clause} GROUP BY r.department_id ORDER BY n DESC LIMIT 15`, ...params)
      .map((r) => ({ key: r.key, name: users.departmentById(r.key)?.name ?? '', count: r.n }));

    return {
      from: start.toISOString(),
      to: end.toISOString(),
      total: rows.length,
      external: rows.filter((r) => r.external).length,
      byStatus: group('r.status'),
      byLabel: group('r.top_label_id'),
      byAction: group('r.action'),
      byReason: group('r.reason_id'),
      byDepartment,
      byMonth: db
        .all(`SELECT substr(r.submitted_at, 1, 7) AS key, count(*) AS n FROM requests r ${clause} GROUP BY key ORDER BY key`, ...params)
        .map((r) => ({ key: r.key, count: r.n })),
      decisions: Object.fromEntries(decisionRows.map((r) => [r.key, r.n])),
      timeToDecision: distribution(toDecision),
      timeToCompletion: distribution(toCompletion),
      sla: {
        measured: stageRows.length,
        late: stageRows.filter((s) => s.completed_at > s.due_at).length,
      },
      backlog: backlog(),
    };
  }

  /** What is open right now, regardless of date range. */
  function backlog() {
    const at = nowIso();
    const count = (sql, ...params) => db.get(sql, ...params).n;
    return {
      pending: count("SELECT count(*) AS n FROM requests WHERE status = 'pending'"),
      returned: count("SELECT count(*) AS n FROM requests WHERE status = 'returned'"),
      awaitingExecution: count("SELECT count(*) AS n FROM requests WHERE status = 'approved'"),
      executing: count("SELECT count(*) AS n FROM requests WHERE status = 'executing'"),
      overdueStages: count("SELECT count(*) AS n FROM request_stages s JOIN requests r ON r.id = s.request_id WHERE r.status = 'pending' AND s.status = 'active' AND s.due_at < ?", at),
      expiringApprovals: count("SELECT count(*) AS n FROM requests WHERE status = 'approved' AND approval_valid_until < ?", addDays(clock.now(), 2).toISOString()),
    };
  }

  return { summary, backlog };
}
