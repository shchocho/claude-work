import { defList, emptyState, fileGlyph, labelChip, notice, pendingLine, recipientText, statusBadge, transferLine } from '../lib/components.js';
import { $, $$, fmtDateTime, fmtRemaining, fmtSize, html, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { isOnline } from '../lib/net.js';
import { loadReleases } from '../lib/sync.js';

const FILTERS = [
  ['all', '전체'],
  ['ready', '송부 대기'],
  ['sent', '송부 완료'],
  ['expired', '기간 만료'],
];

let filter = 'all';

function sendAction(release) {
  if (!release.canSend) {
    return html`<span class="dim action-note">송부 가능 기간이 지났습니다. 다시 해제해 주세요.</span>`;
  }
  // 미연결 상태에서는 이 PC에 해제 파일이 있어야 외부저장매체로 보낼 수 있다.
  if (!isOnline() && !release.hasLocalCopy) {
    return html`<span class="dim action-note">이 PC에 해제 파일이 없어 연결 후 송부할 수 있습니다.</span>`;
  }
  return html`<a class="btn btn-sm ${release.status === 'ready' ? 'btn-primary' : ''}" href="#/docs/${release.id}/send">
    ${icon('send', 14)}${release.status === 'ready' ? '송부' : '추가 송부'}
  </a>`;
}

function releaseItem(release) {
  const count = release.transfers.length + release.pending.length;
  return html`<li class="doc-card">
    <div class="doc-row">
      ${fileGlyph(release.fileName)}
      <div class="doc-main">
        <p class="doc-name">${release.fileName} ${labelChip(release.labelId)}</p>
        <p class="doc-sub">
          <span class="mono">${release.code}</span><span class="sep">·</span>
          해제 ${fmtDateTime(release.releasedAt)}<span class="sep">·</span>${recipientText(release)}
        </p>
      </div>
      <div class="doc-side">
        ${statusBadge(release.status)}
        ${release.canSend ? html`<span class="dim doc-remaining">${icon('clock', 14)}${fmtRemaining(release.expiresAt)}</span>` : ''}
      </div>
      <div class="doc-action">${sendAction(release)}</div>
    </div>
    <details class="doc-details">
      <summary>해제 사유와 송부 이력 <span class="dim">· 송부 ${count}건</span></summary>
      <div class="doc-details-body">
        ${defList([
          ['해제 사유', release.reason],
          ['파일 크기', fmtSize(release.size)],
          ['송부 가능 기한', fmtDateTime(release.expiresAt)],
          ['이 PC 보관', release.hasLocalCopy ? '보관 중 (미연결 시 외부저장매체 송부 가능)' : '없음'],
        ])}
        ${count
          ? html`<ul class="tlines">${release.pending.map(pendingLine)}${release.transfers.map(transferLine)}</ul>`
          : html`<p class="dim">아직 송부한 기록이 없습니다.</p>`}
      </div>
    </details>
  </li>`;
}

export async function docsView({ el, user }) {
  const data = await loadReleases(user);
  const counts = Object.fromEntries(FILTERS.map(([id]) => [id, id === 'all' ? data.releases.length : data.releases.filter((r) => r.status === id).length]));

  function render() {
    const shown = filter === 'all' ? data.releases : data.releases.filter((r) => r.status === filter);
    mount(
      el,
      html`<div class="page">
        <header class="page-head">
          <div>
            <p class="eyebrow">암호화 해제 파일</p>
            <h1>내 문서함</h1>
            <p class="lede">해제한 문서를 송부 수단을 골라 사외로 보냅니다. 해제 후 7일 동안 송부할 수 있습니다.</p>
          </div>
          <a class="btn btn-primary" href="#/release">${icon('unlock')}문서 해제</a>
        </header>

        ${data.stale
          ? notice('channel', '네트워크 미연결 상태입니다', data.cachedAt
              ? `${fmtDateTime(data.cachedAt)}에 마지막으로 받은 목록입니다. 이 PC에 보관된 해제 파일만 외부저장매체로 송부할 수 있습니다.`
              : '서버에 연결되면 목록을 불러옵니다.', 'wifiOff')
          : ''}

        <div class="tabs" role="group" aria-label="문서 상태로 걸러 보기">
          ${FILTERS.map(
            ([id, name]) => html`<button type="button" class="tab" data-filter="${id}" aria-pressed="${String(filter === id)}">${name}<span class="count">${counts[id]}</span></button>`
          )}
        </div>

        ${shown.length
          ? html`<ul class="doc-cards">${shown.map(releaseItem)}</ul>`
          : data.releases.length
            ? emptyState({ iconName: 'folder', title: '이 상태의 문서가 없습니다', body: '다른 상태를 선택해 보세요.' })
            : emptyState({
                iconName: 'folder',
                title: '해제한 문서가 없습니다',
                body: 'MIP로 보호된 문서를 해제하면 여기에 모이고, 여기서 사외로 송부할 수 있습니다.',
                action: html`<a class="btn btn-primary" href="#/release">${icon('unlock')}문서 해제 시작</a>`,
              })}
      </div>`
    );
    for (const button of $$('[data-filter]', el)) {
      button.addEventListener('click', () => {
        filter = button.dataset.filter;
        render();
        $(`[data-filter="${filter}"]`, el)?.focus();
      });
    }
  }

  render();
}
