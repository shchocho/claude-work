// 템플릿 · DOM · 표시 형식 도우미.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

class Raw {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

/** 이미 안전한 HTML 조각임을 표시한다. */
export const raw = (value) => new Raw(String(value));

function render(value) {
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false || value === true) return '';
  return esc(value);
}

/** 끼워 넣는 값을 기본으로 이스케이프하는 템플릿 태그. */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((chunk, i) => {
    out += chunk;
    if (i < values.length) out += render(values[i]);
  });
  return new Raw(out);
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * 템플릿을 요소에 그린다.
 * CSP가 인라인 style 속성을 막으므로, 데이터에 따라 달라지는 크기는 data-w / data-h 로 적고 여기서 반영한다.
 */
export function mount(element, template) {
  element.innerHTML = String(template);
  for (const el of $$('[data-w]', element)) el.style.width = `${el.dataset.w}%`;
  for (const el of $$('[data-h]', element)) el.style.height = `${el.dataset.h}%`;
}

const pad = (n) => String(n).padStart(2, '0');

export function fmtDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

export function fmtRelative(iso, now = new Date()) {
  const diff = now - new Date(iso);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return '방금 전';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}일 전`;
  return fmtDate(iso);
}

/** 남은 송부 가능 기간을 사람이 읽는 말로. */
export function fmtRemaining(iso, now = new Date()) {
  const diff = new Date(iso) - now;
  if (diff <= 0) return '기간 만료';
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return '1시간 이내 만료';
  if (hours < 24) return `${hours}시간 남음`;
  return `${Math.floor(hours / 24)}일 남음`;
}

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const shortHash = (hash) => (hash ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : '-');

export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '기타 OS';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Whale\//.test(ua) ? 'Whale' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '브라우저';
  return `${os} · ${browser}`;
}
