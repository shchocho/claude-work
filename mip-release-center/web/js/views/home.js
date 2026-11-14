import { api } from '../lib/api.js';
import { emptyState, fileGlyph, labelChip, notice, pendingLine, recipientText, transferLine } from '../lib/components.js';
import { fmtDateTime, fmtRemaining, html, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { isOnline } from '../lib/net.js';
import { loadReleases } from '../lib/sync.js';

/** To-Be 프로세스 그림을 그대로 옮긴 흐름 띠. 각 구간에 내 현황 숫자를 얹는다. */
function flow(stats) {
  const figure = (value, unit) => html`<p class="flow-figure"><b>${value}</b>${unit}</p>`;
  return html`<section class="flow" aria-labelledby="flow-title">
    <h2 id="flow-title" class="sr-only">해제부터 사외 송부까지의 흐름</h2>
    <ol>
      <li class="flow-stage">
        <span class="flow-icon">${icon('fileLock', 20)}</span>
        <h3>암호화된 파일</h3>
        <p>MIP로 보호된 문서를 올립니다.</p>
        <a class="flow-link" href="#/release">문서 해제 시작 ${icon('arrowRight', 14)}</a>
      </li>
      <li class="flow-stage zone-control">
        <span class="zone-tag">시스템 통제</span>
        <h3>자가 승인 후 해제</h3>
        <ul class="flow-list"><li>해제자</li><li>해제 일시</li><li>해제 파일 원본</li></ul>
        ${figure(stats.releasesThisMonth, '건 · 이번 달 해제')}
      </li>
      <li class="flow-stage zone-channel">
        <span class="zone-tag">송부 수단</span>
        <h3>암호화 해제 파일 송부</h3>
        <ul class="flow-list"><li>G/W</li><li>외부저장매체</li><li>개인메일계정</li></ul>
        ${figure(stats.awaiting, '건 · 송부 대기')}
      </li>
      <li class="flow-stage zone-control zone-audit">
        <span class="zone-tag">시스템 통제 및 감사</span>
        <h3>송부 기록 저장</h3>
        <ul class="flow-list"><li>파일 원본</li><li>파일명</li><li>송부자</li><li>송부 일시</li></ul>
        ${figure(stats.transfersThisMonth, '건 · 이번 달 송부')}
      </li>
      <li class="flow-stage">
        <span class="flow-icon">${icon('globe', 20)}</span>
        <h3>사외</h3>
        <ul class="flow-list"><li>Customer</li><li>정부 및 공공기관</li><li>Vendor 등</li></ul>
      </li>
    </ol>
  </section>`;
}

function waitingRow(release) {
  return html`<li class="doc-row">
    ${fileGlyph(release.fileName)}
    <div class="doc-main">
      <p class="doc-name">${release.fileName} ${labelChip(release.labelId)}</p>
      <p class="doc-sub">${recipientText(release)} <span class="sep">·</span> ${fmtRemaining(release.expiresAt)}</p>
    </div>
    <a class="btn btn-sm btn-primary" href="#/docs/${release.id}/send">송부</a>
  </li>`;
}

function auditPanel(stats) {
  const tile = (label, value, tone = '') => html`<div class="stat ${tone}"><dt>${label}</dt><dd>${value}</dd></div>`;
  return html`<section class="card" aria-labelledby="audit-summary-title">
    <header class="card-head">
      <h2 id="audit-summary-title">감사 현황</h2>
      <a class="link" href="#/audit">감사 로그 열기 ${icon('arrowRight', 14)}</a>
    </header>
    <dl class="stats">
      ${tile('검토를 기다리는 송부', stats.pendingReview, stats.pendingReview ? 'is-attention' : '')}
      ${tile('해제 원본과 다른 파일', stats.hashMismatch, stats.hashMismatch ? 'is-alert' : '')}
      ${tile('PC에 먼저 저장된 기록', stats.capturedOffline)}
      ${tile('전체 송부', stats.transfers)}
    </dl>
  </section>`;
}

export async function homeView({ el, user }) {
  const data = await loadReleases(user);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const transfers = data.releases.flatMap((r) => r.transfers.map((t) => ({ ...t, release: r })));
  const stats = {
    releasesThisMonth: data.releases.filter((r) => r.releasedAt >= monthStart).length,
    transfersThisMonth: transfers.filter((t) => t.sentAt >= monthStart).length + data.pending.length,
    awaiting: data.releases.filter((r) => r.status === 'ready').length,
  };
  const waiting = data.releases.filter((r) => r.status === 'ready');
  const recent = transfers.sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(0, 5);

  let auditStats = null;
  if (user.role === 'auditor' && isOnline()) {
    try {
      auditStats = await api.audit.stats();
    } catch {
      /* 홈에서는 감사 현황을 못 받아도 나머지를 보여 준다 */
    }
  }

  mount(
    el,
    html`<div class="page">
      <header class="page-head">
        <div>
          <p class="eyebrow">To-Be 프로세스</p>
          <h1>문서 해지 센터</h1>
          <p class="lede">MIP로 보호된 문서를 자가 승인으로 해제하고, 사외로 보낸 기록까지 한곳에 남깁니다.</p>
        </div>
        <a class="btn btn-primary btn-lg" href="#/release">${icon('unlock')}문서 해제 시작</a>
      </header>

      ${data.stale
        ? notice('channel', '네트워크 미연결 상태입니다', data.cachedAt
            ? `${fmtDateTime(data.cachedAt)}에 마지막으로 받은 목록을 보여 드립니다. 이 PC에 보관된 해제 파일은 외부저장매체로 송부할 수 있습니다.`
            : '서버에 연결되면 내 문서 목록을 불러옵니다.', 'wifiOff')
        : ''}

      ${flow(stats)}

      <div class="grid-2">
        <section class="card" aria-labelledby="waiting-title">
          <header class="card-head">
            <h2 id="waiting-title">송부를 기다리는 문서</h2>
            <a class="link" href="#/docs">내 문서함 ${icon('arrowRight', 14)}</a>
          </header>
          ${waiting.length
            ? html`<ul class="doc-list">${waiting.slice(0, 4).map(waitingRow)}</ul>`
            : emptyState({
                iconName: 'folder',
                title: '송부를 기다리는 문서가 없습니다',
                body: '암호화를 해제한 문서가 여기에 모입니다. 해제 후 7일 안에 송부할 수 있습니다.',
              })}
        </section>

        <section class="card" aria-labelledby="recent-title">
          <header class="card-head"><h2 id="recent-title">최근 송부 기록</h2></header>
          ${recent.length || data.pending.length
            ? html`<ul class="tlines">
                ${data.pending.map(pendingLine)}
                ${recent.map(transferLine)}
              </ul>`
            : emptyState({
                iconName: 'send',
                title: '아직 송부한 기록이 없습니다',
                body: '해제한 문서를 G/W, 외부저장매체, 개인메일계정으로 보내면 파일 원본과 함께 기록됩니다.',
              })}
        </section>
      </div>

      ${auditStats ? auditPanel(auditStats) : ''}
    </div>`
  );
}
