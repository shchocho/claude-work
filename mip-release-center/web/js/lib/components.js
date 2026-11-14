import { CHANNELS, LABELS, MEDIA_TYPES, RECIPIENT_TYPES, RELEASE_STATUS, REVIEW } from './consts.js';
import { fmtDateTime, html } from './dom.js';
import { icon } from './icons.js';

export function labelChip(labelId) {
  const label = LABELS[labelId] ?? LABELS.confidential;
  return html`<span class="label label-${labelId}" title="민감도 등급: ${label.en}"><i></i>${label.name}</span>`;
}

export const badge = (text, tone = 'neutral', iconName = null) =>
  html`<span class="badge badge-${tone}">${iconName ? icon(iconName, 14) : ''}${text}</span>`;

export const statusBadge = (status) => badge(RELEASE_STATUS[status].name, RELEASE_STATUS[status].tone);
export const reviewBadge = (status) => badge(REVIEW[status].name, REVIEW[status].tone, status === 'flagged' ? 'flag' : status === 'ok' ? 'check' : null);

/** 파일 종류를 확장자 글자로 보여 주는 작은 문서 그림. */
export function fileGlyph(fileName, { locked = false } = {}) {
  const ext = (fileName.replace(/\.pfile$/i, '').split('.').pop() ?? '').slice(0, 4).toUpperCase();
  return html`<span class="fileglyph ${locked ? 'is-locked' : ''}" aria-hidden="true">${locked ? icon('lock', 14) : ''}<b>${ext || 'FILE'}</b></span>`;
}

export function channelDetailText(transfer) {
  const d = transfer.detail ?? {};
  if (transfer.channel === 'media') return [MEDIA_TYPES[d.mediaType], d.mediaTag].filter(Boolean).join(' · ');
  if (transfer.channel === 'gw') return (d.to ?? []).join(', ');
  return d.address ?? '';
}

export const channelTag = (channelId) =>
  html`<span class="channel-tag">${icon(CHANNELS[channelId].icon, 14)}${CHANNELS[channelId].name}</span>`;

export const recipientText = (item) => `${RECIPIENT_TYPES[item.recipientType]} · ${item.recipientName}`;

/** 송부 기록 한 줄 (문서함, 홈). */
export function transferLine(transfer) {
  return html`<li class="tline">
    ${channelTag(transfer.channel)}
    <span class="tline-detail">${channelDetailText(transfer) || '-'}</span>
    <span class="tline-meta">
      ${transfer.capturedOffline ? badge('PC 저장 후 서버 저장', 'neutral', 'monitor') : ''}
      ${transfer.review?.status === 'flagged' ? reviewBadge('flagged') : ''}
      <time class="num" datetime="${transfer.sentAt}">${fmtDateTime(transfer.sentAt)}</time>
    </span>
    ${transfer.review?.status === 'flagged' && transfer.review.note
      ? html`<p class="tline-note">${icon('flag', 14)}<span><strong>감사 담당자 의견</strong> ${transfer.review.note}</span></p>`
      : ''}
  </li>`;
}

/** 아직 서버에 올라가지 않은 송부 기록 한 줄. */
export function pendingLine(entry) {
  return html`<li class="tline is-pending">
    ${channelTag(entry.meta.channel)}
    <span class="tline-detail">${channelDetailText({ channel: entry.meta.channel, detail: entry.meta.detail }) || '-'}</span>
    <span class="tline-meta">
      ${badge('동기화 대기', 'channel', 'monitor')}
      <time class="num" datetime="${entry.sentAt}">${fmtDateTime(entry.sentAt)}</time>
    </span>
  </li>`;
}

export function emptyState({ iconName, title, body, action = '' }) {
  return html`<div class="empty">
    <span class="empty-icon">${icon(iconName, 22)}</span>
    <h3>${title}</h3>
    <p>${body}</p>
    ${action}
  </div>`;
}

export function notice(tone, title, body = '', iconName = null) {
  const icons = { control: 'check', channel: 'info', audit: 'alert', neutral: 'info' };
  return html`<div class="notice notice-${tone}">
    ${icon(iconName ?? icons[tone], 18)}
    <div><strong>${title}</strong>${body ? html`<p>${body}</p>` : ''}</div>
  </div>`;
}

/** 저장 정보처럼 "항목 — 값"으로 읽는 목록. rows: [항목, 값][] */
export const defList = (rows, className = '') =>
  html`<dl class="deflist ${className}">${rows.filter(Boolean).map(([term, value]) => html`<div><dt>${term}</dt><dd>${value}</dd></div>`)}</dl>`;
