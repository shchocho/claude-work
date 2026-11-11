// Personal settings: language, password, and who approves while I am away.
import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { t, LOCALES, getLocale, fmtDateTime } from '../lib/i18n.js';
import { state, can } from '../lib/state.js';
import { pageHeader, toast, errorText, busy, userPicker, field, kv, showFieldErrors, clearFieldErrors, confirmDialog, person, emptyState } from '../lib/ui.js';
import { reloadSession } from '../main.js';

/** Value for a datetime-local input, in local time. */
function localInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export async function settingsView({ reload }) {
  const user = state.user;
  const { items: delegations } = await api.get('/api/delegations', { all: can('user.manage') ? 'true' : undefined });

  // ----- delegation --------------------------------------------------------
  const now = new Date();
  const to = userPicker({ exclude: [user.id], placeholder: t('settings.delegateTo') });
  const from = can('user.manage') ? userPicker({ placeholder: t('settings.delegateFromPh') }) : null;
  const startsAt = h('input', { type: 'datetime-local', value: localInput(now), dataset: { field: 'startsAt' } });
  const endsAt = h('input', { type: 'datetime-local', value: localInput(new Date(now.getTime() + 7 * 86400_000)), dataset: { field: 'endsAt' } });
  const reason = h('input', { maxlength: 200, placeholder: t('settings.delegateReasonPh') });
  const addButton = h('button.btn.primary', { type: 'submit' }, t('settings.delegateAdd'));
  const delegationForm = h('form.stack', { onSubmit: async (event) => {
    event.preventDefault();
    clearFieldErrors(delegationForm);
    const target = to.getValue();
    if (!target) {
      showFieldErrors(delegationForm, [{ field: 'toUserId', code: 'required' }]);
      return;
    }
    addButton.disabled = true;
    try {
      await api.post('/api/delegations', {
        toUserId: target.id,
        fromUserId: from?.getValue()?.id,
        startsAt: new Date(startsAt.value).toISOString(),
        endsAt: new Date(endsAt.value).toISOString(),
        reason: reason.value,
      });
      toast(t('settings.delegateAdded'), 'ok');
      reload();
    } catch (err) {
      if (showFieldErrors(delegationForm, err.details).length || !Array.isArray(err.details)) toast(errorText(err), 'error');
    } finally {
      addButton.disabled = false;
    }
  } },
  h('div.form-grid',
    from && h('div.field', h('span.field-label', t('settings.delegateFrom')), h('div', { dataset: { field: 'fromUserId' } }, from), h('span.hint', t('settings.delegateFromHint'))),
    h('div.field', h('span.field-label', t('settings.delegateTo'), h('span.req', ' *')), h('div', { dataset: { field: 'toUserId' } }, to)),
    field(t('settings.startsAt'), startsAt),
    field(t('settings.endsAt'), endsAt, { hint: t('settings.delegateMax', { n: state.policy.rules.maxDelegationDays }) }),
    field(t('settings.delegateReason'), reason)),
  h('div.row.end', addButton));

  const delegationList = delegations.length
    ? h('div.table-wrap', h('table.table',
      h('thead', h('tr', h('th', t('settings.delegateFrom')), h('th', t('settings.delegateTo')), h('th', t('settings.period')), h('th', t('request.status')), h('th', ''))),
      h('tbody', delegations.map((d) => h('tr',
        h('td', person(d.from)), h('td', person(d.to)),
        h('td.small', `${fmtDateTime(d.startsAt)} – ${fmtDateTime(d.endsAt)}`, d.reason && h('div.muted', d.reason)),
        h('td', h(`span.badge.dl-${d.state}`, t(`settings.delegation.${d.state}`))),
        h('td', ['active', 'upcoming'].includes(d.state) && (d.from?.id === user.id || can('user.manage')) && h('button.btn.small.ghost.danger-text', { type: 'button', onClick: async (e) => {
          const button = e.currentTarget;
          if (!(await confirmDialog({ title: t('settings.delegateRevoke'), message: t('settings.delegateRevokeMessage'), danger: true }))) return;
          busy(button, async () => {
            await api.del(`/api/delegations/${d.id}`);
            reload();
          });
        } }, t('settings.delegateRevoke'))))))))
    : emptyState(t('settings.noDelegations'));

  // ----- password ----------------------------------------------------------
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true, dataset: { field: 'current' } });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, dataset: { field: 'password' } });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: true, dataset: { field: 'again' } });
  const passwordButton = h('button.btn', { type: 'submit' }, t('settings.changePassword'));
  const passwordForm = h('form.stack', { onSubmit: async (event) => {
    event.preventDefault();
    clearFieldErrors(passwordForm);
    if (next.value !== again.value) {
      showFieldErrors(passwordForm, [{ field: 'again', code: 'password_mismatch' }]);
      return;
    }
    passwordButton.disabled = true;
    try {
      await api.post('/api/me/password', { current: current.value, next: next.value });
      toast(t('settings.passwordChanged'), 'ok');
      passwordForm.reset();
    } catch (err) {
      if (showFieldErrors(passwordForm, err.details).length || !Array.isArray(err.details)) toast(errorText(err), 'error');
    } finally {
      passwordButton.disabled = false;
    }
  } },
  h('div.form-grid',
    field(t('settings.currentPassword'), current),
    field(t('settings.newPassword'), next, { hint: t('settings.passwordHint', { n: state.app.passwordMinLength }) }),
    field(t('settings.newPasswordAgain'), again)),
  h('div.row.end', passwordButton));

  const language = h('select', { 'aria-label': t('settings.language'), onChange: async (e) => {
    try {
      await api.put('/api/me', { locale: e.target.value });
      await reloadSession();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  } }, LOCALES.map(([id, name]) => h('option', { value: id, selected: id === getLocale() }, name)));

  const host = h('div.stack');
  mount(host,
    pageHeader(t('nav.settings'), t('settings.sub')),
    h('section.card.stack', h('h2', t('settings.profile')),
      kv([
        [t('admin.name'), user.name],
        [t('auth.loginId'), h('span.mono', user.login)],
        [t('admin.department'), [user.departmentName, user.title].filter(Boolean).join(' · ') || '–'],
        [t('admin.manager'), user.managerName || '–'],
        [t('admin.roles'), h('div.row.wrap.tight', user.roles.map((role) => h('span.badge', t(`role.${role}`))))],
        [t('settings.language'), language],
      ]),
      h('p.muted.small', t('settings.profileHint'))),
    h('section.card.stack', h('h2', t('settings.delegation')), h('p.muted', t('settings.delegationHint')), delegationList, h('h3', t('settings.delegateNew')), delegationForm),
    state.app.authMode === 'local' && user.hasPassword && h('section.card.stack', h('h2', t('settings.changePassword')), passwordForm));
  return host;
}
