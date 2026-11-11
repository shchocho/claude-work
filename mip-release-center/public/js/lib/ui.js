// Shared interface pieces: dialogs, toasts, badges, pickers, tables.
import { h, mount, icon, debounce } from './dom.js';
import { t, tl, has, fmtDateTime, fmtDate, fmtRelative } from './i18n.js';
import { api } from './api.js';
import { labelOf, labelName, actionName } from './state.js';

// ----- messages -------------------------------------------------------------

export function fieldMessage(detail) {
  const key = `field.${detail.code}`;
  return has(key) ? t(key, detail.params) : detail.code;
}

/** A sentence for any error the API can return. */
export function errorText(err) {
  if (err?.code === 'validation_failed' && Array.isArray(err.details) && err.details.length) {
    return t('error.validation_failed') + ' ' + fieldMessage(err.details[0]);
  }
  const key = `error.${err?.code}`;
  if (err?.code && has(key)) {
    const details = err.details && !Array.isArray(err.details) ? err.details : undefined;
    return t(key, details && { ...details, stageName: tl(details.stageName) });
  }
  return err?.message || t('error.unknown');
}

let toastHost;
export function toast(message, kind = 'info') {
  toastHost ??= document.body.appendChild(h('div.toasts', { role: 'status', 'aria-live': 'polite' }));
  const el = h(`div.toast.${kind}`, message);
  toastHost.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

/** Run an action from a button: no double clicks, errors become a toast. */
export async function busy(button, fn) {
  if (button.disabled) return undefined;
  button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(errorText(err), 'error');
    return undefined;
  } finally {
    button.disabled = false;
  }
}

// ----- dialogs --------------------------------------------------------------

export function openDialog({ title, wide = false }, build) {
  return new Promise((resolve) => {
    const dialog = h('dialog.dialog', { class: wide ? 'wide' : '' });
    let result;
    const close = (value) => {
      result = value;
      dialog.close();
    };
    const body = h('div.dialog-body');
    dialog.append(
      h('header.dialog-head', h('h2', title), h('button.icon-btn', { type: 'button', 'aria-label': t('common.close'), onClick: () => close(undefined) }, icon('x'))),
      body,
    );
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    mount(body, build(close));
    dialog.showModal();
  });
}

/**
 * Ask before acting. With `input` the dialog also collects a text and resolves
 * to it; otherwise it resolves to true. Cancelling resolves to undefined.
 */
export function confirmDialog({ title, message, confirmLabel, danger = false, input }) {
  return openDialog({ title }, (close) => {
    const error = h('p.field-error', { hidden: true });
    const control = input
      ? h(input.multiline === false ? 'input' : 'textarea', { rows: 3, placeholder: input.placeholder ?? '', maxlength: input.maxLength ?? 2000 })
      : null;
    const submit = (event) => {
      event.preventDefault();
      if (!control) return close(true);
      const value = control.value.trim();
      if (value.length < (input.minLength ?? (input.required ? 1 : 0))) {
        error.textContent = input.minLength > 1 ? t('field.too_short', { min: input.minLength }) : t('field.required');
        error.hidden = false;
        control.focus();
        return undefined;
      }
      return close(value);
    };
    return h('form.stack', { onSubmit: submit },
      message && h('p', message),
      control && h('label.field', h('span.field-label', input.label), control, error),
      h('div.row.end',
        h('button.btn.ghost', { type: 'button', onClick: () => close(undefined) }, t('common.cancel')),
        h('button.btn', { class: danger ? 'danger' : 'primary', type: 'submit' }, confirmLabel ?? t('common.confirm'))),
    );
  });
}

// ----- small pieces ---------------------------------------------------------

export function statusBadge(status) {
  return h(`span.badge.s-${status}`, t(`status.${status}`));
}

export function execBadge(status) {
  return h(`span.badge.e-${status}`, t(`exec.${status}`));
}

export function labelChip(id, names) {
  if (!id) return h('span.muted', '–');
  const label = labelOf(id, names);
  const dot = h('span.dot');
  if (label?.color) dot.style.background = label.color;
  return h('span.chip', dot, labelName(id, names));
}

export function person(brief, { withTitle = false } = {}) {
  if (!brief) return h('span.muted', '–');
  const extra = withTitle ? [brief.departmentName, brief.title].filter(Boolean).join(' · ') : '';
  return h('span.person', { class: brief.active === false ? 'inactive' : '' }, brief.name, extra && h('span.muted', ` ${extra}`));
}

export function pageHeader(title, subtitle, ...actions) {
  return h('header.page-head', h('div', h('h1', title), subtitle && h('p.sub', subtitle)), h('div.row', actions));
}

export function emptyState(text, action) {
  return h('div.empty', h('p', text), action);
}

export function field(label, control, { hint, required = false } = {}) {
  return h('label.field', h('span.field-label', label, required && h('span.req', { 'aria-hidden': 'true' }, ' *')), control, hint && h('span.hint', hint));
}

export function check(label, attrs) {
  return h('label.check', h('input', { type: 'checkbox', ...attrs }), h('span', label));
}

export function tabs(items, active, onSelect) {
  return h('div.tabs', { role: 'tablist' }, items.map(([id, label, count]) =>
    h('button', { type: 'button', role: 'tab', 'aria-selected': String(id === active), class: id === active ? 'active' : '', onClick: () => onSelect(id) },
      label, count ? h('span.count', count) : null)));
}

export function pagination({ page, pageSize, total }, onPage) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return h('nav.pager', { 'aria-label': t('common.pages') },
    h('button.btn.small.ghost', { type: 'button', disabled: page <= 1, onClick: () => onPage(page - 1) }, t('common.prev')),
    h('span.muted', `${page} / ${pages}`),
    h('button.btn.small.ghost', { type: 'button', disabled: page >= pages, onClick: () => onPage(page + 1) }, t('common.next')));
}

export function copyButton(text) {
  return h('button.icon-btn.small', {
    type: 'button',
    title: t('common.copy'),
    'aria-label': t('common.copy'),
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast(t('common.copied'));
      } catch {
        toast(text);
      }
    },
  }, icon('copy'));
}

export function kv(pairs) {
  return h('dl.kv', pairs.filter(Boolean).map(([key, value]) => [h('dt', key), h('dd', value ?? '–')]));
}

export function due(iso, overdue) {
  if (!iso) return null;
  return h('span', { class: overdue ? 'overdue' : 'muted', title: fmtDateTime(iso) }, overdue ? t('common.overdue', { when: fmtRelative(iso) }) : t('common.due', { when: fmtRelative(iso) }));
}

// ----- form errors ----------------------------------------------------------

export function clearFieldErrors(root) {
  for (const el of root.querySelectorAll('.field-error.server')) el.remove();
  for (const el of root.querySelectorAll('.invalid')) el.classList.remove('invalid');
}

/**
 * Put validation problems next to the inputs they belong to (matched through
 * data-field) and return the ones that had no input on screen.
 */
export function showFieldErrors(root, details) {
  clearFieldErrors(root);
  const unplaced = [];
  let first = null;
  for (const detail of Array.isArray(details) ? details : []) {
    const target = root.querySelector(`[data-field="${CSS.escape(detail.field ?? '')}"]`);
    if (!target) {
      unplaced.push(detail);
      continue;
    }
    target.classList.add('invalid');
    target.insertAdjacentElement('afterend', h('span.field-error.server', fieldMessage(detail)));
    first ??= target;
  }
  first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  first?.focus?.({ preventScroll: true });
  return unplaced;
}

// ----- user picker ----------------------------------------------------------

/** Search-as-you-type selection of one or several users from the directory. */
export function userPicker({ multiple = false, value = [], onChange = () => {}, placeholder, exclude = [] } = {}) {
  let selected = [...value];
  const chips = h('div.picker-chips');
  const list = h('ul.picker-list', { hidden: true, role: 'listbox' });
  const input = h('input', { type: 'search', placeholder: placeholder ?? t('picker.placeholder'), autocomplete: 'off' });

  const renderChips = () => {
    mount(chips, selected.map((user) =>
      h('span.chip', user.name, user.departmentName && h('span.muted', ` ${user.departmentName}`),
        h('button.chip-x', { type: 'button', 'aria-label': t('common.remove'), onClick: () => {
          selected = selected.filter((u) => u.id !== user.id);
          renderChips();
          onChange(multiple ? selected : null);
        } }, '×'))));
    input.hidden = !multiple && selected.length > 0;
  };
  const choose = (user) => {
    selected = multiple ? [...selected.filter((u) => u.id !== user.id), user] : [user];
    input.value = '';
    list.hidden = true;
    renderChips();
    onChange(multiple ? selected : user);
  };
  const search = debounce(async () => {
    const q = input.value.trim();
    if (!q) {
      list.hidden = true;
      return;
    }
    try {
      const { items } = await api.get('/api/directory/users', { q });
      const options = items.filter((u) => !exclude.includes(u.id) && !selected.some((s) => s.id === u.id));
      mount(list, options.length
        ? options.map((user) => h('li', { role: 'option', tabindex: '0', onClick: () => choose(user), onKeydown: (e) => e.key === 'Enter' && choose(user) },
          h('strong', user.name), h('span.muted', ` ${[user.departmentName, user.title].filter(Boolean).join(' · ')} (${user.login})`)))
        : h('li.muted', t('picker.none')));
      list.hidden = false;
    } catch {
      list.hidden = true;
    }
  }, 250);
  input.addEventListener('input', search);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') list.hidden = true;
    if (e.key === 'ArrowDown') list.querySelector('li[tabindex]')?.focus();
  });
  renderChips();
  const el = h('div.picker', chips, input, list);
  el.getValue = () => (multiple ? selected : selected[0] ?? null);
  return el;
}

// ----- request list table ---------------------------------------------------

export function requestTable(items, { showRequester = true } = {}) {
  return h('div.table-wrap', h('table.table',
    h('thead', h('tr',
      h('th', t('request.number')), h('th', t('request.title')), h('th', t('request.status')), h('th', t('request.label')),
      showRequester && h('th', t('request.requester')), h('th', t('request.stage')), h('th', t('request.updated')))),
    h('tbody', items.map((r) => h('tr',
      h('td.mono', h('a', { href: `#/requests/${r.id}` }, r.number ?? t('request.noNumber'))),
      h('td', h('a.title-link', { href: `#/requests/${r.id}` }, r.title || t('request.untitled')),
        h('div.muted.small', [actionName(r.action), t('request.docCount', { n: r.documentCount }), r.external && t('request.externalTag')].filter(Boolean).join(' · '))),
      h('td', statusBadge(r.status)),
      h('td', labelChip(r.topLabelId)),
      showRequester && h('td', r.requester?.name, h('div.muted.small', r.departmentName)),
      h('td', r.currentStage ? [tl(r.currentStage.name), h('div.small', due(r.currentStage.dueAt, r.currentStage.overdue))] : h('span.muted', '–')),
      h('td.muted', { title: fmtDateTime(r.updatedAt) }, fmtRelative(r.updatedAt)))))));
}

// ----- audit entries --------------------------------------------------------

export function auditLabel(action) {
  const key = `audit.${action}`;
  return has(key) ? t(key) : action;
}

/** One line saying what an audit entry was about, from its details. */
export function describeAudit(entry) {
  const d = entry.details ?? {};
  const parts = [];
  if (d.stageName) parts.push(tl(d.stageName));
  if (d.onBehalfOf?.name) parts.push(t('audit.onBehalfOf', { name: d.onBehalfOf.name }));
  if (d.name && d.status) parts.push(`${d.name}: ${has(`docExec.${d.status}`) ? t(`docExec.${d.status}`) : d.status}`);
  if (d.outcome) parts.push(t(`exec.${d.outcome}`));
  if (d.from && d.to && Array.isArray(d.from)) parts.push(`${d.from.join(', ')} → ${d.to.join(', ')}`);
  else if (d.from?.name && d.to?.name) parts.push(`${d.from.name} → ${d.to.name}`);
  if (d.validUntil) parts.push(t('audit.validUntil', { when: fmtDate(d.validUntil) }));
  if (d.login && !d.changes) parts.push(d.login);
  if (d.changes) parts.push(`${d.login ?? ''} ${Object.keys(d.changes).join(', ')}`.trim());
  if (d.changedSections) parts.push(`v${d.version}: ${d.changedSections.join(', ')}`);
  if (d.number && entry.action.startsWith('request.s')) parts.push(d.number);
  if (d.count !== undefined && d.format) parts.push(`${d.format}, ${d.count}`);
  for (const key of ['comment', 'reason', 'note', 'message', 'body', 'error']) {
    if (typeof d[key] === 'string' && d[key]) parts.push(`“${d[key]}”`);
  }
  return parts.join(' · ');
}

export function timeline(entries) {
  return h('ol.timeline', entries.map((e) => h('li', { class: e.actor.type === 'system' ? 'system' : '' },
    h('div.tl-head', h('strong', auditLabel(e.action)), h('span.muted', { title: e.ts }, fmtDateTime(e.ts))),
    h('div.muted.small', e.actor.type === 'system' ? t('audit.system') : (e.actor.label ?? '').replace(/\s*<.*>$/, '')),
    describeAudit(e) && h('div.tl-detail', describeAudit(e)))));
}
