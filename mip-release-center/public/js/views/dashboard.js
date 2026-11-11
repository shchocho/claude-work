// Home: what needs the user's attention, and their recent requests.
import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { t, tl, fmtNumber } from '../lib/i18n.js';
import { state, can } from '../lib/state.js';
import { pageHeader, requestTable, emptyState, labelChip, due } from '../lib/ui.js';

function stat(label, value, href, tone = '') {
  return h('a.stat', { href, class: tone }, h('span.stat-value', fmtNumber(value)), h('span.stat-label', label));
}

export async function dashboardView() {
  const data = await api.get('/api/dashboard');
  state.badges = data.badges;
  const counts = data.mine.counts;
  const inProgress = (counts.pending ?? 0) + (counts.approved ?? 0) + (counts.executing ?? 0);
  const canCreate = can('request.create');

  const stats = [
    stat(t('dash.toApprove'), data.badges.approvals, '#/approvals', data.badges.approvals ? 'warn' : ''),
    canCreate && stat(t('dash.returned'), data.badges.returned, '#/requests?scope=mine&status=returned', data.badges.returned ? 'warn' : ''),
    canCreate && stat(t('dash.inProgress'), inProgress, '#/requests?scope=mine&status=pending,approved,executing'),
    canCreate && stat(t('dash.completed'), counts.completed ?? 0, '#/requests?scope=mine&status=completed'),
    can('execution.operate') && stat(t('dash.execQueue'), data.badges.executions.queue + data.badges.executions.mine, '#/executions', data.badges.executions.queue ? 'warn' : ''),
  ];

  const org = data.organisation && h('section.card',
    h('h2', t('dash.organisation')),
    h('div.stats',
      stat(t('dash.orgPending'), data.organisation.pending, '#/requests?scope=all&status=pending'),
      stat(t('dash.orgOverdue'), data.organisation.overdueStages, '#/requests?scope=all&status=pending', data.organisation.overdueStages ? 'danger' : ''),
      stat(t('dash.orgAwaitingExec'), data.organisation.awaitingExecution + data.organisation.executing, '#/requests?scope=all&status=approved,executing'),
      stat(t('dash.orgExpiring'), data.organisation.expiringApprovals, '#/requests?scope=all&status=approved', data.organisation.expiringApprovals ? 'warn' : '')));

  return h('div.stack',
    pageHeader(t('dash.hello', { name: state.user.name }), t('app.tagline'),
      canCreate && h('a.btn.primary', { href: '#/requests/new' }, t('request.new'))),
    h('div.stats', stats),
    tl(data.notice) && h('p.notice', tl(data.notice)),
    data.approvals.length > 0 && h('section.card',
      h('div.spread', h('h2', t('dash.approvalsTitle')), h('a', { href: '#/approvals' }, t('common.viewAll'))),
      h('ul.rows', data.approvals.map((item) => h('li',
        h('a.row-link', { href: `#/requests/${item.request.id}` },
          h('span.mono', item.request.number), h('strong', item.request.title),
          labelChip(item.request.topLabelId),
          h('span.muted', item.request.requester?.name),
          item.actingFor.length > 0 && h('span.badge', t('approval.actingFor', { name: item.actingFor.map((u) => u.name).join(', ') })),
          due(item.request.currentStage?.dueAt, item.request.currentStage?.overdue)))))),
    org,
    canCreate && h('section.card',
      h('div.spread', h('h2', t('dash.recent')), h('a', { href: '#/requests' }, t('common.viewAll'))),
      data.mine.recent.length
        ? requestTable(data.mine.recent, { showRequester: false })
        : emptyState(t('dash.noRequests'), h('a.btn.primary', { href: '#/requests/new' }, t('request.new')))),
    !canCreate && !data.approvals.length && !org && emptyState(t('dash.nothing')));
}
