// Administration: accounts, departments, API tokens, system status.
import { h, mount, debounce } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { t, fmtDateTime, fmtRelative, fmtNumber } from '../lib/i18n.js';
import { state } from '../lib/state.js';
import { pageHeader, tabs, toast, errorText, busy, openDialog, confirmDialog, userPicker, check, field, showFieldErrors, pagination, copyButton, kv, emptyState } from '../lib/ui.js';

const SECTIONS = ['users', 'departments', 'tokens', 'system'];

/** Show a secret exactly once, with a way to copy it. */
function revealSecret(title, message, secret) {
  return openDialog({ title }, (close) => h('div.stack',
    h('p', message),
    h('div.row.secret', h('code.wrap', secret), copyButton(secret)),
    h('div.row.end', h('button.btn.primary', { type: 'button', onClick: () => close(true) }, t('common.done')))));
}

async function submitForm(form, button, fn) {
  button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    if (showFieldErrors(form, err.details).length || !Array.isArray(err.details)) toast(errorText(err), 'error');
    return undefined;
  } finally {
    button.disabled = false;
  }
}

function userDialog(user, departments) {
  return openDialog({ title: user ? t('admin.editUser') : t('admin.newUser'), wide: true }, (close) => {
    const model = { login: user?.login ?? '', name: user?.name ?? '', title: user?.title ?? '', email: user?.email ?? '', departmentId: user?.departmentId ?? '', roles: new Set(user?.roles ?? ['requester']), active: user?.active ?? true };
    const input = (key, attrs = {}) => h('input', { value: model[key], dataset: { field: key }, onInput: (e) => {
      model[key] = e.target.value;
    }, ...attrs });
    const manager = userPicker({ value: user?.managerId ? [{ id: user.managerId, name: user.managerName }] : [], exclude: user ? [user.id] : [] });
    const button = h('button.btn.primary', { type: 'submit' }, t('common.save'));
    const form = h('form.stack', { onSubmit: async (event) => {
      event.preventDefault();
      const body = { name: model.name, title: model.title, email: model.email, departmentId: model.departmentId || null, managerId: manager.getValue()?.id ?? null, roles: [...model.roles], active: model.active };
      const result = await submitForm(form, button, () => (user ? api.put(`/api/admin/users/${user.id}`, body) : api.post('/api/admin/users', { ...body, login: model.login })));
      if (result) close(result);
    } },
    h('div.form-grid',
      field(t('auth.loginId'), input('login', { readOnly: Boolean(user), maxlength: 100, required: true }), { required: true, hint: user ? undefined : t('admin.loginHint') }),
      field(t('admin.name'), input('name', { maxlength: 80, required: true }), { required: true }),
      field(t('admin.title'), input('title', { maxlength: 80 })),
      field(t('admin.email'), input('email', { type: 'email', maxlength: 254 })),
      field(t('admin.department'), h('select', { dataset: { field: 'departmentId' }, onChange: (e) => {
        model.departmentId = e.target.value;
      } }, h('option', { value: '' }, '–'), departments.map((d) => h('option', { value: d.id, selected: d.id === model.departmentId }, d.name + (d.active ? '' : ` (${t('admin.inactive')})`))))),
      h('div.field', h('span.field-label', t('admin.manager')), h('div', { dataset: { field: 'managerId' } }, manager), h('span.hint', t('admin.managerHint')))),
    h('fieldset.field', h('legend.field-label', t('admin.roles')),
      h('div.stack.tight', { dataset: { field: 'roles' } }, state.app.roles.map((role) => check(h('span', h('strong', t(`role.${role}`)), h('span.muted.small', ` ${t(`role.${role}.hint`)}`)), { checked: model.roles.has(role), onChange: (e) => {
        if (e.target.checked) model.roles.add(role);
        else model.roles.delete(role);
      } })))),
    user && check(t('admin.active'), { checked: model.active, onChange: (e) => {
      model.active = e.target.checked;
    } }),
    h('div.row.end', h('button.btn.ghost', { type: 'button', onClick: () => close(undefined) }, t('common.cancel')), button));
    return form;
  });
}

function departmentDialog(department, departments) {
  return openDialog({ title: department ? t('admin.editDepartment') : t('admin.newDepartment') }, (close) => {
    const name = h('input', { value: department?.name ?? '', maxlength: 80, required: true, dataset: { field: 'name' } });
    const parent = h('select', { dataset: { field: 'parentId' } }, h('option', { value: '' }, t('admin.noParent')),
      departments.filter((d) => d.id !== department?.id).map((d) => h('option', { value: d.id, selected: d.id === department?.parentId }, d.name)));
    const active = h('input', { type: 'checkbox', checked: department?.active ?? true });
    const button = h('button.btn.primary', { type: 'submit' }, t('common.save'));
    const form = h('form.stack', { onSubmit: async (event) => {
      event.preventDefault();
      const body = { name: name.value, parentId: parent.value || null, active: active.checked };
      const result = await submitForm(form, button, () => (department ? api.put(`/api/admin/departments/${department.id}`, body) : api.post('/api/admin/departments', body)));
      if (result) close(result);
    } },
    field(t('admin.name'), name, { required: true }),
    field(t('admin.parent'), parent),
    department && h('label.check', active, h('span', t('admin.active'))),
    h('div.row.end', h('button.btn.ghost', { type: 'button', onClick: () => close(undefined) }, t('common.cancel')), button));
    return form;
  });
}

function tokenDialog() {
  return openDialog({ title: t('admin.newToken') }, (close) => {
    const name = h('input', { maxlength: 80, required: true, dataset: { field: 'name' }, placeholder: t('admin.tokenNamePh') });
    const days = h('input.num', { type: 'number', min: 1, max: 3650, value: 365, dataset: { field: 'expiresInDays' } });
    const scopes = new Set(['audit:read']);
    const button = h('button.btn.primary', { type: 'submit' }, t('admin.createToken'));
    const form = h('form.stack', { onSubmit: async (event) => {
      event.preventDefault();
      const result = await submitForm(form, button, () => api.post('/api/admin/tokens', { name: name.value, scopes: [...scopes], expiresInDays: days.value ? Number(days.value) : null }));
      if (result) close(result);
    } },
    h('p.muted.small', t('admin.tokenHint')),
    field(t('admin.name'), name, { required: true }),
    h('fieldset.field', h('legend.field-label', t('admin.scopes')), h('div.stack.tight', { dataset: { field: 'scopes' } },
      state.app.tokenScopes.map((scope) => check(h('span', h('code', scope), h('span.muted.small', ` ${t(`scope.${scope}`)}`)), { checked: scopes.has(scope), onChange: (e) => {
        if (e.target.checked) scopes.add(scope);
        else scopes.delete(scope);
      } })))),
    field(t('admin.expiresInDays'), days, { hint: t('admin.expiresHint') }),
    h('div.row.end', h('button.btn.ghost', { type: 'button', onClick: () => close(undefined) }, t('common.cancel')), button));
    return form;
  });
}

export async function adminView({ query, setQuery, reload }) {
  const section = SECTIONS.includes(query.section) ? query.section : 'users';
  const content = h('div.stack');

  if (section === 'users') {
    const [list, departments] = await Promise.all([
      api.get('/api/admin/users', { q: query.q, role: query.role, active: query.active, page: query.page, pageSize: 25 }),
      api.get('/api/admin/departments'),
    ]);
    const search = h('input', { type: 'search', value: query.q ?? '', placeholder: t('admin.searchUsers'), 'aria-label': t('admin.searchUsers') });
    search.addEventListener('input', debounce(() => setQuery({ q: search.value.trim(), page: undefined }), 400));
    if (query.q) queueMicrotask(() => search.focus());
    const edit = async (user) => {
      const result = await userDialog(user, departments.items);
      if (!result) return;
      if (result.temporaryPassword) await revealSecret(t('admin.tempPasswordTitle'), t('admin.tempPasswordMessage', { login: result.user.login }), result.temporaryPassword);
      toast(t('common.saved'), 'ok');
      reload();
    };
    mount(content,
      h('div.row',
        h('div.grow', search),
        h('select', { 'aria-label': t('admin.roles'), onChange: (e) => setQuery({ role: e.target.value, page: undefined }) }, h('option', { value: '' }, t('admin.allRoles')),
          state.app.roles.map((role) => h('option', { value: role, selected: query.role === role }, t(`role.${role}`)))),
        h('select', { 'aria-label': t('admin.active'), onChange: (e) => setQuery({ active: e.target.value, page: undefined }) },
          [['', t('common.any')], ['true', t('admin.activeOnly')], ['false', t('admin.inactiveOnly')]].map(([value, label]) => h('option', { value, selected: (query.active ?? '') === value }, label))),
        h('button.btn.primary', { type: 'button', onClick: () => edit(null) }, t('admin.newUser'))),
      h('div.card', list.items.length
        ? h('div.table-wrap', h('table.table',
          h('thead', h('tr', h('th', t('admin.name')), h('th', t('auth.loginId')), h('th', t('admin.department')), h('th', t('admin.manager')), h('th', t('admin.roles')), h('th', t('admin.lastLogin')), h('th', ''))),
          h('tbody', list.items.map((user) => h('tr', { class: user.active ? '' : 'inactive-row' },
            h('td', h('strong', user.name), h('div.small.muted', user.title), !user.active && h('span.badge.s-cancelled', t('admin.inactive'))),
            h('td.mono', user.login),
            h('td', user.departmentName || '–'),
            h('td', user.managerName || h('span.muted', '–')),
            h('td', h('div.row.wrap.tight', user.roles.map((role) => h('span.badge', t(`role.${role}`))))),
            h('td.muted.small', user.lastLoginAt ? fmtRelative(user.lastLoginAt) : '–'),
            h('td', h('div.row.nowrap',
              h('button.btn.small.ghost', { type: 'button', onClick: () => edit(user) }, t('common.edit')),
              state.app.authMode === 'local' && h('button.btn.small.ghost', { type: 'button', onClick: async (e) => {
                const button = e.currentTarget;
                if (!(await confirmDialog({ title: t('admin.resetPassword'), message: t('admin.resetPasswordMessage', { name: user.name }), danger: true }))) return;
                busy(button, async () => {
                  const { temporaryPassword } = await api.post(`/api/admin/users/${user.id}/reset-password`);
                  await revealSecret(t('admin.tempPasswordTitle'), t('admin.tempPasswordMessage', { login: user.login }), temporaryPassword);
                });
              } }, t('admin.resetPassword')))))))))
        : emptyState(t('admin.noUsers'))),
      h('div.spread', h('span.muted.small', t('common.total', { n: list.total })), pagination(list, (page) => setQuery({ page }))));
  }

  if (section === 'departments') {
    const { items } = await api.get('/api/admin/departments');
    const nameOf = (id) => items.find((d) => d.id === id)?.name ?? '–';
    const edit = async (department) => {
      if (await departmentDialog(department, items)) {
        toast(t('common.saved'), 'ok');
        reload();
      }
    };
    mount(content,
      h('div.row.end', h('button.btn.primary', { type: 'button', onClick: () => edit(null) }, t('admin.newDepartment'))),
      h('div.card', items.length
        ? h('div.table-wrap', h('table.table',
          h('thead', h('tr', h('th', t('admin.name')), h('th', t('admin.parent')), h('th', t('request.status')), h('th', ''))),
          h('tbody', items.map((d) => h('tr',
            h('td', h('strong', d.name)), h('td', d.parentId ? nameOf(d.parentId) : h('span.muted', '–')),
            h('td', d.active ? t('admin.active') : h('span.badge.s-cancelled', t('admin.inactive'))),
            h('td', h('button.btn.small.ghost', { type: 'button', onClick: () => edit(d) }, t('common.edit'))))))))
        : emptyState(t('admin.noDepartments'))));
  }

  if (section === 'tokens') {
    const { items } = await api.get('/api/admin/tokens');
    const create = async () => {
      const result = await tokenDialog();
      if (!result) return;
      await revealSecret(t('admin.tokenCreatedTitle'), t('admin.tokenCreatedMessage'), result.secret);
      reload();
    };
    const stateOf = (token) => (token.revokedAt ? 'revoked' : token.expiresAt && new Date(token.expiresAt) <= new Date() ? 'expired' : 'active');
    mount(content,
      h('div.spread', h('p.muted', t('admin.tokensSub')), h('button.btn.primary', { type: 'button', onClick: create }, t('admin.newToken'))),
      h('div.card', items.length
        ? h('div.table-wrap', h('table.table',
          h('thead', h('tr', h('th', t('admin.name')), h('th', t('admin.scopes')), h('th', t('admin.tokenState')), h('th', t('admin.expires')), h('th', t('admin.lastUsed')), h('th', ''))),
          h('tbody', items.map((token) => h('tr',
            h('td', h('strong', token.name), h('div.small.muted.mono', `…${token.hint}`)),
            h('td', h('div.row.wrap.tight', token.scopes.map((s) => h('code', s)))),
            h('td', h(`span.badge.tk-${stateOf(token)}`, t(`admin.token.${stateOf(token)}`))),
            h('td.muted.small', token.expiresAt ? fmtDateTime(token.expiresAt) : t('admin.never')),
            h('td.muted.small', token.lastUsedAt ? fmtRelative(token.lastUsedAt) : '–'),
            h('td', stateOf(token) === 'active' && h('button.btn.small.ghost.danger-text', { type: 'button', onClick: async (e) => {
              const button = e.currentTarget;
              if (!(await confirmDialog({ title: t('admin.revoke'), message: t('admin.revokeMessage', { name: token.name }), danger: true }))) return;
              busy(button, async () => {
                await api.del(`/api/admin/tokens/${token.id}`);
                reload();
              });
            } }, t('admin.revoke'))))))))
        : emptyState(t('admin.noTokens'))));
  }

  if (section === 'system') {
    const sys = await api.get('/api/admin/system');
    mount(content,
      h('div.grid2',
        h('section.card', h('h2', t('admin.sys.app')), kv([
          [t('admin.sys.version'), `${sys.version} (Node ${sys.node})`],
          [t('admin.sys.baseUrl'), h('code', sys.baseUrl)],
          [t('admin.sys.auth'), t(`admin.sys.auth.${sys.authMode}`)],
          [t('admin.sys.session'), t('admin.sys.sessionValue', { idle: sys.session.idleMinutes, max: sys.session.maxHours })],
          [t('admin.sys.demo'), sys.demo ? t('common.yes') : t('common.no')],
          [t('admin.sys.policyVersion'), `v${sys.policyVersion}`],
        ])),
        h('section.card', h('h2', t('admin.sys.counts')), kv([
          [t('admin.sys.users'), fmtNumber(sys.counts.users)],
          [t('admin.sys.requests'), fmtNumber(sys.counts.requests)],
          [t('admin.sys.auditEntries'), fmtNumber(sys.counts.auditEntries)],
          [t('admin.sys.openExecutions'), fmtNumber(sys.counts.openExecutions)],
          [t('admin.sys.sessions'), fmtNumber(sys.sessions)],
        ])),
        h('section.card', h('h2', t('policy.executor')), kv([
          [t('admin.sys.execMode'), t(`exec.mode.${sys.executor.mode}`)],
          sys.executor.mode !== sys.executor.requestedMode && [t('admin.sys.execRequested'), h('span.overdue', t(`exec.mode.${sys.executor.requestedMode}`) + ' ' + t('policy.executorUnavailable'))],
          [t('admin.sys.execWebhook'), sys.executor.webhookConfigured ? h('code', sys.executor.webhookHost) : t('admin.sys.notConfigured')],
        ])),
        h('section.card', h('h2', t('admin.sys.notifications')), kv([
          [t('admin.sys.notifyWebhook'), sys.notifications.webhookConfigured ? h('code', sys.notifications.webhookHost) : t('admin.sys.notConfigured')],
          sys.notifications.webhookConfigured && [t('admin.sys.signed'), sys.notifications.signed ? t('common.yes') : t('common.no')],
          [t('admin.sys.outbox'), t('admin.sys.outboxValue', sys.outbox)],
        ]))),
      h('p.muted.small', t('admin.sys.hint')));
  }

  return h('div.stack',
    pageHeader(t('nav.admin'), t('admin.sub')),
    tabs(SECTIONS.map((id) => [id, t(`admin.section.${id}`)]), section, (id) => setQuery({ section: id, q: undefined, role: undefined, active: undefined, page: undefined })),
    content);
}
