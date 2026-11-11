// Figures over a period: volume, outcomes, lead times.
import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { t, fmtHours, fmtNumber, fmtDate } from '../lib/i18n.js';
import { labelName, actionName, reasonName } from '../lib/state.js';
import { pageHeader, tabs } from '../lib/ui.js';

const RANGES = [['30', 30], ['90', 90], ['365', 365]];

function bars(title, rows, nameOf) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return h('section.card', h('h2', title),
    rows.length
      ? h('ul.bars', rows.map((row) => {
        const fill = h('span.bar-fill');
        fill.style.width = `${Math.max(2, (row.count / max) * 100)}%`;
        return h('li', h('span.bar-name', nameOf(row)), h('span.bar-track', fill), h('span.bar-value', fmtNumber(row.count)));
      }))
      : h('p.muted.small', t('reports.none')));
}

function figure(label, value, hint) {
  return h('div.stat.static', h('span.stat-value', value), h('span.stat-label', label), hint && h('span.muted.small', hint));
}

export async function reportsView({ query, setQuery }) {
  const days = RANGES.find(([id]) => id === query.range)?.[1] ?? 90;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400_000);
  const data = await api.get('/api/reports/summary', { from: from.toISOString(), to: to.toISOString() });
  const share = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : '–');
  const decisions = data.decisions;
  const decided = (decisions.approve ?? 0) + (decisions.reject ?? 0) + (decisions.return ?? 0);

  return h('div.stack',
    pageHeader(t('nav.reports'), `${fmtDate(data.from)} – ${fmtDate(data.to)}`),
    tabs(RANGES.map(([id, n]) => [id, t('reports.lastDays', { n })]), String(days), (id) => setQuery({ range: id })),
    h('div.stats',
      figure(t('reports.submitted'), fmtNumber(data.total)),
      figure(t('reports.external'), share(data.external, data.total), fmtNumber(data.external)),
      figure(t('reports.medianDecision'), fmtHours(data.timeToDecision.medianHours), t('reports.p90', { v: fmtHours(data.timeToDecision.p90Hours) })),
      figure(t('reports.medianExecution'), fmtHours(data.timeToCompletion.medianHours), t('reports.p90', { v: fmtHours(data.timeToCompletion.p90Hours) })),
      figure(t('reports.slaLate'), share(data.sla.late, data.sla.measured), t('reports.ofStages', { n: data.sla.measured })),
      figure(t('reports.rejectRate'), share(decisions.reject ?? 0, decided), t('reports.returnRate', { v: share(decisions.return ?? 0, decided) }))),
    h('section.card', h('h2', t('reports.backlog')),
      h('div.stats',
        figure(t('status.pending'), fmtNumber(data.backlog.pending)),
        figure(t('dash.orgOverdue'), fmtNumber(data.backlog.overdueStages)),
        figure(t('status.returned'), fmtNumber(data.backlog.returned)),
        figure(t('dash.orgAwaitingExec'), fmtNumber(data.backlog.awaitingExecution + data.backlog.executing)),
        figure(t('dash.orgExpiring'), fmtNumber(data.backlog.expiringApprovals)))),
    h('div.grid2',
      bars(t('reports.byMonth'), data.byMonth, (r) => r.key),
      bars(t('reports.byStatus'), data.byStatus, (r) => t(`status.${r.key}`)),
      bars(t('reports.byLabel'), data.byLabel, (r) => labelName(r.key) || '–'),
      bars(t('reports.byAction'), data.byAction, (r) => actionName(r.key)),
      bars(t('reports.byReason'), data.byReason, (r) => reasonName(r.key)),
      bars(t('reports.byDepartment'), data.byDepartment, (r) => r.name || '–')));
}
