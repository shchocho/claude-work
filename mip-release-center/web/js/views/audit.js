import { api } from '../lib/api.js';
import {
  badge, channelDetailText, channelTag, defList, emptyState, fileGlyph, labelChip, notice, recipientText, reviewBadge, statusBadge,
} from '../lib/components.js';
import { AUDIT_ACTIONS, CHANNELS, LABELS, RECIPIENT_TYPES, REVIEW } from '../lib/consts.js';
import { $, $$, debounce, fmtDateTime, fmtSize, html, mount, shortHash } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { isOnline } from '../lib/net.js';
import { fieldError, openDrawer, saveBlob, spinner, toast } from '../lib/ui.js';

const TABS = [
  ['transfers', '송부 이력'],
  ['releases', '해제 이력'],
  ['events', '감사 이벤트'],
];

const emptyFilters = () => ({ q: '', channel: '', recipientType: '', label: '', review: '', from: '', to: '', offline: '', mismatch: '' });

const view = { tab: 'transfers', filters: emptyFilters(), verify: null };

// ── 현황 ───────────────────────────────────────────────

function statTiles(stats) {
  const tile = (label, value, { tone = '', filter = null, hint = '', note = '' } = {}) =>
    html`<div class="stat ${tone}">
      <dt>${label}</dt>
      <dd>${value}</dd>
      ${filter && value ? html`<button type="button" class="link" data-quick="${filter}">${hint} ${icon('arrowRight', 14)}</button>` : ''}
      ${note ? html`<span class="stat-note">${note}</span>` : ''}
    </div>`;
  return html`<dl class="stats">
    ${tile('검토를 기다리는 송부', stats.pendingReview, { tone: stats.pendingReview ? 'is-attention' : '', filter: 'review=pending', hint: '미검토만 보기' })}
    ${tile('해제 원본과 다른 파일', stats.hashMismatch, { tone: stats.hashMismatch ? 'is-alert' : '', filter: 'mismatch=1', hint: '불일치만 보기' })}
    ${tile('PC에 먼저 저장된 기록', stats.capturedOffline, { filter: 'offline=1', hint: '해당 건만 보기' })}
    ${tile('전체 송부', stats.transfers, { note: `해제 ${stats.releases}건` })}
  </dl>`;
}

/** 값이 하나뿐인 가로 막대 목록. 이름은 왼쪽, 값은 막대 끝에 둔다. */
function barList(title, rows, names) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return html`<figure class="chart">
    <figcaption>${title}</figcaption>
    <ul class="bars">
      ${rows.map(
        (row) => html`<li>
          <span class="bar-name">${names[row.id]}</span>
          <span class="bar-track">
            ${row.count ? html`<span class="bar-fill" data-w="${(row.count / max) * 86}"></span>` : ''}
            <span class="bar-value mono">${row.count}<span class="sr-only">건</span></span>
          </span>
        </li>`
      )}
    </ul>
  </figure>`;
}

/** 최근 14일 일별 송부 건수. 값은 가장 많은 날과 오늘에만 적고, 나머지는 가리키면 보인다. */
function dailyChart(days) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const peak = days.reduce((best, d, i) => (d.count > days[best].count ? i : best), 0);
  return html`<figure class="chart chart-daily">
    <figcaption>최근 14일 송부 건수</figcaption>
    <ol class="columns" aria-hidden="true">
      ${days.map((day, i) => {
        const [, month, date] = day.date.split('-').map(Number);
        const labelled = day.count > 0 && (i === peak || i === days.length - 1);
        return html`<li data-tip="${month}월 ${date}일 · ${day.count}건">
          <span class="column-plot">
            ${labelled ? html`<span class="column-value mono">${day.count}</span>` : ''}
            <span class="column-bar ${day.count ? '' : 'is-zero'}" data-h="${(day.count / max) * 82}"></span>
          </span>
          <span class="column-label">${i === 0 || date === 1 ? `${month}/${date}` : i === days.length - 1 ? '오늘' : i % 2 ? '' : date}</span>
        </li>`;
      })}
    </ol>
    <table class="sr-only">
      <caption>최근 14일 일별 송부 건수</caption>
      <thead><tr><th scope="col">날짜</th><th scope="col">송부 건수</th></tr></thead>
      <tbody>${days.map((day) => html`<tr><th scope="row">${day.date}</th><td>${day.count}</td></tr>`)}</tbody>
    </table>
  </figure>`;
}

// ── 표 ─────────────────────────────────────────────────

function storageBadge(transfer) {
  return transfer.capturedOffline ? badge('PC → 서버', 'neutral', 'monitor') : badge('서버', 'neutral', 'server');
}

function transfersTable(rows) {
  if (!rows.length) {
    return emptyState({ iconName: 'search', title: '조건에 맞는 송부 기록이 없습니다', body: '검색어나 걸러 보기 조건을 바꿔 보세요.' });
  }
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="송부 이력 표">
    <table class="table">
      <thead><tr>
        <th scope="col">송부 일시</th><th scope="col">파일명</th><th scope="col">송부자</th><th scope="col">송부 수단</th>
        <th scope="col">수신처</th><th scope="col">저장 경로</th><th scope="col">파일 원본</th><th scope="col">검토</th>
      </tr></thead>
      <tbody>
        ${rows.map(
          (t) => html`<tr>
            <td class="num nowrap">${fmtDateTime(t.sentAt)}</td>
            <td><button type="button" class="cell-link" data-open-transfer="${t.id}">${t.fileName}</button> ${labelChip(t.release.labelId)}</td>
            <td class="nowrap">${t.user.name}<small>${t.user.dept}</small></td>
            <td>${channelTag(t.channel)}<small>${channelDetailText(t) || '-'}</small></td>
            <td>${t.recipientName}<small>${RECIPIENT_TYPES[t.recipientType]}</small></td>
            <td>${storageBadge(t)}</td>
            <td>${t.hashMatch ? badge('원본 일치', 'control', 'check') : badge('원본과 다름', 'audit', 'alert')}</td>
            <td>${reviewBadge(t.review.status)}</td>
          </tr>`
        )}
      </tbody>
    </table>
  </div>`;
}

function releasesTable(rows) {
  if (!rows.length) {
    return emptyState({ iconName: 'search', title: '조건에 맞는 해제 기록이 없습니다', body: '검색어나 걸러 보기 조건을 바꿔 보세요.' });
  }
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label="해제 이력 표">
    <table class="table">
      <thead><tr>
        <th scope="col">해제 일시</th><th scope="col">해제 파일</th><th scope="col">해제자</th><th scope="col">수신처</th>
        <th scope="col">해제 사유</th><th scope="col">상태</th>
      </tr></thead>
      <tbody>
        ${rows.map(
          (r) => html`<tr>
            <td class="num nowrap">${fmtDateTime(r.releasedAt)}</td>
            <td><button type="button" class="cell-link" data-open-release="${r.id}">${r.fileName}</button> ${labelChip(r.labelId)}</td>
            <td class="nowrap">${r.user.name}<small>${r.user.dept}</small></td>
            <td>${r.recipientName}<small>${RECIPIENT_TYPES[r.recipientType]}</small></td>
            <td class="cell-clip">${r.reason}</td>
            <td>${statusBadge(r.status)}${r.transferCount ? html`<small>송부 ${r.transferCount}건</small>` : ''}</td>
          </tr>`
        )}
      </tbody>
    </table>
  </div>`;
}

function eventSummary(event) {
  const d = event.detail ?? {};
  return [d.code, d.fileName, d.recipient, d.status && REVIEW[d.status]?.name, d.rows != null && `${d.rows}행`, d.reason, d.note]
    .filter(Boolean)
    .join(' · ');
}

function eventsList(events) {
  const verify = view.verify;
  return html`<div class="chain">
    <div class="chain-head">
      <p class="dim">모든 해제 · 송부 · 열람은 앞 이벤트의 해시를 품은 채 순서대로 기록됩니다. 중간 기록이 바뀌거나 지워지면 검증에서 드러납니다.</p>
      <button type="button" class="btn" data-verify>${icon('link', 16)}체인 검증</button>
    </div>
    ${verify
      ? verify.ok
        ? notice('control', `이벤트 ${verify.count}건의 체인이 온전합니다`, `마지막 해시 ${shortHash(verify.head)}`)
        : notice('audit', `${verify.brokenAt}번 이벤트에서 체인이 끊어졌습니다`, `${verify.reason} 정보보호 책임자에게 바로 알려 주세요.`)
      : ''}
    <div class="table-wrap" tabindex="0" role="region" aria-label="감사 이벤트 표">
      <table class="table">
        <thead><tr><th scope="col">순번</th><th scope="col">일시</th><th scope="col">행위자</th><th scope="col">행위</th><th scope="col">내용</th><th scope="col">해시</th></tr></thead>
        <tbody>
          ${events.map(
            (event) => html`<tr>
              <td class="mono">${event.seq}</td>
              <td class="num nowrap">${fmtDateTime(event.ts)}</td>
              <td class="nowrap">${event.actor_name ?? '-'}</td>
              <td class="nowrap">${AUDIT_ACTIONS[event.action] ?? event.action}</td>
              <td class="cell-clip">${eventSummary(event) || '-'}</td>
              <td class="mono dim" title="${event.hash}">${event.hash.slice(0, 10)}…</td>
            </tr>`
          )}
        </tbody>
      </table>
    </div>
  </div>`;
}

// ── 걸러 보기 ──────────────────────────────────────────

function filterBar() {
  const f = view.filters;
  const select = (name, label, options) => html`<label class="filter">
    <span>${label}</span>
    <select name="${name}">
      <option value="">전체</option>
      ${Object.entries(options).map(([id, text]) => html`<option value="${id}" ${f[name] === id ? 'selected' : ''}>${text}</option>`)}
    </select>
  </label>`;
  const names = (table) => Object.fromEntries(Object.entries(table).map(([id, v]) => [id, v.name ?? v]));
  const transfersOnly = view.tab === 'transfers';
  const active = Object.values(f).some(Boolean);
  return html`<form class="filters" data-filters role="search" aria-label="감사 기록 걸러 보기">
    <label class="filter filter-search">
      <span>검색</span>
      <span class="search-box">${icon('search', 16)}<input type="search" name="q" value="${f.q}" placeholder="파일명, 이름, 부서, 수신처, 번호"></span>
    </label>
    ${transfersOnly ? select('channel', '송부 수단', names(CHANNELS)) : ''}
    ${select('recipientType', '수신처 구분', RECIPIENT_TYPES)}
    ${select('label', '등급', names(LABELS))}
    ${transfersOnly ? select('review', '검토', names(REVIEW)) : ''}
    <label class="filter"><span>시작일</span><input type="date" name="from" value="${f.from}"></label>
    <label class="filter"><span>종료일</span><input type="date" name="to" value="${f.to}"></label>
    ${transfersOnly
      ? html`<label class="check filter-check"><input type="checkbox" name="offline" value="1" ${f.offline ? 'checked' : ''}><span>PC에 먼저 저장된 건</span></label>
          <label class="check filter-check"><input type="checkbox" name="mismatch" value="1" ${f.mismatch ? 'checked' : ''}><span>원본과 다른 건</span></label>`
      : ''}
    ${active ? html`<button type="button" class="btn btn-sm" data-clear>조건 지우기</button>` : ''}
  </form>`;
}

// ── 상세 ───────────────────────────────────────────────

function downloadButton(kind, id, fileName, label) {
  return html`<button type="button" class="btn btn-sm" data-download="${kind}" data-id="${id}" data-name="${fileName}">${icon('download', 14)}${label}</button>`;
}

function bindDownloads(root) {
  for (const button of $$('[data-download]', root)) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const blob = await api.audit.file(button.dataset.download, button.dataset.id);
        await saveBlob(blob, button.dataset.name);
        toast('파일 원본을 내려받았습니다. 열람 사실이 감사 이벤트에 기록되었습니다.', { tone: 'info' });
      } catch (error) {
        toast(error.message, { tone: 'error' });
      }
      button.disabled = false;
    });
  }
}

function openTransfer(transfer, user, reload) {
  const hours = Math.round((new Date(transfer.receivedAt) - new Date(transfer.sentAt)) / 3_600_000);
  const own = transfer.user.id === user.id;
  openDrawer({
    title: transfer.fileName,
    subtitle: transfer.code,
    render(body, close) {
      mount(
        body,
        html`${transfer.hashMatch ? '' : notice('audit', '해제한 원본과 다른 파일이 송부되었습니다', '해제 후 파일이 수정되었거나 다른 파일이 같은 이름으로 나갔을 수 있습니다. 보관된 파일 원본을 확인해 주세요.')}
          ${transfer.detail.clockAdjusted ? notice('channel', 'PC가 적어 둔 송부 시각을 쓸 수 없었습니다', '해제 이전이거나 미래 시각이어서 서버 저장 시각으로 대신 기록했습니다.', 'clock') : ''}

          <section class="zone-panel zone-control zone-audit is-inline">
            <span class="zone-tag">시스템 통제 및 감사 · 저장 정보</span>
            ${defList([
              ['파일 원본', html`${fmtSize(transfer.size)} ${downloadButton('transfer', transfer.id, transfer.fileName, '원본 내려받기')}`],
              ['파일명', transfer.fileName],
              ['송부자', `${transfer.user.name} (${transfer.user.dept})`],
              ['송부 일시', html`<span class="num">${fmtDateTime(transfer.sentAt)}</span>`],
            ])}
          </section>

          <h3>저장 경로</h3>
          ${defList([
            ['경로', transfer.capturedOffline ? '네트워크 미연결: PC에 저장 후 서버에 저장' : '네트워크 연결: 서버에 바로 저장'],
            ['서버 저장 일시', html`<span class="num">${fmtDateTime(transfer.receivedAt)}</span>${transfer.capturedOffline && hours >= 1 ? html` <span class="dim">(송부 ${hours}시간 뒤)</span>` : ''}`],
            ['기기', transfer.device ?? '-'],
            ['SHA-256', html`<span class="mono break">${transfer.fileSha256}</span>`],
          ])}

          <h3>송부 수단과 수신처</h3>
          ${defList([
            ['송부 수단', CHANNELS[transfer.channel].full],
            ['상세', channelDetailText(transfer) || '-'],
            transfer.detail.subject ? ['제목', transfer.detail.subject] : null,
            transfer.detail.body ? [transfer.channel === 'gw' ? '본문' : '메모', transfer.detail.body] : null,
            ['수신처', recipientText(transfer)],
          ])}

          <h3>해제 기록</h3>
          ${defList([
            ['해제 번호', html`<span class="mono">${transfer.release.code}</span>`],
            ['해제 일시', html`<span class="num">${fmtDateTime(transfer.release.releasedAt)}</span>`],
            ['등급', labelChip(transfer.release.labelId)],
            ['해제 사유', transfer.release.reason],
          ])}

          <h3>검토</h3>
          ${transfer.review.status !== 'pending'
            ? html`<p class="review-now">${reviewBadge(transfer.review.status)} <span class="dim">${transfer.review.reviewer} · ${fmtDateTime(transfer.review.at)}</span></p>
                ${transfer.review.note ? html`<blockquote class="review-note">${transfer.review.note}</blockquote>` : ''}`
            : ''}
          ${own
            ? notice('neutral', '본인이 송부한 건입니다', '직접 검토할 수 없습니다. 다른 감사 담당자가 검토합니다.')
            : html`<form class="form review-form" data-review novalidate>
                <fieldset class="field" data-field="status">
                  <legend>검토 결과</legend>
                  <div class="segmented">
                    <label><input type="radio" name="status" value="ok" ${transfer.review.status === 'ok' ? 'checked' : ''}><span>적정</span></label>
                    <label><input type="radio" name="status" value="flagged" ${transfer.review.status === 'flagged' ? 'checked' : ''}><span>소명 요청</span></label>
                  </div>
                  <p class="field-error" aria-live="polite"></p>
                </fieldset>
                <div class="field" data-field="note">
                  <label for="review-note">검토 의견</label>
                  <textarea id="review-note" name="note" rows="3" maxlength="500" aria-describedby="review-note-hint review-note-error"
                    placeholder="소명을 요청할 때는 무엇을 확인해야 하는지 적어 주세요.">${transfer.review.note ?? ''}</textarea>
                  <p class="field-hint" id="review-note-hint">소명 요청은 의견이 필수입니다. 송부자의 문서함에 표시됩니다.</p>
                  <p class="field-error" id="review-note-error" aria-live="polite"></p>
                </div>
                <div class="actions"><button type="submit" class="btn btn-primary">검토 결과 저장</button></div>
              </form>`}`
      );
      bindDownloads(body);
      const form = $('[data-review]', body);
      form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const status = form.elements.status.value;
        const note = form.elements.note.value.trim();
        fieldError(form, 'status', status ? null : '검토 결과를 선택해 주세요.');
        fieldError(form, 'note', status === 'flagged' && note.length < 5 ? '소명을 요청하려면 의견을 5자 이상 적어 주세요.' : null);
        if (!status || (status === 'flagged' && note.length < 5)) return;
        try {
          await api.audit.review(transfer.id, { status, note });
          toast('검토 결과를 저장했습니다.');
          close();
          reload();
        } catch (error) {
          toast(error.message, { tone: 'error' });
        }
      });
    },
  });
}

function openRelease(release) {
  openDrawer({
    title: release.fileName,
    subtitle: release.code,
    render(body) {
      mount(
        body,
        html`<section class="zone-panel zone-control is-inline">
            <span class="zone-tag">시스템 통제 · 저장 정보</span>
            ${defList([
              ['해제자', `${release.user.name} (${release.user.dept})`],
              ['해제 일시', html`<span class="num">${fmtDateTime(release.releasedAt)}</span>`],
              ['해제 파일 원본', html`${fmtSize(release.size)} ${downloadButton('release', release.id, release.fileName, '원본 내려받기')}`],
            ])}
          </section>

          <h3>문서</h3>
          ${defList([
            ['등급', labelChip(release.labelId)],
            ['보호된 파일명', release.protectedName],
            ['보호 설정자', release.labelOwner ?? '-'],
            ['보호 일시', fmtDateTime(release.protectedAt)],
            ['SHA-256', html`<span class="mono break">${release.fileSha256}</span>`],
          ])}

          <h3>자가 승인 내용</h3>
          ${defList([
            ['수신처', recipientText(release)],
            ['해제 사유', release.reason],
            ['기기', release.device ?? '-'],
          ])}

          <h3>송부</h3>
          ${defList([
            ['상태', html`${statusBadge(release.status)} ${release.transferCount ? `송부 ${release.transferCount}건` : ''}`],
            ['송부 가능 기한', html`<span class="num">${fmtDateTime(release.expiresAt)}</span>`],
          ])}`
      );
      bindDownloads(body);
    },
  });
}

// ── 화면 ───────────────────────────────────────────────

export async function auditView(ctx) {
  const { el, user } = ctx;

  if (!isOnline()) {
    mount(el, html`<div class="page">
      <header class="page-head"><div><p class="eyebrow">시스템 통제 및 감사</p><h1>감사 로그</h1></div></header>
      ${emptyState({ iconName: 'wifiOff', title: '서버에 연결해야 볼 수 있습니다', body: '감사 기록은 서버에만 보관됩니다. 네트워크에 연결되면 자동으로 다시 불러옵니다.' })}
    </div>`);
    return;
  }

  let stats = await api.audit.stats();
  let rows = [];

  async function loadRows() {
    if (view.tab === 'transfers') rows = (await api.audit.transfers(view.filters)).transfers;
    else if (view.tab === 'releases') rows = (await api.audit.releases(view.filters)).releases;
    else rows = (await api.audit.events()).events;
  }

  function renderResults() {
    const host = $('[data-results]', el);
    if (!host) return;
    mount(
      host,
      html`${view.tab === 'events' ? '' : html`<p class="result-count" role="status">${rows.length}건${rows.length === 500 ? ' (최근 500건까지 표시)' : ''}</p>`}
        ${view.tab === 'transfers' ? transfersTable(rows) : view.tab === 'releases' ? releasesTable(rows) : eventsList(rows)}`
    );
    for (const button of $$('[data-open-transfer]', host)) {
      button.addEventListener('click', () => openTransfer(rows.find((t) => t.id === button.dataset.openTransfer), user, reload));
    }
    for (const button of $$('[data-open-release]', host)) {
      button.addEventListener('click', () => openRelease(rows.find((r) => r.id === button.dataset.openRelease)));
    }
    $('[data-verify]', host)?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      mount(button, html`${spinner('검증 중')} 검증하는 중…`);
      try {
        view.verify = await api.audit.verify();
        await loadRows();
      } catch (error) {
        toast(error.message, { tone: 'error' });
      }
      if (ctx.isCurrent()) renderResults();
    });
  }

  function render({ focus } = {}) {
    mount(
      el,
      html`<div class="page page-wide">
        <header class="page-head">
          <div>
            <p class="eyebrow">시스템 통제 및 감사</p>
            <h1>감사 로그</h1>
            <p class="lede">누가 어떤 문서를 해제해 어디로 보냈는지, 보관된 파일 원본과 함께 확인합니다.</p>
          </div>
          <button type="button" class="btn" data-export>${icon('download')}송부 이력 내보내기 (CSV)</button>
        </header>

        ${statTiles(stats)}

        <section class="card charts" aria-label="송부 현황">
          ${dailyChart(stats.daily)}
          ${barList('송부 수단별', stats.byChannel, Object.fromEntries(Object.entries(CHANNELS).map(([id, c]) => [id, c.name])))}
          ${barList('수신처 구분별', stats.byRecipientType, RECIPIENT_TYPES)}
        </section>

        <div class="tabs" role="group" aria-label="기록 종류">
          ${TABS.map(([id, name]) => html`<button type="button" class="tab" data-tab="${id}" aria-pressed="${String(view.tab === id)}">${name}</button>`)}
        </div>
        ${view.tab === 'events' ? '' : filterBar()}
        <div data-results></div>
      </div>`
    );
    renderResults();
    bind();
    if (focus) $(focus, el)?.focus();
  }

  async function reload({ focus } = {}) {
    try {
      [stats] = await Promise.all([api.audit.stats(), loadRows()]);
    } catch (error) {
      toast(error.message, { tone: 'error' });
      return;
    }
    if (ctx.isCurrent()) render({ focus });
  }

  const refreshRows = debounce(async () => {
    try {
      await loadRows();
    } catch (error) {
      toast(error.message, { tone: 'error' });
      return;
    }
    if (ctx.isCurrent()) renderResults();
  }, 250);

  function bind() {
    for (const button of $$('[data-tab]', el)) {
      button.addEventListener('click', async () => {
        view.tab = button.dataset.tab;
        await reload({ focus: `[data-tab="${view.tab}"]` });
      });
    }
    for (const button of $$('[data-quick]', el)) {
      button.addEventListener('click', async () => {
        const [key, value] = button.dataset.quick.split('=');
        view.tab = 'transfers';
        view.filters = { ...emptyFilters(), [key]: value };
        await reload({ focus: '[data-results] .cell-link' });
      });
    }
    const form = $('[data-filters]', el);
    if (form) {
      form.addEventListener('submit', (event) => event.preventDefault());
      const read = () => {
        const next = emptyFilters();
        for (const key of Object.keys(next)) {
          const control = form.elements[key];
          if (!control) continue;
          next[key] = control.type === 'checkbox' ? (control.checked ? '1' : '') : control.value.trim();
        }
        view.filters = next;
      };
      form.addEventListener('input', () => {
        read();
        refreshRows();
      });
      // 조건 지우기 버튼은 조건이 생기거나 사라질 때만 바뀌므로, 선택 상자 변경 때 한 번에 다시 그린다.
      form.addEventListener('change', (event) => {
        if (event.target.name === 'q') return;
        read();
        reload({ focus: `[data-filters] [name="${event.target.name}"]` });
      });
      $('[data-clear]', form)?.addEventListener('click', () => {
        view.filters = emptyFilters();
        reload({ focus: '[data-filters] [name="q"]' });
      });
    }
    $('[data-export]', el).addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const blob = await api.audit.exportCsv(view.tab === 'transfers' ? view.filters : {});
        await saveBlob(blob, `송부이력_${new Date().toISOString().slice(0, 10)}.csv`);
      } catch (error) {
        toast(error.message, { tone: 'error' });
      }
      button.disabled = false;
    });
  }

  await loadRows();
  render();
}
