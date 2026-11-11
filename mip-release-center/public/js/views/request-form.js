// Writing a request: content, documents, recipients, and a live preview of the
// approval route the policy will choose.
import { h, mount, debounce, icon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { t, tl, fmtBytes } from '../lib/i18n.js';
import { state } from '../lib/state.js';
import { pageHeader, field, check, toast, errorText, showFieldErrors, clearFieldErrors, fieldMessage, person, confirmDialog } from '../lib/ui.js';

const MAX_HASH_BYTES = 512 * 1024 * 1024;

const emptyDocument = () => ({ name: '', location: '', labelId: '', sizeBytes: null, sha256: '', note: '' });
const emptyRecipient = () => ({ organization: '', name: '', email: '' });

async function sha256Of(file) {
  if (!globalThis.crypto?.subtle || file.size > MAX_HASH_BYTES) return '';
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function requestFormView({ params, navigate }) {
  const policy = state.policy;
  const rules = policy.rules;
  const model = { id: null, version: null, status: 'draft', statusReason: '', title: '', action: '', targetLabelId: '', reasonId: '', justification: '', external: false, dueDate: '', documents: [emptyDocument()], recipients: [] };
  let acknowledged = false;

  if (params.id) {
    const { request, viewer } = await api.get(`/api/requests/${params.id}`);
    if (!viewer.canEdit) {
      navigate(`/requests/${params.id}`);
      return h('div');
    }
    Object.assign(model, {
      id: request.id, version: request.version, status: request.status, statusReason: request.statusReason,
      title: request.title, action: request.action, targetLabelId: request.targetLabelId ?? '', reasonId: request.reasonId ?? '',
      justification: request.justification, external: request.external, dueDate: request.dueDate ?? '',
      documents: request.documents.map((d) => ({ name: d.name, location: d.location, labelId: d.labelId ?? '', sizeBytes: d.sizeBytes, sha256: d.sha256 ?? '', note: d.note })),
      recipients: request.recipients.map((r) => ({ ...r })),
    });
    if (!model.documents.length) model.documents.push(emptyDocument());
  }

  const actions = policy.actions.filter((a) => a.enabled || a.id === model.action);
  const reasons = policy.reasons.filter((r) => r.enabled || r.id === model.reasonId);
  const actionOf = () => policy.actions.find((a) => a.id === model.action) ?? null;
  const reasonOf = () => policy.reasons.find((r) => r.id === model.reasonId) ?? null;
  const forcedExternal = () => Boolean(reasonOf()?.external || actionOf()?.requiresRecipients);
  const isExternal = () => model.external || forcedExternal();

  const formHost = h('div.stack');
  const previewHost = h('aside.card.route-preview');
  const summary = h('div.error-summary', { hidden: true, role: 'alert' });

  /** What the server stores: trimmed, with empty rows dropped. */
  const payload = () => ({
    id: model.id,
    version: model.version,
    title: model.title,
    action: model.action,
    targetLabelId: model.targetLabelId || null,
    reasonId: model.reasonId || null,
    justification: model.justification,
    external: isExternal(),
    dueDate: model.dueDate || null,
    documents: model.documents.filter((d) => d.name.trim() || d.location.trim() || d.labelId).map((d) => ({ ...d, labelId: d.labelId || null, sha256: d.sha256.trim() || null })),
    recipients: isExternal() ? model.recipients.filter((r) => r.organization.trim() || r.name.trim() || r.email.trim()) : [],
  });

  // ----- approval route preview -------------------------------------------

  let previewSeq = 0;
  const refreshPreview = debounce(async () => {
    const seq = (previewSeq += 1);
    let data;
    try {
      data = await api.post('/api/requests/preview', payload());
    } catch {
      return;
    }
    if (seq !== previewSeq) return;
    const body = [];
    if (!data.ready) body.push(h('p.muted', t('form.previewNeed')));
    else if (data.error && !data.route) body.push(h('p.field-error', t(`error.${data.error.code}`)));
    else {
      body.push(h('p.small', h('span.muted', t('form.route') + ' '), h('strong', tl(data.route.name))));
      if (data.error) body.push(h('p.field-error', t(`error.${data.error.code}`, { ...data.error.details, stageName: tl(data.error.details?.stageName) })));
      if (data.stages) {
        body.push(h('ol.stages.compact', data.stages.map((stage) => h('li.stage', { class: stage.skipped ? 'skipped' : '' },
          h('div.stage-head', h('strong', tl(stage.name)), stage.slaHours && !stage.skipped && h('span.muted.small', t('form.sla', { n: stage.slaHours }))),
          stage.skipped
            ? h('div.muted.small', t('stage.note.no_approver_skipped'))
            : h('div.small', stage.assignees.map((u, i) => [i > 0 && ', ', person(u)]),
              stage.minApprovals > 1 && h('span.muted', ' ' + t('form.minApprovals', { n: stage.minApprovals })),
              stage.note && h('div.muted', t(`stage.note.${stage.note}`)))))));
        body.push(h('p.muted.small', t('form.thenExecute')));
      }
      if (data.cc?.length) body.push(h('p.small', h('span.muted', t('form.cc') + ' '), data.cc.map((u) => u.name).join(', ')));
    }
    for (const warning of data.warnings ?? []) {
      body.push(h('p.warn-text.small', t('form.duplicateWarning', { n: warning.index + 1, number: warning.number })));
    }
    mount(previewHost, h('h2', t('form.previewTitle')), body);
  }, 450);

  // ----- form --------------------------------------------------------------

  const bind = (object, key, attrs = {}) => ({
    value: object[key] ?? '',
    onInput: (e) => {
      object[key] = e.target.value;
      refreshPreview();
    },
    ...attrs,
  });

  function documentRow(doc, index) {
    const f = `documents[${index}]`;
    return h('div.doc-row',
      h('div.doc-grid',
        field(t('doc.name'), h('input', bind(doc, 'name', { maxlength: 255, dataset: { field: `${f}.name` }, placeholder: t('doc.namePh') })), { required: true }),
        field(t('doc.label'), h('select', { dataset: { field: `${f}.labelId` }, onChange: (e) => {
          doc.labelId = e.target.value;
          refreshPreview();
        } }, h('option', { value: '' }, t('common.choose')),
          policy.labels.map((l) => h('option', { value: l.id, selected: doc.labelId === l.id, disabled: !l.releasable }, tl(l.name) + (l.releasable ? '' : ` (${t('doc.notReleasable')})`)))), { required: true }),
        field(t('doc.location'), h('input', bind(doc, 'location', { maxlength: 1000, dataset: { field: `${f}.location` }, placeholder: t('doc.locationPh') })), { required: rules.requireLocation }),
        field(t('doc.sha256'), h('input.mono', bind(doc, 'sha256', { maxlength: 64, dataset: { field: `${f}.sha256` }, placeholder: t('doc.sha256Ph'), spellcheck: 'false' })), { required: rules.requireHash }),
        field(t('doc.note'), h('input', bind(doc, 'note', { maxlength: 500, dataset: { field: `${f}.note` } }))),
      ),
      h('div.doc-side',
        doc.sizeBytes !== null && h('span.muted.small', fmtBytes(doc.sizeBytes)),
        h('button.icon-btn', { type: 'button', 'aria-label': t('common.remove'), title: t('common.remove'), onClick: () => {
          model.documents.splice(index, 1);
          if (!model.documents.length) model.documents.push(emptyDocument());
          render();
        } }, icon('trash'))),
      h('span', { dataset: { field: f } }));
  }

  function recipientRow(rec, index) {
    const f = `recipients[${index}]`;
    return h('div.rec-row',
      field(t('rec.organization'), h('input', bind(rec, 'organization', { maxlength: 120, dataset: { field: `${f}.organization` } })), { required: true }),
      field(t('rec.name'), h('input', bind(rec, 'name', { maxlength: 80, dataset: { field: `${f}.name` } }))),
      field(t('rec.email'), h('input', bind(rec, 'email', { type: 'email', maxlength: 254, dataset: { field: `${f}.email` } })), { required: Boolean(actionOf()?.requiresRecipientEmail) }),
      h('button.icon-btn', { type: 'button', 'aria-label': t('common.remove'), onClick: () => {
        model.recipients.splice(index, 1);
        render();
      } }, icon('trash')));
  }

  async function addFiles(files, status) {
    const room = rules.maxDocumentsPerRequest - model.documents.filter((d) => d.name).length;
    const list = [...files].slice(0, Math.max(0, room));
    if (list.length < files.length) toast(t('field.too_many', { max: rules.maxDocumentsPerRequest }), 'error');
    model.documents = model.documents.filter((d) => d.name || d.location || d.labelId);
    for (const [i, file] of list.entries()) {
      status.textContent = t('doc.hashing', { name: file.name, i: i + 1, n: list.length });
      let sha256 = '';
      try {
        sha256 = await sha256Of(file);
      } catch {
        // the hash stays empty and can be typed in by hand
      }
      model.documents.push({ ...emptyDocument(), name: file.name, sizeBytes: file.size, sha256 });
    }
    render();
    refreshPreview();
  }

  function render() {
    const action = actionOf();
    const external = isExternal();
    if (external && !model.recipients.length) model.recipients.push(emptyRecipient());
    const fileStatus = h('span.muted.small');
    const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onChange: (e) => addFiles(e.target.files, fileStatus) });
    const count = h('span.muted.small');
    const justification = h('textarea', bind(model, 'justification', { rows: 5, maxlength: 4000, dataset: { field: 'justification' }, placeholder: t('form.justificationPh') }));
    const updateCount = () => {
      const n = justification.value.trim().length;
      count.textContent = n < rules.minJustificationLength ? t('form.justificationMin', { n, min: rules.minJustificationLength }) : t('form.chars', { n });
    };
    justification.addEventListener('input', updateCount);
    updateCount();

    mount(formHost,
      model.status === 'returned' && h('div.callout.warn', h('strong', t('form.returnedTitle')), h('p', model.statusReason)),
      tl(policy.notice) && h('p.notice', tl(policy.notice)),
      summary,

      h('section.card.stack',
        h('h2', t('form.sectionWhat')),
        field(t('request.title'), h('input', bind(model, 'title', { maxlength: 120, dataset: { field: 'title' }, placeholder: t('form.titlePh') })), { required: true }),
        h('fieldset.field', h('legend.field-label', t('request.action'), h('span.req', ' *')),
          h('div.choice-cards', { dataset: { field: 'action' } }, actions.map((a) => h('label.choice', { class: model.action === a.id ? 'selected' : '' },
            h('input', { type: 'radio', name: 'action', value: a.id, checked: model.action === a.id, onChange: () => {
              model.action = a.id;
              render();
              refreshPreview();
            } }),
            h('span', h('strong', tl(a.name)), h('span.muted.small', tl(a.description))))))),
        action?.requiresTargetLabel && field(t('request.targetLabel'), h('select', { dataset: { field: 'targetLabelId' }, onChange: (e) => {
          model.targetLabelId = e.target.value;
          refreshPreview();
        } }, h('option', { value: '' }, t('common.choose')),
          policy.labels.filter((l) => l.releasable).map((l) => h('option', { value: l.id, selected: model.targetLabelId === l.id }, tl(l.name)))),
        { required: true, hint: action.targetMustBeLower ? t('form.targetLowerHint') : undefined })),

      h('section.card.stack',
        h('div.spread', h('h2', t('form.sectionDocuments')),
          h('div.row', fileStatus,
            h('button.btn.small', { type: 'button', onClick: () => fileInput.click() }, t('doc.pickFiles')),
            h('button.btn.small.ghost', { type: 'button', onClick: () => {
              model.documents.push(emptyDocument());
              render();
            } }, icon('plus'), t('doc.addRow')))),
        h('p.muted.small', t('doc.pickHint')),
        fileInput,
        h('div.stack', { dataset: { field: 'documents' } }, model.documents.map(documentRow))),

      h('section.card.stack',
        h('h2', t('form.sectionWhy')),
        h('div.form-grid',
          field(t('request.reason'), h('select', { dataset: { field: 'reasonId' }, onChange: (e) => {
            model.reasonId = e.target.value;
            render();
            refreshPreview();
          } }, h('option', { value: '' }, t('common.choose')), reasons.map((r) => h('option', { value: r.id, selected: model.reasonId === r.id }, tl(r.name)))), { required: true }),
          field(t('request.dueDate'), h('input', bind(model, 'dueDate', { type: 'date', dataset: { field: 'dueDate' } })), { hint: t('form.dueHint') })),
        h('label.field', h('span.field-label', t('request.justification'), h('span.req', ' *')), justification, count),
        check(t('form.external'), { checked: external, disabled: forcedExternal(), onChange: (e) => {
          model.external = e.target.checked;
          render();
          refreshPreview();
        } }),
        forcedExternal() && h('p.muted.small', t('form.externalForced')),
        external && h('div.stack', { dataset: { field: 'recipients' } },
          h('div.spread', h('h3', t('form.recipients')),
            h('button.btn.small.ghost', { type: 'button', onClick: () => {
              model.recipients.push(emptyRecipient());
              render();
            } }, icon('plus'), t('rec.add'))),
          model.recipients.map(recipientRow))),

      rules.requireAcknowledgement && h('section.card',
        h('div', { dataset: { field: 'acknowledged' } }, check(tl(policy.acknowledgement) || t('form.ackDefault'), { checked: acknowledged, onChange: (e) => {
          acknowledged = e.target.checked;
        } }))),
    );
  }

  // ----- saving ------------------------------------------------------------

  function showErrors(err) {
    if (err.code !== 'validation_failed') {
      toast(errorText(err), 'error');
      return;
    }
    const rest = showFieldErrors(formHost, err.details);
    summary.hidden = false;
    mount(summary, h('strong', t('form.fixErrors', { n: err.details.length })),
      rest.length > 0 && h('ul', rest.map((d) => h('li', `${d.field}: ${fieldMessage(d)}`))));
  }

  async function save() {
    const body = payload();
    const { request } = model.id ? await api.put(`/api/requests/${model.id}`, body) : await api.post('/api/requests', body);
    const created = !model.id;
    model.id = request.id;
    model.version = request.version;
    if (created) history.replaceState(null, '', `#/requests/${request.id}/edit`);
    return request;
  }

  const run = async (button, fn) => {
    if (button.disabled) return;
    button.disabled = true;
    clearFieldErrors(formHost);
    summary.hidden = true;
    try {
      await fn();
    } catch (err) {
      showErrors(err);
    } finally {
      button.disabled = false;
    }
  };

  const saveButton = h('button.btn', { type: 'button', onClick: () => run(saveButton, async () => {
    await save();
    toast(t('form.saved'));
  }) }, t('form.saveDraft'));
  const submitButton = h('button.btn.primary', { type: 'button', onClick: () => run(submitButton, async () => {
    await save();
    await api.post(`/api/requests/${model.id}/submit`, { acknowledged, version: model.version });
    toast(t('form.submitted'), 'ok');
    navigate(`/requests/${model.id}`);
  }) }, model.status === 'returned' ? t('form.resubmit') : t('form.submit'));
  const deleteButton = model.id && model.status === 'draft' && h('button.btn.ghost.danger-text', { type: 'button', onClick: async () => {
    if (!(await confirmDialog({ title: t('form.deleteTitle'), message: t('form.deleteMessage'), danger: true, confirmLabel: t('common.delete') }))) return;
    try {
      await api.del(`/api/requests/${model.id}`);
      navigate('/requests');
    } catch (err) {
      toast(errorText(err), 'error');
    }
  } }, t('common.delete'));

  render();
  refreshPreview();
  return h('div.stack',
    pageHeader(model.id ? t('form.editTitle') : t('request.new'), t('form.sub')),
    h('div.form-layout',
      h('div.stack', formHost, h('div.row.end.form-actions', deleteButton, h('a.btn.ghost', { href: model.id ? `#/requests/${model.id}` : '#/requests' }, t('common.cancel')), saveButton, submitButton)),
      previewHost));
}
