import { OfflineError } from '../lib/api.js';
import { defList, emptyState, fileGlyph, labelChip, notice } from '../lib/components.js';
import { CHANNELS, MEDIA_TYPES, RECIPIENT_TYPES } from '../lib/consts.js';
import { $, $$, deviceLabel, fmtDateTime, fmtRemaining, html, mount } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { isOnline, onNetChange } from '../lib/net.js';
import { vault } from '../lib/store.js';
import { ensureLocalCopy, loadReleases, recordTransfer } from '../lib/sync.js';
import { fieldError, focusFirstError, saveBlob, spinner, toast } from '../lib/ui.js';

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;

const SUBMIT_LABEL = {
  gw: ['send', 'G/W로 송부'],
  media: ['download', '매체에 저장하고 기록'],
  pmail: ['send', '개인메일로 송부'],
};

function channelFields(channel, form, meta) {
  if (channel === 'gw') {
    return html`<div class="field" data-field="to">
        <label for="to">받는 사람 <span class="req">필수</span></label>
        <input id="to" name="to" type="text" inputmode="email" autocomplete="off" placeholder="buyer@customer.com" value="${form.to}" aria-describedby="to-hint to-error">
        <p class="field-hint" id="to-hint">여러 명은 쉼표(,)로 구분합니다. 최대 10명.</p>
        <p class="field-error" id="to-error" aria-live="polite"></p>
      </div>
      <div class="field" data-field="subject">
        <label for="subject">제목 <span class="req">필수</span></label>
        <input id="subject" name="subject" type="text" maxlength="120" value="${form.subject}" aria-describedby="subject-error">
        <p class="field-error" id="subject-error" aria-live="polite"></p>
      </div>
      <div class="field" data-field="body">
        <label for="body">본문</label>
        <textarea id="body" name="body" rows="4" maxlength="2000">${form.body}</textarea>
      </div>`;
  }
  if (channel === 'media') {
    return html`<fieldset class="field" data-field="mediaType">
        <legend>매체 종류 <span class="req">필수</span></legend>
        <div class="segmented">
          ${Object.entries(MEDIA_TYPES).map(
            ([id, name]) => html`<label><input type="radio" name="mediaType" value="${id}" ${form.mediaType === id ? 'checked' : ''}><span>${name}</span></label>`
          )}
        </div>
        <p class="field-error" aria-live="polite"></p>
      </fieldset>
      <div class="field" data-field="mediaTag">
        <label for="mediaTag">매체 관리번호</label>
        <input id="mediaTag" name="mediaTag" type="text" maxlength="60" autocomplete="off" placeholder="예: SEC-USB-0142" value="${form.mediaTag}" aria-describedby="mediaTag-hint">
        <p class="field-hint" id="mediaTag-hint">보안 USB처럼 관리번호가 있는 매체라면 적어 주세요.</p>
      </div>`;
  }
  const corp = meta.corpDomains?.[0];
  return html`<div class="field" data-field="address">
      <label for="address">개인 메일 주소 <span class="req">필수</span></label>
      <input id="address" name="address" type="email" autocomplete="off" placeholder="name@naver.com" value="${form.address}" aria-describedby="address-hint address-error">
      <p class="field-hint" id="address-hint">Naver, Hotmail 같은 개인 계정 주소를 적어 주세요.${corp ? ` 회사 메일(@${corp})은 G/W로 보냅니다.` : ''}</p>
      <p class="field-error" id="address-error" aria-live="polite"></p>
    </div>
    <div class="field" data-field="body">
      <label for="body">메모</label>
      <textarea id="body" name="body" rows="3" maxlength="500" placeholder="개인 메일로 보내야 하는 이유를 적어 두면 감사 때 도움이 됩니다.">${form.body}</textarea>
    </div>`;
}

/** 프로세스 그림의 "저장 경로" 두 줄. 지금 적용되는 쪽을 강조한다. */
function storagePath(online) {
  return html`<ul class="paths">
    <li class="${online ? 'is-active' : ''}">
      ${icon('server', 18)}
      <div><strong>네트워크 연결 시</strong><span>서버에 저장</span></div>
      ${online ? html`<span class="badge badge-control">지금</span>` : ''}
    </li>
    <li class="${online ? '' : 'is-active'}">
      ${icon('monitor', 18)}
      <div><strong>네트워크 미연결 시</strong><span>이 PC에 저장, 서버 접속 시 서버에 저장</span></div>
      ${online ? '' : html`<span class="badge badge-channel">지금</span>`}
    </li>
  </ul>`;
}

export async function sendView(ctx) {
  const { el, user, meta, params } = ctx;
  const data = await loadReleases(user);
  const release = data.releases.find((r) => r.id === params[0]);

  if (!release) {
    mount(el, html`<div class="page page-narrow">${emptyState({
      iconName: 'folder',
      title: '문서를 찾을 수 없습니다',
      body: '이미 삭제되었거나 다른 계정에서 해제한 문서입니다.',
      action: html`<a class="btn" href="#/docs">내 문서함으로</a>`,
    })}</div>`);
    return undefined;
  }

  const state = {
    channel: isOnline() ? 'gw' : 'media',
    form: {
      to: '', subject: `${release.fileName} 송부`, body: '', mediaType: 'usb', mediaTag: '', address: '',
      recipientType: release.recipientType, recipientName: release.recipientName,
    },
    result: null,
  };

  function render({ focus } = {}) {
    const online = isOnline();
    const blocked = !release.canSend;
    const [submitIcon, submitLabel] = SUBMIT_LABEL[state.channel];
    const channelUnavailable = CHANNELS[state.channel].needsServer && !online;

    mount(
      el,
      html`<div class="page">
        <a class="back" href="#/docs">${icon('arrowLeft', 16)}내 문서함</a>
        <header class="page-head">
          <div>
            <p class="eyebrow">송부 수단</p>
            <h1>사외 송부</h1>
          </div>
        </header>

        <div class="filecard-head is-banner">
          ${fileGlyph(release.fileName)}
          <div class="doc-main">
            <p class="doc-name">${release.fileName} ${labelChip(release.labelId)}</p>
            <p class="doc-sub"><span class="mono">${release.code}</span><span class="sep">·</span>해제 ${fmtDateTime(release.releasedAt)}<span class="sep">·</span>${fmtRemaining(release.expiresAt)}</p>
          </div>
        </div>

        ${blocked
          ? notice('audit', '송부 가능 기간이 지났습니다', '해제 후 7일이 지나 이 문서는 더 보낼 수 없습니다. 문서를 다시 해제한 뒤 송부해 주세요.')
          : state.result
            ? resultPanel()
            : html`<div class="wizard-split">
                <form class="card form" data-send-form novalidate>
                  <fieldset class="field zone-channel channel-picker" data-field="channel">
                    <legend><span class="zone-tag">송부 수단</span> 어떤 방법으로 보내시나요?</legend>
                    <div class="channel-cards">
                      ${Object.entries(CHANNELS).map(([id, ch]) => {
                        const disabled = ch.needsServer && !online;
                        return html`<label class="channel-card ${disabled ? 'is-disabled' : ''}">
                          <input type="radio" name="channel" value="${id}" ${state.channel === id ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
                          <span class="channel-icon">${icon(ch.icon, 22)}</span>
                          <strong>${ch.name}</strong>
                          <small>${disabled ? '서버 연결이 필요합니다.' : ch.summary}</small>
                        </label>`;
                      })}
                    </div>
                  </fieldset>

                  ${channelFields(state.channel, state.form, meta)}

                  <fieldset class="field" data-field="recipientType">
                    <legend>수신처 구분 <span class="req">필수</span></legend>
                    <div class="segmented">
                      ${Object.entries(RECIPIENT_TYPES).map(
                        ([id, name]) => html`<label><input type="radio" name="recipientType" value="${id}" ${state.form.recipientType === id ? 'checked' : ''}><span>${name}</span></label>`
                      )}
                    </div>
                  </fieldset>
                  <div class="field" data-field="recipientName">
                    <label for="recipientName">수신처명 <span class="req">필수</span></label>
                    <input id="recipientName" name="recipientName" type="text" maxlength="80" autocomplete="off" value="${state.form.recipientName}" aria-describedby="recipientName-error">
                    <p class="field-error" id="recipientName-error" aria-live="polite"></p>
                  </div>

                  <div class="actions">
                    <a class="btn" href="#/docs">취소</a>
                    <button type="submit" class="btn btn-primary" data-submit ${channelUnavailable ? 'disabled' : ''}>${icon(submitIcon, 16)}${submitLabel}</button>
                  </div>
                </form>

                <aside class="zone-panel zone-control zone-audit" aria-labelledby="send-record-title">
                  <span class="zone-tag">시스템 통제 및 감사</span>
                  <h2 id="send-record-title">송부하면 기록되는 정보</h2>
                  ${defList([
                    ['파일 원본', '보낸 파일 그대로 보관'],
                    ['파일명', release.fileName],
                    ['송부자', `${user.name} (${user.dept})`],
                    ['송부 일시', '송부한 시각'],
                  ])}
                  <h3>기록이 저장되는 곳</h3>
                  ${storagePath(online)}
                </aside>
              </div>`}
      </div>`
    );
    bind();
    if (focus) $(focus, el)?.focus();
  }

  function resultPanel() {
    const { result } = state;
    const local = result.where === 'local';
    const channel = CHANNELS[state.channel];
    return html`<section class="card done" aria-labelledby="sent-title">
      <span class="done-icon">${icon(local ? 'monitor' : 'check', 26)}</span>
      <h2 id="sent-title" tabindex="-1">${local ? '송부 기록을 이 PC에 저장했습니다' : '송부하고 기록을 서버에 저장했습니다'}</h2>
      <p class="dim">
        ${local
          ? '서버에 연결되면 파일 원본과 함께 자동으로 서버에 저장됩니다. 그때까지 이 브라우저의 데이터를 지우지 마세요.'
          : html`송부 번호 <span class="mono">${result.transfer.code}</span>`}
      </p>
      <div class="zone-panel zone-control zone-audit is-inline">
        <span class="zone-tag">시스템 통제 및 감사 · 저장된 정보</span>
        ${defList([
          ['파일 원본', local ? '이 PC에 보관 (동기화 대기)' : result.transfer.hashMatch ? '서버에 보관 · 해제 원본과 일치' : '서버에 보관 · 해제 원본과 다름'],
          ['파일명', release.fileName],
          ['송부자', `${user.name} (${user.dept})`],
          ['송부 일시', fmtDateTime(local ? result.entry.sentAt : result.transfer.sentAt)],
          ['송부 수단', channel.full],
        ])}
      </div>
      <div class="actions is-center">
        <button type="button" class="btn" data-again>다른 수단으로 한 번 더 송부</button>
        <a class="btn btn-primary" href="${local ? '#/sync' : '#/docs'}">${local ? '동기화 대기함 보기' : '내 문서함으로'}</a>
      </div>
    </section>`;
  }

  function readForm(form) {
    for (const name of ['to', 'subject', 'body', 'mediaTag', 'address', 'recipientName']) {
      if (form.elements[name]) state.form[name] = form.elements[name].value.trim();
    }
    if (form.elements.mediaType) state.form.mediaType = form.elements.mediaType.value;
    state.form.recipientType = form.elements.recipientType.value;
  }

  function validate(form) {
    readForm(form);
    const f = state.form;
    const errors = { recipientName: f.recipientName.length >= 2 ? null : '수신처명을 2자 이상 입력해 주세요.' };
    if (state.channel === 'gw') {
      const list = f.to.split(/[,;\s]+/).filter(Boolean);
      const bad = list.find((address) => !EMAIL.test(address));
      errors.to = !list.length ? '받는 사람 메일 주소를 입력해 주세요.' : bad ? `메일 주소 형식이 올바르지 않습니다: ${bad}` : list.length > 10 ? '받는 사람은 10명까지 지정할 수 있습니다.' : null;
      errors.subject = f.subject ? null : '제목을 입력해 주세요.';
    }
    if (state.channel === 'pmail') {
      const domain = f.address.split('@')[1]?.toLowerCase();
      errors.address = !EMAIL.test(f.address)
        ? '개인 메일 주소를 name@naver.com 형식으로 입력해 주세요.'
        : meta.corpDomains?.includes(domain)
          ? `${domain}은 회사 메일입니다. 송부 수단에서 G/W를 선택해 주세요.`
          : null;
    }
    for (const [name, message] of Object.entries(errors)) fieldError(form, name, message);
    return Object.values(errors).every((message) => !message);
  }

  function detail() {
    const f = state.form;
    if (state.channel === 'gw') return { to: f.to.split(/[,;\s]+/).filter(Boolean), subject: f.subject, body: f.body };
    if (state.channel === 'media') return { mediaType: f.mediaType, mediaTag: f.mediaTag };
    return { address: f.address, body: f.body };
  }

  async function submit(form) {
    if (!validate(form)) {
      focusFirstError(form);
      return;
    }
    const button = $('[data-submit]', form);
    const restore = button.innerHTML;
    button.disabled = true;
    mount(button, html`${spinner('송부 중')} 처리하는 중…`);
    const fail = (message, tone = 'error') => {
      button.disabled = false;
      button.innerHTML = restore;
      toast(message, { tone });
    };

    try {
      let blob;
      if (state.channel === 'media') {
        // 매체로 나가는 파일은 이 PC 보관함의 사본이다. 없으면 서버에서 먼저 받아 둔다.
        let copy = await vault.get(release.id);
        if (!copy) {
          if (!isOnline()) {
            fail('이 PC에 해제 파일이 없습니다. 서버에 연결한 뒤 다시 시도해 주세요.');
            return;
          }
          copy = await ensureLocalCopy(user, release);
        }
        blob = copy.blob;
        const saved = await saveBlob(blob, release.fileName, { pick: true });
        if (saved === 'cancelled') {
          fail('저장을 취소했습니다. 송부 기록은 남기지 않았습니다.', 'info');
          return;
        }
      }
      state.result = await recordTransfer(
        user,
        {
          clientId: crypto.randomUUID(),
          releaseId: release.id,
          fileName: release.fileName,
          channel: state.channel,
          detail: detail(),
          recipientType: state.form.recipientType,
          recipientName: state.form.recipientName,
          device: deviceLabel(),
        },
        blob
      );
      if (ctx.isCurrent()) render({ focus: '#sent-title' });
    } catch (error) {
      fail(
        error instanceof OfflineError
          ? '서버에 연결할 수 없어 보내지 못했습니다. 메일 송부는 서버 연결이 필요합니다. 입력한 내용은 그대로 두었습니다.'
          : error.message
      );
    }
  }

  function bind() {
    const form = $('[data-send-form]', el);
    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        submit(form);
      });
      for (const radio of $$('input[name="channel"]', form)) {
        radio.addEventListener('change', () => {
          readForm(form);
          state.channel = radio.value;
          render({ focus: `input[name="channel"][value="${radio.value}"]` });
        });
      }
    }
    $('[data-again]', el)?.addEventListener('click', () => {
      state.result = null;
      render({ focus: 'input[name="channel"]:checked' });
    });
  }

  render();
  return onNetChange((online) => {
    if (!ctx.isCurrent() || state.result) return;
    const form = $('[data-send-form]', el);
    if (form) readForm(form);
    if (!online && CHANNELS[state.channel].needsServer) state.channel = 'media';
    render();
  });
}
