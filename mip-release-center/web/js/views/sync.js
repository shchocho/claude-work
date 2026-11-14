import { channelDetailText, channelTag, emptyState, fileGlyph, notice } from '../lib/components.js';
import { $, $$, fmtDateTime, fmtSize, html, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { isOnline } from '../lib/net.js';
import { queue, vault } from '../lib/store.js';
import { onQueueChange, syncQueue } from '../lib/sync.js';
import { confirmDialog, spinner, toast } from '../lib/ui.js';

export async function syncView(ctx) {
  const { el, user } = ctx;

  async function render() {
    const [pending, copies] = await Promise.all([queue.list(user.id), vault.list(user.id)]);
    if (!ctx.isCurrent()) return;
    const online = isOnline();
    const referenced = new Set(pending.map((entry) => entry.meta.releaseId));

    mount(
      el,
      html`<div class="page">
        <header class="page-head">
          <div>
            <p class="eyebrow">네트워크 미연결 시</p>
            <h1>동기화 대기함</h1>
            <p class="lede">서버에 닿지 않을 때 남긴 송부 기록은 이 PC에 저장되고, 서버에 접속하면 파일 원본과 함께 서버로 저장됩니다.</p>
          </div>
          <button type="button" class="btn btn-primary" data-sync ${online && pending.length ? '' : 'disabled'}>${icon('sync')}지금 동기화</button>
        </header>

        ${!online && pending.length
          ? notice('channel', '서버에 연결되면 자동으로 저장됩니다', '지금은 네트워크 미연결 상태입니다. 이 화면을 열어 두지 않아도 됩니다.', 'wifiOff')
          : ''}

        <section class="card" aria-labelledby="queue-title">
          <header class="card-head"><h2 id="queue-title">서버 저장을 기다리는 송부 기록 <span class="count">${pending.length}</span></h2></header>
          ${pending.length
            ? html`<ul class="doc-list">
                ${pending.map(
                  (entry) => html`<li class="doc-row">
                    ${fileGlyph(entry.fileName)}
                    <div class="doc-main">
                      <p class="doc-name">${entry.fileName}</p>
                      <p class="doc-sub">
                        ${channelTag(entry.meta.channel)} ${channelDetailText({ channel: entry.meta.channel, detail: entry.meta.detail })}
                        <span class="sep">·</span>송부 <time class="num" datetime="${entry.sentAt}">${fmtDateTime(entry.sentAt)}</time>
                        <span class="sep">·</span>${fmtSize(entry.size)}
                      </p>
                      ${entry.lastError ? html`<p class="row-error">${icon('alert', 14)}서버가 받지 않았습니다: ${entry.lastError}</p>` : ''}
                    </div>
                    <span class="badge ${entry.lastError ? 'badge-audit' : 'badge-channel'}">${icon('monitor', 14)}${entry.lastError ? '확인 필요' : '이 PC에 저장됨'}</span>
                  </li>`
                )}
              </ul>`
            : emptyState({
                iconName: 'check',
                title: '서버 저장을 기다리는 기록이 없습니다',
                body: '모든 송부 기록이 서버에 저장되어 있습니다.',
              })}
        </section>

        <section class="card" aria-labelledby="vault-title">
          <header class="card-head"><h2 id="vault-title">이 PC에 보관 중인 해제 파일 <span class="count">${copies.length}</span></h2></header>
          ${copies.length
            ? html`<ul class="doc-list">
                ${copies.map(
                  (copy) => html`<li class="doc-row">
                    ${fileGlyph(copy.fileName)}
                    <div class="doc-main">
                      <p class="doc-name">${copy.fileName}</p>
                      <p class="doc-sub"><span class="mono">${copy.code}</span><span class="sep">·</span>${fmtSize(copy.size)}<span class="sep">·</span>보관 ${fmtDateTime(copy.savedAt)}</p>
                    </div>
                    ${referenced.has(copy.releaseId)
                      ? html`<span class="dim action-note">동기화가 끝나면 지울 수 있습니다.</span>`
                      : html`<button type="button" class="btn btn-sm" data-remove="${copy.releaseId}" data-name="${copy.fileName}">이 PC에서 삭제</button>`}
                  </li>`
                )}
              </ul>`
            : emptyState({
                iconName: 'monitor',
                title: '이 PC에 보관 중인 해제 파일이 없습니다',
                body: '문서를 해제하면 사본이 이 PC에 보관되어, 서버에 닿지 않을 때도 외부저장매체로 송부할 수 있습니다.',
              })}
        </section>
      </div>`
    );

    $('[data-sync]', el)?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      mount(button, html`${spinner('동기화 중')} 서버에 저장하는 중…`);
      try {
        const result = await syncQueue(user);
        if (result.synced) toast(`송부 기록 ${result.synced}건을 서버에 저장했습니다.`);
        if (result.rejected) toast(`${result.rejected}건을 서버가 받지 않았습니다. 목록에서 사유를 확인해 주세요.`, { tone: 'error' });
        if (!result.synced && !result.rejected) toast('서버에 연결할 수 없습니다. 연결을 확인한 뒤 다시 시도해 주세요.', { tone: 'warn' });
      } catch (error) {
        toast(error.message, { tone: 'error' });
      }
    });

    for (const button of $$('[data-remove]', el)) {
      button.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: `${button.dataset.name} 사본을 이 PC에서 삭제할까요?`,
          body: '서버의 해제 기록과 원본은 그대로 남습니다. 삭제한 뒤에는 서버에 연결된 상태에서만 이 문서를 송부할 수 있습니다.',
          confirmLabel: '이 PC에서 삭제',
          cancelLabel: '보관 유지',
          danger: true,
        });
        if (!ok) return;
        await vault.remove(button.dataset.remove);
        toast('이 PC에서 사본을 삭제했습니다.');
        render();
      });
    }
  }

  await render();
  return onQueueChange(() => {
    if (ctx.isCurrent()) render();
  });
}
