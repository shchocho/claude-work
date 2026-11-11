// Sign-in and the forced change of a temporary password.
import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { t, LOCALES, getLocale, setLocale } from '../lib/i18n.js';
import { errorText, showFieldErrors, clearFieldErrors } from '../lib/ui.js';

function languageSwitch(rerender) {
  return h('div.row.center.small', LOCALES.map(([id, name]) =>
    h('button.link', { type: 'button', class: id === getLocale() ? 'active' : '', onClick: () => {
      setLocale(id);
      rerender();
    } }, name)));
}

export function loginView({ app, message, onDone }) {
  const host = h('div.login');
  const render = () => {
    const error = h('p.field-error', { role: 'alert', hidden: !message }, message ?? '');
    const login = h('input', { name: 'login', autocomplete: 'username', required: true, autofocus: true });
    const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    const button = h('button.btn.primary.block', { type: 'submit' }, t('auth.login'));
    const submit = async (event) => {
      event.preventDefault();
      button.disabled = true;
      error.hidden = true;
      try {
        onDone(await api.post('/api/login', { login: login.value, password: password.value }));
      } catch (err) {
        error.textContent = errorText(err);
        error.hidden = false;
        password.value = '';
        password.focus();
      } finally {
        button.disabled = false;
      }
    };
    const form = app?.authMode === 'header'
      ? h('div.stack', h('p', t('auth.ssoOnly')), h('button.btn.primary.block', { type: 'button', onClick: () => location.reload() }, t('common.retry')))
      : h('form.stack', { onSubmit: submit },
        h('label.field', h('span.field-label', t('auth.loginId')), login),
        h('label.field', h('span.field-label', t('auth.password')), password),
        error, button);

    const demo = app?.demo && app.demoAccounts && h('div.card.demo-accounts',
      h('h2', t('auth.demoTitle')),
      h('p.muted.small', t('auth.demoHint', { password: app.demoPassword })),
      h('ul', app.demoAccounts.map((account) => h('li',
        h('button.link', { type: 'button', onClick: () => {
          login.value = account.login;
          password.value = app.demoPassword;
          password.focus();
        } }, account.name),
        h('span.muted.small', ` ${account.title} · ${account.roles.map((r) => t(`role.${r}`)).join(', ')}`)))));

    host.replaceChildren(
      h('div.login-box',
        h('div.brand.big', h('span.brand-mark', 'MIP'), h('span', t('app.name'))),
        h('p.muted', t('app.tagline')),
        h('div.card', form),
        demo,
        languageSwitch(render)));
  };
  render();
  return host;
}

export function passwordChangeView({ onDone, onLogout }) {
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true, dataset: { field: 'current' } });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, dataset: { field: 'password' } });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: true, dataset: { field: 'again' } });
  const error = h('p.field-error', { role: 'alert', hidden: true });
  const button = h('button.btn.primary.block', { type: 'submit' }, t('settings.changePassword'));
  const form = h('form.stack', { onSubmit: async (event) => {
    event.preventDefault();
    clearFieldErrors(form);
    error.hidden = true;
    if (next.value !== again.value) {
      showFieldErrors(form, [{ field: 'again', code: 'password_mismatch' }]);
      return;
    }
    button.disabled = true;
    try {
      await api.post('/api/me/password', { current: current.value, next: next.value });
      await onDone();
    } catch (err) {
      if (!showFieldErrors(form, err.details).length && Array.isArray(err.details)) return;
      error.textContent = errorText(err);
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  } },
  h('label.field', h('span.field-label', t('settings.currentPassword')), current),
  h('label.field', h('span.field-label', t('settings.newPassword')), next),
  h('label.field', h('span.field-label', t('settings.newPasswordAgain')), again),
  error, button,
  h('button.btn.ghost.block', { type: 'button', onClick: onLogout }, t('auth.logout')));
  return h('div.login', h('div.login-box',
    h('div.brand.big', h('span.brand-mark', 'MIP'), h('span', t('app.name'))),
    h('div.card', h('h2', t('auth.mustChange')), h('p.muted', t('auth.mustChangeHint')), form)));
}
