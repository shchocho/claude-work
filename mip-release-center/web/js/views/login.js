import { OfflineError, api } from '../lib/api.js';
import { $, $$, html, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast } from '../lib/ui.js';

const STEPS = [
  ['fileLock', '암호화된 파일', 'MIP로 보호된 문서'],
  ['unlock', '자가 승인 후 해제', '해제자 · 해제 일시 · 해제 파일 원본 기록'],
  ['send', '송부 수단', 'G/W · 외부저장매체 · 개인메일계정'],
  ['shield', '시스템 통제 및 감사', '파일 원본 · 파일명 · 송부자 · 송부 일시 기록'],
  ['globe', '사외', 'Customer · 정부 및 공공기관 · Vendor'],
];

export async function loginView({ el, onLogin }) {
  mount(
    el,
    html`<main class="login" id="main" tabindex="-1">
      <section class="login-story" aria-label="문서 해지 센터 소개">
        <a class="brand brand-inverse" href="#/home">
          <img src="/icon.svg" alt="" width="34" height="34">
          <span><strong>문서 해지 센터</strong><small>MIP Release Center</small></span>
        </a>
        <h1>보호 문서의 해제부터<br>사외 송부까지, 기록으로 남깁니다.</h1>
        <ol class="login-steps">
          ${STEPS.map(([name, title, body]) => html`<li><span>${icon(name, 18)}</span><div><strong>${title}</strong><small>${body}</small></div></li>`)}
        </ol>
      </section>
      <section class="login-panel" aria-labelledby="login-title">
        <h2 id="login-title">계정을 선택해 시작하세요</h2>
        <p class="dim">체험용 계정 선택 화면입니다. 운영 환경에서는 회사 계정(SSO)으로 로그인합니다.</p>
        <div class="login-users" data-users><div class="loading" role="status">계정 목록을 불러오는 중입니다…</div></div>
      </section>
    </main>`
  );

  const host = $('[data-users]', el);
  let users;
  try {
    users = (await api.users()).users;
  } catch (error) {
    mount(
      host,
      html`<div class="notice notice-audit">${icon('alert')}<div><strong>계정 목록을 불러오지 못했습니다</strong>
        <p>${error instanceof OfflineError ? '서버에 연결할 수 없습니다. 네트워크 연결을 확인한 뒤 새로 고쳐 주세요.' : error.message}</p></div></div>`
    );
    return;
  }

  mount(
    host,
    html`<ul>${users.map(
      (user) => html`<li><button type="button" class="login-user" data-user="${user.id}">
        <span class="avatar" aria-hidden="true">${user.name.slice(0, 1)}</span>
        <span class="login-user-text"><strong>${user.name}</strong><small>${user.dept} · ${user.title}</small></span>
        <span class="badge ${user.role === 'auditor' ? 'badge-audit' : 'badge-neutral'}">${user.role === 'auditor' ? '감사 담당' : '일반 사용자'}</span>
        ${icon('chevronRight', 16)}
      </button></li>`
    )}</ul>`
  );

  for (const button of $$('[data-user]', host)) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const { user } = await api.login(button.dataset.user);
        if (!location.hash || location.hash === '#/') history.replaceState(null, '', '#/home');
        onLogin(user);
      } catch (error) {
        button.disabled = false;
        toast(error.message, { tone: 'error' });
      }
    });
  }
}
