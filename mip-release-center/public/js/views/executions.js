// Work queue for operators: approved requests waiting to be carried out.
import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { t, fmtDateTime, fmtRelative } from '../lib/i18n.js';
import { actionName } from '../lib/state.js';
import { pageHeader, tabs, emptyState, labelChip, execBadge, person, busy, toast } from '../lib/ui.js';

const TABS = ['queue', 'mine', 'active', 'done'];

export async function executionsView({ query, setQuery, navigate }) {
  const tab = TABS.includes(query.tab) ? query.tab : 'queue';
  const { items, counts } = await api.get('/api/executions', { tab });

  const rows = items.map(({ execution: e, request: r }) => {
    const claim = tab === 'queue' && h('button.btn.small.primary', { type: 'button', onClick: () => busy(claim, async () => {
      await api.post(`/api/executions/${e.id}/claim`);
      toast(t('exec.claimed.toast'), 'ok');
      navigate(`/requests/${r.id}`);
    }) }, t('exec.claim'));
    return h('tr',
      h('td.mono', h('a', { href: `#/requests/${r.id}` }, r.number)),
      h('td', h('a.title-link', { href: `#/requests/${r.id}` }, r.title),
        h('div.small.muted', [actionName(r.action), t('request.docCount', { n: r.documentCount }), r.requester?.name].filter(Boolean).join(' · '))),
      h('td', labelChip(r.topLabelId)),
      h('td', execBadge(e.status), e.attempt > 1 && h('span.muted.small', ` #${e.attempt}`)),
      h('td', e.operator ? person(e.operator) : h('span.muted', '–')),
      h('td.muted', tab === 'done' ? fmtDateTime(e.finishedAt) : r.approvalValidUntil ? t('exec.validUntil', { when: fmtRelative(r.approvalValidUntil) }) : '–'),
      h('td', claim || h('a.btn.small.ghost', { href: `#/requests/${r.id}` }, t('common.open'))));
  });

  return h('div.stack',
    pageHeader(t('nav.executions'), t('exec.sub')),
    h('p.notice', t('exec.manualNotice')),
    tabs([['queue', t('exec.tab.queue'), counts.queue], ['mine', t('exec.tab.mine'), counts.mine], ['active', t('exec.tab.active')], ['done', t('exec.tab.done')]], tab, (id) => setQuery({ tab: id })),
    items.length
      ? h('div.card', h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', t('request.number')), h('th', t('request.title')), h('th', t('request.label')), h('th', t('request.status')), h('th', t('exec.operator')),
          h('th', tab === 'done' ? t('exec.finished') : t('exec.validity')), h('th', ''))),
        h('tbody', rows))))
      : emptyState(t(`exec.empty.${tab}`)));
}
