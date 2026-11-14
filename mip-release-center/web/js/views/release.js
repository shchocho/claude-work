import { OfflineError, api } from '../lib/api.js';
import { defList, fileGlyph, labelChip, notice } from '../lib/components.js';
import { ACKS, RECIPIENT_TYPES } from '../lib/consts.js';
import { $, $$, deviceLabel, fmtDateTime, fmtSize, html, mount, shortHash } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { isOnline, onNetChange } from '../lib/net.js';
import { ensureLocalCopy, rememberRelease } from '../lib/sync.js';
import { fieldError, focusFirstError, spinner, toast } from '../lib/ui.js';

const fresh = () => ({
  step: 1,
  file: null,
  info: null,
  inspectError: null,
  form: { recipientType: '', recipientName: '', reason: '', acks: [false, false, false] },
  release: null,
  localCopy: false,
});

let state = fresh();

const STEPS = ['파일 선택', '사유 입력 · 자가 승인', '해제 완료'];

function stepper() {
  return html`<ol class="stepper" aria-label="해제 단계">
    ${STEPS.map((name, i) => {
      const n = i + 1;
      const status = n < state.step ? 'done' : n === state.step ? 'current' : 'todo';
      return html`<li class="is-${status}" ${status === 'current' ? html`aria-current="step"` : ''}>
        <span class="step-dot">${status === 'done' ? icon('check', 14) : n}</span>
        <span>${name}${status === 'done' ? html`<span class="sr-only"> (완료)</span>` : ''}</span>
      </li>`;
    })}
  </ol>`;
}

// ── 1단계: 파일 선택 ───────────────────────────────────

function inspectResult() {
  const { file, info, inspectError } = state;
  if (!file) return '';
  const head = html`<div class="filecard-head">
    ${fileGlyph(file.name, { locked: Boolean(info?.protected) })}
    <div class="doc-main">
      <p class="doc-name">${file.name}</p>
      <p class="doc-sub">${fmtSize(file.size)}</p>
    </div>
    <button type="button" class="btn btn-sm" data-reset>다른 파일 선택</button>
  </div>`;

  if (inspectError) {
    return html`<div class="filecard">${head}${notice('audit', '보호 정보를 확인하지 못했습니다', inspectError)}</div>`;
  }
  if (!info) {
    return html`<div class="filecard">${head}<p class="inline-status">${spinner('확인 중')} 보호 정보를 확인하는 중입니다…</p></div>`;
  }
  if (!info.protected) {
    return html`<div class="filecard">${head}
      ${notice('neutral', '보호되지 않은 파일입니다', '암호화 해제 없이 그대로 사용할 수 있습니다. MIP로 보호된 파일을 선택해 주세요.')}
    </div>`;
  }
  if (!info.supported) {
    return html`<div class="filecard">${head}
      ${notice('channel', '이 서버에서는 해제할 수 없는 파일입니다', '실제 MIP 보호 파일로 보입니다. 지금은 체험용 모의 어댑터로 동작하고 있어, MIP SDK 어댑터를 연결해야 해제할 수 있습니다.', 'alert')}
    </div>`;
  }
  const details = defList([
    ['민감도 등급', labelChip(info.labelId)],
    ['원본 파일명', info.originalName],
    ['보호 설정자', info.owner ?? '-'],
    ['보호 일시', fmtDateTime(info.protectedAt)],
  ]);
  if (!info.canUnprotect) {
    return html`<div class="filecard">${head}${details}
      ${notice('audit', '이 문서를 해제할 권한이 없습니다', `${info.denyReason ?? ''} 문서 소유자(${info.owner ?? '미상'})에게 사용 권한을 요청해 주세요.`)}
    </div>`;
  }
  return html`<div class="filecard">${head}${details}
    ${notice('control', '해제할 수 있는 문서입니다', '다음 단계에서 해제 사유를 적고 자가 승인하면 암호화가 해제됩니다.')}
    <div class="actions"><button type="button" class="btn btn-primary" data-next>다음: 사유 입력 ${icon('arrowRight', 16)}</button></div>
  </div>`;
}

function stepOne(samples, meta) {
  const offline = !isOnline();
  return html`<div class="wizard-single">
    ${offline ? notice('channel', '암호화 해제는 서버 연결이 필요합니다', '문서의 사용 권한을 서버에서 확인해야 합니다. 네트워크에 연결한 뒤 다시 시도해 주세요.', 'wifiOff') : ''}
    ${state.file
      ? inspectResult()
      : html`<label class="dropzone ${offline ? 'is-disabled' : ''}" data-dropzone>
          <input type="file" class="sr-only" data-file-input ${offline ? 'disabled' : ''}>
          <span class="dropzone-icon">${icon('upload', 26)}</span>
          <strong>MIP로 보호된 파일을 끌어다 놓거나 선택하세요</strong>
          <span class="dim">한 번에 한 개 · 최대 ${Math.floor(meta.maxFileBytes / 1024 / 1024)}MB</span>
          <span class="btn" aria-hidden="true">파일 선택</span>
        </label>`}
    ${!state.file && samples.length
      ? html`<section class="samples" aria-labelledby="samples-title">
          <h2 id="samples-title">샘플 문서로 먼저 확인해 보기</h2>
          <p class="dim">체험용 보호 문서입니다. 선택하면 실제 파일을 올린 것과 같은 흐름으로 진행됩니다.</p>
          <ul>
            ${samples.map(
              (s) => html`<li><button type="button" class="sample" data-sample="${s.id}" data-name="${s.fileName}" ${offline ? 'disabled' : ''}>
                ${fileGlyph(s.fileName, { locked: true })}
                <span class="doc-main"><span class="doc-name">${s.fileName}</span><span class="doc-sub">${s.hint}</span></span>
                ${labelChip(s.labelId)}
              </button></li>`
            )}
          </ul>
        </section>`
      : ''}
  </div>`;
}

// ── 2단계: 사유 입력 · 자가 승인 ───────────────────────

function stepTwo(user) {
  const { form, info, file } = state;
  return html`<div class="wizard-split">
    <form class="card form" data-release-form novalidate>
      <div class="filecard-head is-compact">
        ${fileGlyph(file.name, { locked: true })}
        <div class="doc-main">
          <p class="doc-name">${info.originalName} ${labelChip(info.labelId)}</p>
          <p class="doc-sub">${fmtSize(file.size)} · 보호 설정자 ${info.owner ?? '-'}</p>
        </div>
      </div>

      <fieldset class="field" data-field="recipientType">
        <legend>수신처 구분 <span class="req">필수</span></legend>
        <div class="segmented">
          ${Object.entries(RECIPIENT_TYPES).map(
            ([id, name]) => html`<label><input type="radio" name="recipientType" value="${id}" ${form.recipientType === id ? 'checked' : ''}><span>${name}</span></label>`
          )}
        </div>
        <p class="field-error" aria-live="polite"></p>
      </fieldset>

      <div class="field" data-field="recipientName">
        <label for="recipientName">수신처명 <span class="req">필수</span></label>
        <input id="recipientName" name="recipientName" type="text" maxlength="80" autocomplete="off"
          placeholder="예: ACME Corp. 구매팀" value="${form.recipientName}" aria-describedby="recipientName-error">
        <p class="field-error" id="recipientName-error" aria-live="polite"></p>
      </div>

      <div class="field" data-field="reason">
        <label for="reason">해제 사유 <span class="req">필수</span></label>
        <textarea id="reason" name="reason" rows="4" maxlength="500" aria-describedby="reason-hint reason-error"
          placeholder="누구에게, 왜 보내야 하는지 적어 주세요.">${form.reason}</textarea>
        <p class="field-hint" id="reason-hint"><span>10자 이상. 감사 담당자가 그대로 읽습니다.</span><span class="mono" data-count>${form.reason.length}/500</span></p>
        <p class="field-error" id="reason-error" aria-live="polite"></p>
      </div>

      <fieldset class="field acks" data-field="acks">
        <legend>자가 승인 <span class="req">필수</span></legend>
        ${ACKS.map(
          (text, i) => html`<label class="check"><input type="checkbox" name="ack" value="${i}" ${form.acks[i] ? 'checked' : ''}><span>${text}</span></label>`
        )}
        <p class="field-error" aria-live="polite"></p>
      </fieldset>

      <div class="actions">
        <button type="button" class="btn" data-back>${icon('arrowLeft', 16)}이전</button>
        <button type="submit" class="btn btn-primary" data-submit>${icon('unlock', 16)}자가 승인하고 해제</button>
      </div>
    </form>

    <aside class="zone-panel zone-control" aria-labelledby="record-title">
      <span class="zone-tag">시스템 통제</span>
      <h2 id="record-title">해제하면 기록되는 정보</h2>
      ${defList([
        ['해제자', `${user.name} (${user.dept})`],
        ['해제 일시', '자가 승인한 시각'],
        ['해제 파일 원본', '서버에 보관'],
      ])}
      <p class="dim">기록은 감사 담당자가 열람하며, 수정하거나 삭제할 수 없습니다.</p>
    </aside>
  </div>`;
}

function readForm(form) {
  state.form = {
    recipientType: form.elements.recipientType.value,
    recipientName: form.elements.recipientName.value.trim(),
    reason: form.elements.reason.value.trim(),
    acks: $$('input[name="ack"]', form).map((box) => box.checked),
  };
  return state.form;
}

function validate(form) {
  const values = readForm(form);
  const errors = {
    recipientType: values.recipientType ? null : '수신처 구분을 선택해 주세요.',
    recipientName: values.recipientName.length >= 2 ? null : '수신처명을 2자 이상 입력해 주세요.',
    reason: values.reason.length >= 10 ? null : `해제 사유를 10자 이상 입력해 주세요. (현재 ${values.reason.length}자)`,
    acks: values.acks.every(Boolean) ? null : '세 항목을 모두 확인하고 체크해 주세요.',
  };
  for (const [name, message] of Object.entries(errors)) fieldError(form, name, message);
  return Object.values(errors).every((message) => !message);
}

// ── 3단계: 완료 ────────────────────────────────────────

function stepThree() {
  const { release, localCopy } = state;
  return html`<div class="wizard-single">
    <section class="card done" aria-labelledby="done-title">
      <span class="done-icon">${icon('unlock', 26)}</span>
      <h2 id="done-title" tabindex="-1">암호화를 해제했습니다</h2>
      <p class="dim">해제 번호 <span class="mono">${release.code}</span> · 송부 가능 기한 ${fmtDateTime(release.expiresAt)}</p>

      <div class="zone-panel zone-control is-inline">
        <span class="zone-tag">시스템 통제 · 저장된 정보</span>
        ${defList([
          ['해제자', `${release.user.name} (${release.user.dept})`],
          ['해제 일시', fmtDateTime(release.releasedAt)],
          ['해제 파일 원본', html`${release.fileName} <span class="dim">(${fmtSize(release.size)})</span>`],
          ['SHA-256', html`<span class="mono" title="${release.fileSha256}">${shortHash(release.fileSha256)}</span>`],
        ])}
      </div>

      ${localCopy
        ? notice('neutral', '해제 파일을 이 PC에도 보관했습니다', '서버 연결이 끊겨도 외부저장매체로 송부하고 기록을 남길 수 있습니다.', 'monitor')
        : notice('channel', '해제 파일을 이 PC에 보관하지 못했습니다', '송부는 서버에 연결된 상태에서만 할 수 있습니다.', 'alert')}

      <div class="actions is-center">
        <a class="btn" href="#/docs">내 문서함으로</a>
        <a class="btn btn-primary" href="#/docs/${release.id}/send">${icon('send', 16)}지금 송부하기</a>
      </div>
    </section>
  </div>`;
}

// ── 화면 ───────────────────────────────────────────────

export async function releaseView(ctx) {
  const { el, user, meta } = ctx;
  if (state.step === 3) state = fresh();

  let samples = [];
  try {
    if (isOnline()) samples = (await api.samples()).samples;
  } catch {
    /* 샘플 목록은 없어도 된다 */
  }

  function render({ focus } = {}) {
    mount(
      el,
      html`<div class="page page-narrow">
        <header class="page-head">
          <div>
            <p class="eyebrow">자가 승인 후 해제</p>
            <h1>문서 해제</h1>
          </div>
        </header>
        ${stepper()}
        ${state.step === 1 ? stepOne(samples, meta) : state.step === 2 ? stepTwo(user) : stepThree()}
      </div>`
    );
    bind();
    if (focus) $(focus, el)?.focus();
  }

  async function choose(file) {
    if (!file) return;
    if (file.size > meta.maxFileBytes) {
      toast(`파일이 너무 큽니다. ${Math.floor(meta.maxFileBytes / 1024 / 1024)}MB 이하 파일만 해제할 수 있습니다.`, { tone: 'error' });
      return;
    }
    state.file = file;
    state.info = null;
    state.inspectError = null;
    render();
    try {
      const info = await api.inspect(file);
      if (state.file !== file) return;
      state.info = info;
    } catch (error) {
      if (state.file !== file) return;
      state.inspectError = error.message;
    }
    if (!ctx.isCurrent()) return;
    render();
    // 해제할 수 있으면 "다음"으로, 아니면 "다른 파일 선택"으로 포커스를 보낸다.
    ($('[data-next]', el) ?? $('[data-reset]', el))?.focus();
  }

  async function submit(form) {
    if (!validate(form)) {
      focusFirstError(form);
      return;
    }
    const button = $('[data-submit]', form);
    button.disabled = true;
    mount(button, html`${spinner('해제 중')} 암호화를 해제하는 중…`);
    try {
      const { release } = await api.createRelease({ ...state.form, fileName: state.file.name, device: deviceLabel() }, state.file);
      state.release = release;
      rememberRelease(user, release);
      try {
        await ensureLocalCopy(user, release);
        state.localCopy = true;
      } catch {
        state.localCopy = false;
      }
      state.step = 3;
      if (ctx.isCurrent()) render({ focus: '#done-title' });
    } catch (error) {
      if (!ctx.isCurrent()) return;
      render();
      toast(
        error instanceof OfflineError ? '서버에 연결할 수 없어 해제하지 못했습니다. 입력한 내용은 그대로 두었습니다. 연결을 확인한 뒤 다시 시도해 주세요.' : error.message,
        { tone: 'error' }
      );
    }
  }

  function bind() {
    const zone = $('[data-dropzone]', el);
    if (zone && !zone.classList.contains('is-disabled')) {
      $('[data-file-input]', zone).addEventListener('change', (event) => choose(event.target.files[0]));
      for (const type of ['dragenter', 'dragover']) {
        zone.addEventListener(type, (event) => {
          event.preventDefault();
          zone.classList.add('is-over');
        });
      }
      for (const type of ['dragleave', 'drop']) {
        zone.addEventListener(type, (event) => {
          event.preventDefault();
          zone.classList.remove('is-over');
        });
      }
      zone.addEventListener('drop', (event) => choose(event.dataTransfer?.files?.[0]));
    }
    for (const button of $$('[data-sample]', el)) {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const blob = await api.sampleFile(button.dataset.sample);
          choose(new File([blob], button.dataset.name, { type: 'application/octet-stream' }));
        } catch (error) {
          button.disabled = false;
          toast(error.message, { tone: 'error' });
        }
      });
    }
    $('[data-reset]', el)?.addEventListener('click', () => {
      state = fresh();
      render({ focus: '[data-file-input]' });
    });
    $('[data-next]', el)?.addEventListener('click', () => {
      state.step = 2;
      render({ focus: 'input[name="recipientType"]' });
    });
    const form = $('[data-release-form]', el);
    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        submit(form);
      });
      form.addEventListener('input', () => {
        readForm(form);
        $('[data-count]', form).textContent = `${form.elements.reason.value.length}/500`;
      });
      $('[data-back]', form).addEventListener('click', () => {
        readForm(form);
        state.step = 1;
        render({ focus: '[data-next]' });
      });
    }
  }

  render();
  // 1단계는 연결 상태에 따라 안내와 버튼이 달라진다. 입력 중인 2단계는 건드리지 않는다.
  return onNetChange(() => {
    if (state.step === 1 && ctx.isCurrent()) render();
  });
}
