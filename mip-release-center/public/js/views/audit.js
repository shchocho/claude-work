// Audit trail: search, integrity check and export.
import { h, mount, debounce } from '../lib/dom.js';
import { api, qs } from '../lib/api.js';
import { t, fmtDateTime, dayStartIso, dayEndIso, fmtNumber } from '../lib/i18n.js';
import { pageHeader, emptyState, auditLabel, describeAudit, busy, copyButton, errorText } from '../lib/ui.js';

const FAMILIES = ['request.', 'approval.', 'execution.', 'delegation.', 'comment.', 'policy.', 'user.', 'department.', 'token.', 'auth.', 'audit.'];

export async function auditView({ query, setQuery }) {
  const filters = { action: query.action, q: query.q, from: dayStartIso(query.from), to: dayEndIso(query.to), requestId: query.requestId };
  let { items, hasMore, total } = await api.get('/api/audit', { ...filters, limit: 50 });

  const body = h('tbody');
  const moreHost = h('div.row.center');
  const rowsFor = (list) => list.map((e) => {
    const details = h('tr.details-row', { hidden: true }, h('td', { colspan: '5' },
      h('pre.json', JSON.stringify(e.details, null, 2)),
      h('div.small.muted.mono.wrap', `hash ${e.hash}`), h('div.small.muted.mono.wrap', `prev ${e.prevHash}`),
      e.ip && h('div.small.muted', `IP ${e.ip}`)));
    return [h('tr.clickable', { onClick: () => {
      details.hidden = !details.hidden;
    } },
    h('td.mono.muted', e.seq),
    h('td.nowrap', fmtDateTime(e.ts)),
    h('td', e.actorType === 'system' ? h('span.muted', e.actorLabel === 'system' ? t('audit.system') : e.actorLabel) : (e.actorLabel ?? '').replace(/\s*<.*>$/, ''),
      e.actorType === 'token' && h('span.badge', 'API')),
    h('td', h('strong', auditLabel(e.action)), h('div.small.muted.mono', e.action)),
    h('td.small', describeAudit(e), e.requestId && h('div', h('a', { href: `#/requests/${e.requestId}`, onClick: (ev) => ev.stopPropagation() }, t('audit.openRequest'))))),
    details];
  });
  const drawMore = () => mount(moreHost, hasMore && h('button.btn.ghost', { type: 'button', onClick: (ev) => busy(ev.currentTarget, async () => {
    const next = await api.get('/api/audit', { ...filters, limit: 50, beforeSeq: items.at(-1).seq });
    items = items.concat(next.items);
    hasMore = next.hasMore;
    body.append(...rowsFor(next.items).flat());
    drawMore();
  }) }, t('common.loadMore')));
  body.append(...rowsFor(items).flat());
  drawMore();

  const verifyHost = h('div');
  const verify = h('button.btn', { type: 'button', onClick: () => busy(verify, async () => {
    mount(verifyHost, h('p.muted', t('common.loading')));
    try {
      const result = await api.get('/api/audit/verify');
      mount(verifyHost, result.ok
        ? h('div.callout.ok', h('strong', t('audit.verifyOk', { n: fmtNumber(result.count) })),
          h('div.row.small', h('span.muted', t('audit.headHash')), h('code.wrap', result.headHash), copyButton(result.headHash)),
          h('p.small.muted', t('audit.verifyHint')))
        : h('div.callout.danger', h('strong', t('audit.verifyBroken', { seq: result.brokenAt })), h('p.small', t(`audit.problem.${result.problem}`))));
    } catch (err) {
      mount(verifyHost, h('p.field-error', errorText(err)));
    }
  }) }, t('audit.verify'));

  const search = h('input', { type: 'search', value: query.q ?? '', placeholder: t('audit.search'), 'aria-label': t('audit.search') });
  search.addEventListener('input', debounce(() => setQuery({ q: search.value.trim() }), 400));
  if (query.q) queueMicrotask(() => search.focus());
  const exportUrl = (format) => '/api/audit/export' + qs({ action: filters.action, q: filters.q, from: filters.from, to: filters.to, requestId: filters.requestId, format });

  return h('div.stack',
    pageHeader(t('nav.audit'), t('audit.sub'),
      h('a.btn.ghost', { href: exportUrl('csv'), download: '' }, 'CSV'),
      h('a.btn.ghost', { href: exportUrl('jsonl'), download: '' }, 'JSONL'),
      verify),
    verifyHost,
    h('div.card.stack',
      h('div.row.filters',
        h('div.grow', search),
        h('label.field.inline', h('span.field-label', t('audit.family')),
          h('select', { onChange: (e) => setQuery({ action: e.target.value }) }, h('option', { value: '' }, t('common.any')),
            FAMILIES.map((f) => h('option', { value: f, selected: query.action === f }, t(`audit.family.${f.slice(0, -1)}`))))),
        h('label.field.inline', h('span.field-label', t('common.from')), h('input', { type: 'date', value: query.from ?? '', onChange: (e) => setQuery({ from: e.target.value }) })),
        h('label.field.inline', h('span.field-label', t('common.to')), h('input', { type: 'date', value: query.to ?? '', onChange: (e) => setQuery({ to: e.target.value }) })),
        (query.action || query.q || query.from || query.to || query.requestId) && h('a.btn.small.ghost', { href: '#/audit' }, t('common.clearFilters'))),
      items.length
        ? h('div.table-wrap', h('table.table.audit',
          h('thead', h('tr', h('th', '#'), h('th', t('audit.time')), h('th', t('audit.actor')), h('th', t('audit.action')), h('th', t('audit.details')))), body))
        : emptyState(t('audit.empty')),
      h('div.spread', h('span.muted.small', t('common.total', { n: fmtNumber(total) })), moreHost)));
}
