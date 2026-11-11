// Approval inbox and the user's own decision history.
import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { t, tl, fmtDateTime, fmtRelative } from '../lib/i18n.js';
import { actionName, reasonName } from '../lib/state.js';
import { pageHeader, tabs, emptyState, labelChip, statusBadge, due } from '../lib/ui.js';

export async function approvalsView({ query, setQuery }) {
  const done = query.state === 'done';
  const { items } = await api.get('/api/approvals', { state: done ? 'done' : undefined });

  const waiting = () => items.map((item) => {
    const r = item.request;
    return h('li.card.approval',
      h('div.spread',
        h('div', h('span.mono.muted', r.number), ' ', h('a.title-link', { href: `#/requests/${r.id}` }, r.title)),
        due(r.currentStage?.dueAt, r.currentStage?.overdue)),
      h('div.row.small',
        labelChip(r.topLabelId),
        h('span', actionName(r.action)),
        h('span.muted', reasonName(r.reasonId)),
        h('span.muted', t('request.docCount', { n: r.documentCount })),
        r.external && h('span.badge.s-returned', t('request.externalTag'))),
      h('div.spread',
        h('span.small', h('span.muted', t('request.requester') + ' '), r.requester?.name, h('span.muted', ` · ${r.departmentName} · ${fmtRelative(r.submittedAt)}`)),
        h('div.row',
          item.actingFor.length > 0 && h('span.badge', t('approval.actingFor', { name: item.actingFor.map((u) => u.name).join(', ') })),
          h('a.btn.small.primary', { href: `#/requests/${r.id}` }, t('approval.review')))));
  });

  const history = () => h('div.table-wrap', h('table.table',
    h('thead', h('tr', h('th', t('request.number')), h('th', t('request.title')), h('th', t('approval.stage')), h('th', t('approval.myDecision')), h('th', t('approval.decidedAt')), h('th', t('request.status')))),
    h('tbody', items.map((item) => h('tr',
      h('td.mono', h('a', { href: `#/requests/${item.request.id}` }, item.request.number)),
      h('td', item.request.title, item.comment && h('div.small.muted', `“${item.comment}”`)),
      h('td', tl(item.stageName), item.onBehalfOf && h('div.small.muted', t('audit.onBehalfOf', { name: item.onBehalfOf.name }))),
      h('td', h(`span.badge.dec-${item.decision}`, t(`decision.${item.decision}`))),
      h('td.muted', fmtDateTime(item.decidedAt)),
      h('td', statusBadge(item.request.status)))))));

  return h('div.stack',
    pageHeader(t('nav.approvals'), t('approval.sub')),
    tabs([['waiting', t('approval.waiting'), done ? 0 : items.length], ['done', t('approval.done')]], done ? 'done' : 'waiting', (id) => setQuery({ state: id === 'done' ? 'done' : undefined })),
    !items.length ? emptyState(t(done ? 'approval.noHistory' : 'approval.empty')) : done ? h('div.card', history()) : h('ul.plain.stack', waiting()));
}
