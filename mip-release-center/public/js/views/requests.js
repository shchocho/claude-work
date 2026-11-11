// Request lists: mine, the ones I am involved in, and (for privileged roles) all.
import { h, debounce } from '../lib/dom.js';
import { api, qs } from '../lib/api.js';
import { t, tl, dayStartIso, dayEndIso } from '../lib/i18n.js';
import { state, can } from '../lib/state.js';
import { pageHeader, requestTable, emptyState, tabs, pagination } from '../lib/ui.js';

const STATUS_ORDER = ['draft', 'returned', 'pending', 'approved', 'executing', 'completed', 'partial', 'failed', 'rejected', 'cancelled', 'expired'];
const FILTER_KEYS = ['scope', 'status', 'q', 'labelId', 'action', 'reasonId', 'external', 'from', 'to', 'sort'];

export async function requestListView({ query, setQuery }) {
  const scopes = [['mine', t('requests.mine')], ['involved', t('requests.involved')]];
  if (can('request.read.all')) scopes.push(['all', t('requests.all')]);
  const scope = scopes.some(([id]) => id === query.scope) ? query.scope : can('request.create') ? 'mine' : scopes.at(-1)[0];
  const filters = { ...Object.fromEntries(FILTER_KEYS.map((k) => [k, query[k]])), scope };
  // Date inputs give local days; the API compares instants.
  const apiFilters = { ...filters, from: dayStartIso(filters.from), to: dayEndIso(filters.to) };
  const data = await api.get('/api/requests', { ...apiFilters, page: query.page, pageSize: 20, counts: 'true' });
  const active = new Set((filters.status ?? '').split(',').filter(Boolean));

  const select = (key, label, options) => h('label.field.inline', h('span.field-label', label),
    h('select', { onChange: (e) => setQuery({ [key]: e.target.value, page: undefined }) },
      h('option', { value: '' }, t('common.any')),
      options.map(([value, text]) => h('option', { value, selected: filters[key] === value }, text))));
  const dateInput = (key, label) => h('label.field.inline', h('span.field-label', label),
    h('input', { type: 'date', value: filters[key] ?? '', onChange: (e) => setQuery({ [key]: e.target.value, page: undefined }) }));

  const search = h('input', { type: 'search', value: filters.q ?? '', placeholder: t('requests.search'), 'aria-label': t('requests.search') });
  search.addEventListener('input', debounce(() => setQuery({ q: search.value.trim(), page: undefined }), 400));
  if (filters.q) queueMicrotask(() => {
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  });

  const statusChips = h('div.row.chips', STATUS_ORDER.filter((s) => data.counts?.[s] || active.has(s)).map((status) =>
    h('button.filter-chip', { type: 'button', 'aria-pressed': String(active.has(status)), onClick: () => {
      const next = new Set(active);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      setQuery({ status: [...next].join(','), page: undefined });
    } }, t(`status.${status}`), h('span.count', data.counts?.[status] ?? 0))));

  const policy = state.policy;
  const more = h('div.row.filters',
    select('labelId', t('request.label'), policy.labels.map((l) => [l.id, tl(l.name)])),
    select('action', t('request.action'), policy.actions.map((a) => [a.id, tl(a.name)])),
    select('reasonId', t('request.reason'), policy.reasons.map((r) => [r.id, tl(r.name)])),
    select('external', t('request.external'), [['true', t('common.yes')], ['false', t('common.no')]]),
    dateInput('from', t('common.from')),
    dateInput('to', t('common.to')),
    h('label.field.inline', h('span.field-label', t('common.sort')),
      h('select', { onChange: (e) => setQuery({ sort: e.target.value, page: undefined }) },
        [['updated', t('sort.updated')], ['submitted', t('sort.submitted')], ['oldest', t('sort.oldest')], ['due', t('sort.due')]]
          .map(([value, text]) => h('option', { value, selected: (filters.sort ?? 'updated') === value }, text)))));

  const hasFilters = FILTER_KEYS.some((k) => k !== 'scope' && filters[k]);
  return h('div.stack',
    pageHeader(t('nav.requests'), t('requests.sub'),
      h('a.btn.ghost', { href: '/api/requests/export.csv' + qs(apiFilters), download: '' }, t('common.exportCsv')),
      can('request.create') && h('a.btn.primary', { href: '#/requests/new' }, t('request.new'))),
    tabs(scopes, scope, (id) => setQuery({ scope: id, page: undefined, status: undefined })),
    h('div.card.stack',
      h('div.row', search, hasFilters && h('a.btn.small.ghost', { href: `#/requests?scope=${scope}` }, t('common.clearFilters'))),
      statusChips,
      h('details.more-filters', { open: ['labelId', 'action', 'reasonId', 'external', 'from', 'to'].some((k) => filters[k]) }, h('summary', t('common.moreFilters')), more),
      data.items.length ? requestTable(data.items, { showRequester: scope !== 'mine' }) : emptyState(t(hasFilters ? 'requests.noMatch' : 'requests.empty')),
      h('div.spread', h('span.muted.small', t('common.total', { n: data.total })), pagination(data, (page) => setQuery({ page })))));
}
