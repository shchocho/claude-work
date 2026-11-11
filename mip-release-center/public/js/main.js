// Application shell: session, navigation, routing.
import { h, mount, icon } from './lib/dom.js';
import { api, onApiEvent, qs } from './lib/api.js';
import { t, tl, setLocale, storedLocale, fmtRelative } from './lib/i18n.js';
import { state, can } from './lib/state.js';
import { toast, errorText } from './lib/ui.js';
import { loginView, passwordChangeView } from './views/login.js';
import { dashboardView } from './views/dashboard.js';
import { requestListView } from './views/requests.js';
import { requestFormView } from './views/request-form.js';
import { requestDetailView } from './views/request-detail.js';
import { approvalsView } from './views/approvals.js';
import { executionsView } from './views/executions.js';
import { auditView } from './views/audit.js';
import { reportsView } from './views/reports.js';
import { policyView } from './views/policy.js';
import { adminView } from './views/admin.js';
import { settingsView } from './views/settings.js';

const root = document.getElementById('app');

const ROUTES = [
  ['/', dashboardView],
  ['/requests', requestListView],
  ['/requests/new', requestFormView],
  ['/requests/:id', requestDetailView],
  ['/requests/:id/edit', requestFormView],
  ['/approvals', approvalsView],
  ['/executions', executionsView, 'execution.operate'],
  ['/audit', auditView, 'audit.read'],
  ['/reports', reportsView, 'report.read'],
  ['/policy', policyView, 'policy.write'],
  ['/admin', adminView, 'user.manage'],
  ['/settings', settingsView],
];

const NAV = [
  ['/', 'nav.dashboard'],
  ['/requests', 'nav.requests', () => state.badges?.returned],
  ['/approvals', 'nav.approvals', () => state.badges?.approvals],
  ['/executions', 'nav.executions', () => (state.badges?.executions.queue ?? 0) + (state.badges?.executions.mine ?? 0), 'execution.operate'],
  ['/audit', 'nav.audit', null, 'audit.read'],
  ['/reports', 'nav.reports', null, 'report.read'],
  ['/policy', 'nav.policy', null, 'policy.write'],
  ['/admin', 'nav.admin', null, 'user.manage'],
  ['/settings', 'nav.settings'],
];

// ----- theme ----------------------------------------------------------------

function storedTheme() {
  try {
    return localStorage.getItem('mrc.theme');
  } catch {
    return null;
  }
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem('mrc.theme', next);
  } catch {
    // not remembered when storage is unavailable
  }
}

// ----- routing --------------------------------------------------------------

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, search = ''] = raw.split('?');
  return { path: path.replace(/\/+$/, '') || '/', query: Object.fromEntries(new URLSearchParams(search)) };
}

function matchRoute(path) {
  const parts = path.split('/');
  for (const [pattern, view, permission] of ROUTES) {
    const want = pattern.split('/');
    if (want.length !== parts.length) continue;
    const params = {};
    const ok = want.every((segment, i) => {
      if (segment.startsWith(':')) {
        params[segment.slice(1)] = decodeURIComponent(parts[i]);
        return true;
      }
      return segment === parts[i];
    });
    // A literal segment such as "new" wins over ":id" because it is listed first.
    if (ok) return { view, params, permission, pattern };
  }
  return null;
}

export function navigate(path, query) {
  const target = '#' + path + qs(query);
  if (location.hash === target) renderRoute();
  else location.hash = target;
}

let renderToken = 0;
let viewHost = null;

async function renderRoute() {
  if (!state.user || !viewHost) return;
  const token = (renderToken += 1);
  const { path, query } = parseHash();
  const match = matchRoute(path);
  updateNav(path);
  if (!match || (match.permission && !can(match.permission))) {
    mount(viewHost, h('div.empty', h('p', t(match ? 'error.forbidden' : 'common.notFound')), h('a.btn', { href: '#/' }, t('nav.dashboard'))));
    return;
  }
  viewHost.classList.add('loading');
  try {
    const node = await match.view({
      params: match.params,
      query,
      navigate,
      reload: renderRoute,
      setQuery: (next) => navigate(path, { ...query, ...next }),
      refreshBadges,
    });
    if (token !== renderToken) return;
    mount(viewHost, node);
    if (!query.keepScroll) window.scrollTo(0, 0);
  } catch (err) {
    if (token !== renderToken || err.code === 'unauthenticated' || err.code === 'password_change_required') return;
    mount(viewHost, h('div.empty', h('p', err.status === 404 ? t('common.notFound') : errorText(err)), h('a.btn', { href: '#/' }, t('nav.dashboard'))));
  } finally {
    if (token === renderToken) viewHost.classList.remove('loading');
  }
}

// ----- shell ----------------------------------------------------------------

let navEl = null;

function updateNav(path = parseHash().path) {
  if (!navEl) return;
  mount(navEl, NAV.filter(([, , , permission]) => !permission || can(permission)).map(([href, key, count]) => {
    const active = href === '/' ? path === '/' : path === href || path.startsWith(href + '/');
    const n = count?.() ?? 0;
    return h('a', { href: '#' + href, class: active ? 'active' : '', 'aria-current': active ? 'page' : null }, t(key), n > 0 && h('span.count', n));
  }));
}

let bellCount = null;

export async function refreshBadges() {
  if (!state.user) return;
  try {
    state.badges = await api.get('/api/badges');
    updateNav();
    if (bellCount) {
      bellCount.textContent = state.badges.notifications || '';
      bellCount.hidden = !state.badges.notifications;
    }
  } catch {
    // the next poll will try again
  }
}

function notificationText(n) {
  const p = n.payload ?? {};
  const key = `notif.${n.type}`;
  return t(key, { ...p, stageName: tl(p.stageName), number: p.number ?? '', title: p.title ?? '' });
}

function notificationPanel() {
  const panel = h('div.notif-panel', { hidden: true });
  const load = async () => {
    mount(panel, h('p.muted', t('common.loading')));
    try {
      const { items } = await api.get('/api/notifications', { limit: 20 });
      mount(panel,
        h('div.spread', h('strong', t('notif.title')),
          h('button.btn.small.ghost', { type: 'button', onClick: async () => {
            await api.post('/api/notifications/read', { all: true });
            await refreshBadges();
            load();
          } }, t('notif.markAll'))),
        items.length
          ? h('ul.notif-list', items.map((n) => h('li', { class: n.readAt ? '' : 'unread' },
            h('a', { href: n.requestId ? `#/requests/${n.requestId}` : '#/settings', onClick: () => {
              panel.hidden = true;
              if (!n.readAt) api.post('/api/notifications/read', { ids: [n.id] }).then(refreshBadges).catch(() => {});
            } }, notificationText(n), h('span.muted.small', ` · ${fmtRelative(n.createdAt)}`)))))
          : h('p.muted', t('notif.empty')));
    } catch (err) {
      mount(panel, h('p.muted', errorText(err)));
    }
  };
  return { panel, load };
}

function renderShell() {
  const { panel, load } = notificationPanel();
  bellCount = h('span.count', { hidden: true });
  navEl = h('nav.nav', { 'aria-label': t('nav.label') });
  viewHost = h('main.view', { id: 'view' });
  const sidebar = h('aside.sidebar',
    h('a.brand', { href: '#/' }, h('span.brand-mark', 'MIP'), h('span', t('app.name'))),
    navEl,
    h('div.sidebar-foot', h('span.muted.small', `v${state.app.version}`)));
  const bell = h('button.icon-btn', { type: 'button', 'aria-label': t('notif.title'), onClick: (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    if (!panel.hidden) load();
  } }, icon('bell'), bellCount);
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target)) panel.hidden = true;
  });
  const topbar = h('header.topbar',
    h('button.icon-btn.menu-btn', { type: 'button', 'aria-label': t('nav.label'), onClick: () => sidebar.classList.toggle('open') }, icon('menu')),
    h('div.grow'),
    h('button.icon-btn', { type: 'button', 'aria-label': t('settings.theme'), title: t('settings.theme'), onClick: toggleTheme }, icon('sun')),
    h('div.notif', bell, panel),
    h('a.user', { href: '#/settings' }, h('strong', state.user.name), h('span.muted.small', [state.user.departmentName, state.user.title].filter(Boolean).join(' · '))),
    h('button.icon-btn', { type: 'button', 'aria-label': t('auth.logout'), title: t('auth.logout'), onClick: logout }, icon('logout')));
  sidebar.addEventListener('click', (e) => {
    if (e.target.closest('a')) sidebar.classList.remove('open');
  });
  mount(root,
    state.app.demo && h('div.demo-banner', { role: 'note' }, t('app.demoBanner')),
    h('div.shell', sidebar, h('div.main', topbar, viewHost)));
}

// ----- session --------------------------------------------------------------

async function logout() {
  try {
    await api.post('/api/logout');
  } catch {
    // signed out locally either way
  }
  state.user = null;
  showLogin();
}

function showLogin(message) {
  viewHost = null;
  navEl = null;
  mount(root, loginView({ app: state.app, message, onDone: enter }));
}

function showPasswordChange() {
  viewHost = null;
  navEl = null;
  mount(root, passwordChangeView({ onDone: async () => {
    const session = await api.get('/api/session');
    enter(session);
  }, onLogout: logout }));
}

async function enter(session) {
  state.user = session.user;
  state.app = session.app;
  setLocale(session.user.locale ?? storedLocale() ?? 'ko');
  if (session.user.mustChangePassword) {
    showPasswordChange();
    return;
  }
  try {
    const current = await api.get('/api/policy');
    state.policy = current.policy;
    state.policyVersion = current.version;
  } catch (err) {
    toast(errorText(err), 'error');
    return;
  }
  document.title = t('app.name');
  renderShell();
  await refreshBadges();
  renderRoute();
}

/** Re-read the policy after it was saved, or the session after profile changes. */
export async function reloadSession() {
  const session = await api.get('/api/session');
  await enter(session);
}

async function boot() {
  applyTheme(storedTheme());
  setLocale(storedLocale() ?? 'ko');
  onApiEvent('unauthenticated', () => {
    if (state.user) {
      state.user = null;
      showLogin(t('auth.expired'));
    }
  });
  onApiEvent('password_change_required', () => {
    if (state.user) showPasswordChange();
  });
  window.addEventListener('hashchange', renderRoute);
  setInterval(refreshBadges, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshBadges();
  });
  try {
    const session = await api.get('/api/session');
    state.app = session.app;
    if (session.user) await enter(session);
    else showLogin();
  } catch (err) {
    mount(root, h('div.empty', h('p', errorText(err)), h('button.btn', { type: 'button', onClick: () => location.reload() }, t('common.retry'))));
  }
}

boot();
