import { $, html, mount } from './dom.js';
import { icon } from './icons.js';

// ── 토스트 ─────────────────────────────────────────────
const TOAST_ICONS = { ok: 'check', warn: 'alert', error: 'alert', info: 'info' };

/** 모달 대화상자는 바깥을 가리고 비활성화하므로, 열려 있으면 그 안에 알림 자리를 만든다. */
function toastHost() {
  const dialog = document.querySelector('dialog[open]');
  if (!dialog) return $('#toasts');
  let host = $('.toasts', dialog);
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    dialog.append(host);
  }
  return host;
}

export function clearToasts() {
  $('#toasts').replaceChildren();
}

export function toast(message, { tone = 'ok', timeout = 5000 } = {}) {
  const host = toastHost();
  const el = document.createElement('div');
  el.className = `toast toast-${tone}`;
  // 오류는 바로 읽어 주어야 하므로 alert 로 올린다. 나머지는 host 의 polite 영역에 맡긴다.
  if (tone === 'error') el.setAttribute('role', 'alert');
  mount(el, html`${icon(TOAST_ICONS[tone])}<p>${message}</p><button type="button" class="icon-btn" aria-label="알림 닫기">${icon('x', 16)}</button>`);
  const close = () => el.remove();
  $('button', el).addEventListener('click', close);
  host.append(el);
  if (timeout) setTimeout(close, tone === 'error' ? timeout * 2 : timeout);
}

// ── 대화상자 · 서랍 ────────────────────────────────────
// <dialog> 의 showModal 이 포커스 가두기, Esc 닫기, 배경 비활성화를 맡는다.

function openDialog(className, labelledBy) {
  const dialog = document.createElement('dialog');
  dialog.className = className;
  if (labelledBy) dialog.setAttribute('aria-labelledby', labelledBy);
  $('#overlay-root').append(dialog);
  const opener = document.activeElement;
  dialog.addEventListener('close', () => {
    dialog.remove();
    opener?.focus?.();
  });
  // 배경(대화상자 바깥)을 누르면 닫는다.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  return dialog;
}

/** 오른쪽에서 열리는 상세 패널. render(body, close) 로 내용을 그린다. */
export function openDrawer({ title, subtitle, render }) {
  const dialog = openDialog('drawer', 'drawer-title');
  mount(
    dialog,
    html`<div class="drawer-inner">
      <header class="drawer-head">
        <div>
          <h2 id="drawer-title">${title}</h2>
          ${subtitle ? html`<p class="mono dim">${subtitle}</p>` : ''}
        </div>
        <button type="button" class="icon-btn" data-close aria-label="상세 닫기">${icon('x')}</button>
      </header>
      <div class="drawer-body"></div>
    </div>`
  );
  const close = () => dialog.close();
  $('[data-close]', dialog).addEventListener('click', close);
  render($('.drawer-body', dialog), close);
  dialog.showModal();
  return { close, body: $('.drawer-body', dialog) };
}

/** 되돌리기 어려운 동작 앞에서 한 번 더 묻는다. 버튼 문구는 동작 그 자체로 적는다. */
export function confirmDialog({ title, body, confirmLabel, cancelLabel = '취소', danger = false }) {
  return new Promise((resolve) => {
    const dialog = openDialog('modal', 'modal-title');
    mount(
      dialog,
      html`<form method="dialog" class="modal-inner">
        <h2 id="modal-title">${title}</h2>
        <p>${body}</p>
        <div class="modal-actions">
          <button class="btn" value="cancel">${cancelLabel}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="confirm">${confirmLabel}</button>
        </div>
      </form>`
    );
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'));
    dialog.showModal();
  });
}

// ── 파일 저장 ──────────────────────────────────────────

/**
 * 파일을 사용자가 고른 위치(외부저장매체 등)에 저장한다.
 * 저장 위치 선택 창을 지원하는 브라우저에서는 실제로 쓰기가 끝난 뒤에 돌아온다.
 * 반환: 'saved' | 'downloaded' | 'cancelled'
 */
export async function saveBlob(blob, fileName, { pick = false } = {}) {
  if (pick && typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: fileName });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return 'saved';
    } catch (error) {
      if (error?.name === 'AbortError') return 'cancelled';
      // 권한 거부 등으로 선택 창을 못 쓰면 일반 내려받기로 넘어간다.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return 'downloaded';
}

// ── 공용 조각 ──────────────────────────────────────────

export const spinner = (label) => html`<span class="spinner" role="status"><span class="sr-only">${label}</span></span>`;

export function fieldError(form, name, message) {
  const field = form.querySelector(`[data-field="${name}"]`);
  if (!field) return;
  const control = field.querySelector('input, textarea, select');
  const slot = field.querySelector('.field-error');
  field.classList.toggle('has-error', Boolean(message));
  if (slot) slot.textContent = message ?? '';
  if (control) {
    if (message) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
  }
}

export function focusFirstError(form) {
  form.querySelector('[aria-invalid="true"], .has-error input, .has-error textarea')?.focus();
}
