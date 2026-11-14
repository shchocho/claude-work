import { OfflineError, api, setUnauthenticatedHandler } from './lib/api.js';
import { $, $$, html, mount } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { checkNow, isOnline, isSimulated, onNetChange, setSimulated, startMonitoring } from './lib/net.js';
import { cache, queue } from './lib/store.js';
import { onQueueChange, startAutoSync } from './lib/sync.js';
import { clearToasts, toast } from './lib/ui.js';
import { auditView } from './views/audit.js';
import { docsView } from './views/docs.js';
import { homeView } from './views/home.js';
import { loginView } from './views/login.js';
import { releaseView } from './views/release.js';
import { sendView } from './views/send.js';
import { syncView } from './views/sync.js';

const DEFAULT_META = { maxFileBytes: 50 * 1024 * 1024, releaseTtlDays: 7, corpDomains: [], adapter: 'mock' };

const app = {
  user: null,
  meta: cache.get('meta') ?? DEFAULT_META,
  cleanup: null,
  renderToken: 0,
};

const ROUTES = [
  { pattern: /^home$/, view: homeView, nav: 'home', title: '홈' },
  { pattern: /^release$/, view: releaseView, nav: 'release', title: '문서 해제' },
  { pattern: /^docs$/, view: docsView, nav: 'docs', title: '내 문서함' },
  { pattern: /^docs\/([^/]+)\/send$/, view: sendView, nav: 'docs', title: '송부' },
  { pattern: /^sync$/, view: syncView, nav: 'sync', title: '동기화 대기함' },
  { pattern: /^audit$/, view: auditView, nav: 'audit', title: '감사 로그', role: 'auditor' },
];

const NAV = [
  { id: 'home', href: '#/home', label: '홈', icon: 'home' },
  { id: 'release', href: '#/release', label: '문서 해제', icon: 'unlock' },
  { id: 'docs', href: '#/docs', label: '내 문서함', icon: 'folder' },
  { id: 'sync', href: '#/sync', label: '동기화 대기함', icon: 'sync' },
  { id: 'audit', href: '#/audit', label: '감사 로그', icon: 'shield', role: 'auditor', group: '감사' },
];

export const navigate = (path) => {
  if (location.hash === `#/${path}`) route();
  else location.hash = `#/${path}`;
};

// ── 셸 ─────────────────────────────────────────────────

function renderShell() {
  const { user } = app;
  const items = NAV.filter((item) => !item.role || item.role === user.role);
  mount(
    $('#app'),
    html`<div class="shell">
      <aside class="side">
        <a class="brand" href="#/home">
          <img src="/icon.svg" alt="" width="34" height="34">
          <span><strong>문서 해지 센터</strong><small>MIP Release Center</small></span>
        </a>
        <nav class="nav" aria-label="주 메뉴">
          <ul>
            ${items.map(
              (item) => html`${item.group ? html`<li class="nav-group" aria-hidden="true">${item.group}</li>` : ''}
                <li>
                  <a href="${item.href}" data-nav="${item.id}">
                    ${icon(item.icon)}<span>${item.label}</span>
                    ${item.id === 'sync' ? html`<span class="count" data-queue-count hidden></span>` : ''}
                  </a>
                </li>`
            )}
          </ul>
        </nav>
        <div class="side-foot">
          <section class="net" aria-label="서버 연결 상태" data-net></section>
          <div class="me">
            <span class="avatar" aria-hidden="true">${user.name.slice(0, 1)}</span>
            <span class="me-text"><strong>${user.name}</strong><small>${user.role === 'auditor' ? `${user.dept} · 감사` : `${user.dept} · ${user.title}`}</small></span>
            <button type="button" class="icon-btn" data-theme-toggle></button>
            <button type="button" class="icon-btn" data-logout aria-label="로그아웃" title="로그아웃">${icon('logout')}</button>
          </div>
        </div>
      </aside>
      <main id="main" class="main" tabindex="-1"></main>
    </div>`
  );
  $('[data-logout]').addEventListener('click', logout);
  $('[data-theme-toggle]').addEventListener('click', toggleTheme);
  renderThemeToggle();
  renderNet();
  renderQueueCount();
}

function renderThemeToggle() {
  const button = $('[data-theme-toggle]');
  if (!button) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  const label = dark ? '밝은 화면으로 전환' : '어두운 화면으로 전환';
  button.setAttribute('aria-label', label);
  button.title = label;
  mount(button, icon(dark ? 'sun' : 'moon'));
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('mrc.theme', next);
  } catch {
    /* 저장하지 못해도 이번 세션에는 적용된다 */
  }
  renderThemeToggle();
}

function renderNet() {
  const host = $('[data-net]');
  if (!host) return;
  const online = isOnline();
  host.dataset.state = online ? 'online' : 'offline';
  mount(
    host,
    html`<div class="net-status">
        <span class="net-icon">${icon(online ? 'wifi' : 'wifiOff')}</span>
        <div>
          <strong>${online ? '서버 연결됨' : '네트워크 미연결'}</strong>
          <small>${online ? '기록을 서버에 바로 저장합니다.' : '기록을 이 PC에 저장하고, 연결되면 서버로 보냅니다.'}</small>
        </div>
      </div>
      <label class="switch">
        <input type="checkbox" role="switch" data-simulate ${isSimulated() ? 'checked' : ''}>
        <span class="switch-track" aria-hidden="true"></span>
        <span>미연결 상황 체험</span>
      </label>`
  );
  $('[data-simulate]', host).addEventListener('change', (event) => {
    setSimulated(event.target.checked);
    renderNet();
  });
}

async function renderQueueCount() {
  const el = $('[data-queue-count]');
  if (!el || !app.user) return;
  const count = (await queue.list(app.user.id)).length;
  el.hidden = count === 0;
  el.textContent = count;
  el.setAttribute('aria-label', `대기 ${count}건`);
}

// ── 라우팅 ─────────────────────────────────────────────

async function route({ moveFocus = false } = {}) {
  if (!app.user) return;
  const path = location.hash.replace(/^#\/?/, '') || 'home';
  let match = null;
  let found = null;
  for (const candidate of ROUTES) {
    match = candidate.pattern.exec(path);
    if (match) {
      found = candidate;
      break;
    }
  }
  if (!found || (found.role && found.role !== app.user.role)) {
    navigate('home');
    return;
  }

  app.cleanup?.();
  app.cleanup = null;
  const token = ++app.renderToken;
  const main = $('#main');
  for (const link of $$('[data-nav]')) {
    if (link.dataset.nav === found.nav) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${found.title} · 문서 해지 센터`;
  mount(main, html`<div class="loading" role="status">화면을 불러오는 중입니다…</div>`);

  const ctx = {
    el: main,
    user: app.user,
    meta: app.meta,
    params: match.slice(1).map(decodeURIComponent),
    navigate,
    isCurrent: () => token === app.renderToken,
  };
  try {
    const cleanup = await found.view(ctx);
    if (token !== app.renderToken) {
      cleanup?.();
      return;
    }
    app.cleanup = cleanup ?? null;
    window.scrollTo(0, 0);
    // 화면이 바뀐 것을 화면 낭독기와 키보드 사용자가 알 수 있도록 새 화면의 제목으로 포커스를 옮긴다.
    // (화면이 스스로 포커스를 잡았으면 그대로 둔다.)
    if (moveFocus && !main.contains(document.activeElement)) {
      const heading = $('h1', main);
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    }
  } catch (error) {
    if (token !== app.renderToken) return;
    console.error(error);
    mount(
      main,
      html`<div class="page"><div class="empty">
        <span class="empty-icon">${icon('alert', 22)}</span>
        <h3>화면을 불러오지 못했습니다</h3>
        <p>${error instanceof OfflineError ? '서버에 연결할 수 없습니다. 연결을 확인한 뒤 다시 시도해 주세요.' : error.message}</p>
        <button type="button" class="btn" data-retry>다시 시도</button>
      </div></div>`
    );
    $('[data-retry]', main)?.addEventListener('click', () => route());
  }
}

// ── 세션 ───────────────────────────────────────────────

function enter(user) {
  app.user = user;
  cache.set('user', user);
  renderShell();
  route();
}

async function logout() {
  try {
    await api.logout();
  } catch {
    /* 서버에 닿지 않아도 이 PC에서는 로그아웃한다 */
  }
  // 다음에 로그인하는 사람이 앞사람이 보던 화면에서 시작하지 않도록 홈으로 돌려 둔다.
  history.replaceState(null, '', '#/home');
  clearToasts();
  showLogin();
}

function showLogin() {
  app.cleanup?.();
  app.cleanup = null;
  app.renderToken += 1;
  app.user = null;
  cache.remove('user');
  document.title = '문서 해지 센터';
  loginView({ el: $('#app'), onLogin: enter });
}

async function boot() {
  startMonitoring();
  setUnauthenticatedHandler(() => {
    if (app.user) {
      toast('로그인 시간이 지났습니다. 다시 로그인해 주세요.', { tone: 'warn' });
      showLogin();
    }
  });
  onNetChange((online) => {
    renderNet();
    if (!app.user) return;
    toast(
      online ? '서버에 다시 연결되었습니다.' : '서버에 연결할 수 없습니다. 외부저장매체 송부 기록은 이 PC에 저장됩니다.',
      { tone: online ? 'ok' : 'warn' }
    );
    // 연결 상태에 따라 안내와 버튼이 달라지는 화면은 다시 그린다.
    if (/^#\/(home|docs|sync|audit)?$/.test(location.hash || '#/')) route();
  });
  onQueueChange(renderQueueCount);
  window.addEventListener('hashchange', () => route({ moveFocus: true }));

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  await checkNow();
  try {
    api.meta().then((meta) => {
      app.meta = meta;
      cache.set('meta', meta);
    }).catch(() => {});
    const { user } = await api.session();
    if (user) enter(user);
    else showLogin();
  } catch (error) {
    // 서버에 닿지 않을 때는 마지막으로 로그인한 계정으로 이 PC의 기록을 계속 쓸 수 있게 한다.
    const remembered = cache.get('user');
    if (error instanceof OfflineError && remembered) enter(remembered);
    else showLogin();
  }

  startAutoSync(
    () => app.user,
    (result) => {
      if (result.synced) toast(`이 PC에 저장해 둔 송부 기록 ${result.synced}건을 서버에 저장했습니다.`);
      if (result.rejected) toast(`송부 기록 ${result.rejected}건을 서버가 받지 않았습니다. 동기화 대기함에서 사유를 확인해 주세요.`, { tone: 'error' });
      if ((result.synced || result.rejected) && /^#\/(home|docs|sync)/.test(location.hash)) route();
    }
  );
}

boot();
