// One request: content, approval route, decision, execution, discussion, history.
import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { t, tl, fmtDateTime, fmtDate, fmtBytes } from '../lib/i18n.js';
import { state, actionName, reasonName } from '../lib/state.js';
import {
  pageHeader, statusBadge, execBadge, labelChip, person, kv, due, copyButton, timeline, toast, errorText, busy,
  confirmDialog, openDialog, userPicker, showFieldErrors,
} from '../lib/ui.js';

export async function requestDetailView({ params, navigate, refreshBadges }) {
  const host = h('div.stack');
  let data = await api.get(`/api/requests/${params.id}`);

  /** Apply a server response (the updated request) and redraw. */
  const update = (next) => {
    if (next) data = next;
    draw();
    refreshBadges();
  };
  const act = (button, fn, done) => busy(button, async () => {
    const next = await fn();
    if (done) toast(done, 'ok');
    update(next);
  });

  // ----- header actions ----------------------------------------------------

  function headerActions(r, v) {
    const clone = h('button.btn.ghost', { type: 'button', onClick: () => busy(clone, async () => {
      const { request } = await api.post(`/api/requests/${r.id}/clone`);
      navigate(`/requests/${request.id}/edit`);
    }) }, t('detail.clone'));
    const cancel = h('button.btn.ghost.danger-text', { type: 'button', onClick: async () => {
      const reason = await confirmDialog({
        title: t('detail.cancelTitle'), message: t('detail.cancelMessage'), danger: true, confirmLabel: t('detail.cancel'),
        input: { label: t('detail.cancelReason'), required: !v.isRequester, minLength: v.isRequester ? 0 : 5, maxLength: 500 },
      });
      if (reason === undefined) return;
      act(cancel, () => api.post(`/api/requests/${r.id}/cancel`, { reason }), t('detail.cancelled'));
    } }, t('detail.cancel'));
    const remove = h('button.btn.ghost.danger-text', { type: 'button', onClick: async () => {
      if (!(await confirmDialog({ title: t('form.deleteTitle'), message: t('form.deleteMessage'), danger: true, confirmLabel: t('common.delete') }))) return;
      busy(remove, async () => {
        await api.del(`/api/requests/${r.id}`);
        navigate('/requests');
      });
    } }, t('common.delete'));
    return [
      v.canDelete && remove,
      v.canCancel && cancel,
      v.canClone && clone,
      v.canEdit && h('a.btn.primary', { href: `#/requests/${r.id}/edit` }, r.status === 'returned' ? t('detail.editResubmit') : t('common.edit')),
    ];
  }

  // ----- approval route ----------------------------------------------------

  function reassignDialog(r, stage) {
    return openDialog({ title: t('detail.reassignTitle', { stage: tl(stage.name) }) }, (close) => {
      const picker = userPicker({ multiple: true, exclude: [r.requester.id] });
      const reason = h('textarea', { rows: 2, maxlength: 500, dataset: { field: 'reason' } });
      const button = h('button.btn.primary', { type: 'submit' }, t('detail.reassign'));
      const form = h('form.stack', { onSubmit: async (event) => {
        event.preventDefault();
        button.disabled = true;
        try {
          close(await api.post(`/api/requests/${r.id}/stages/${stage.id}/reassign`, { userIds: picker.getValue().map((u) => u.id), reason: reason.value }));
        } catch (err) {
          if (showFieldErrors(form, err.details).length || !Array.isArray(err.details)) toast(errorText(err), 'error');
        } finally {
          button.disabled = false;
        }
      } },
      h('p.muted', t('detail.reassignHint', { n: stage.minApprovals })),
      h('div.field', h('span.field-label', t('detail.newApprovers')), h('div', { dataset: { field: 'userIds' } }, picker)),
      h('label.field', h('span.field-label', t('detail.reassignReason')), reason),
      h('div.row.end', h('button.btn.ghost', { type: 'button', onClick: () => close(undefined) }, t('common.cancel')), button));
      return form;
    });
  }

  function stageList(r, v, stages) {
    return h('ol.stages', stages.map((stage) => {
      const open = stage.status === 'active' || stage.status === 'waiting';
      const reassign = v.canReassign && open && stage.revision === r.revision && h('button.btn.small.ghost', { type: 'button', onClick: async () => {
        const next = await reassignDialog(r, stage);
        if (next) {
          toast(t('detail.reassigned'), 'ok');
          update(next);
        }
      } }, t('detail.reassign'));
      return h('li.stage', { class: stage.status },
        h('div.stage-head',
          h('strong', tl(stage.name)),
          h(`span.badge.st-${stage.status}`, t(`stage.${stage.status}`)),
          stage.status === 'active' && due(stage.dueAt, stage.overdue),
          stage.minApprovals > 1 && h('span.muted.small', t('form.minApprovals', { n: stage.minApprovals })),
          h('span.grow'), reassign),
        stage.status !== 'skipped' && h('div.small', h('span.muted', t('detail.approvers') + ' '),
          stage.assignees.map((u, i) => [i > 0 && ', ', person(u, { withTitle: true }),
            u.delegates?.length > 0 && h('span.muted', ` (${t('detail.delegate', { name: u.delegates.map((d) => d.name).join(', ') })})`)])),
        stage.note && h('div.muted.small', t(`stage.note.${stage.note}`)),
        stage.decisions.map((d) => h('div.decision', { class: d.decision },
          h('div.small', h('strong', t(`decision.${d.decision}`)), ' · ', person(d.approver),
            d.onBehalfOf && h('span.muted', ` (${t('audit.onBehalfOf', { name: d.onBehalfOf.name })})`),
            h('span.muted', ` · ${fmtDateTime(d.createdAt)}`)),
          d.comment && h('p.quote', d.comment))));
    }));
  }

  function decisionPanel(r, v) {
    if (!v.canDecide) return null;
    const comment = h('textarea', { rows: 3, maxlength: 2000, placeholder: t('detail.commentPh'), dataset: { field: 'comment' } });
    const actingFor = v.decideSeats.filter((u) => u.id !== state.user.id);
    const ownSeat = v.decideSeats.some((u) => u.id === state.user.id);
    const panel = h('section.card.decide.stack');
    const decide = (decision) => async (event) => {
      const button = event.currentTarget;
      if (decision !== 'approve' && !comment.value.trim()) {
        showFieldErrors(panel, [{ field: 'comment', code: 'comment_required' }]);
        return;
      }
      if (decision === 'reject' && !(await confirmDialog({ title: t('detail.rejectTitle'), message: t('detail.rejectMessage'), danger: true, confirmLabel: t('decision.reject') }))) return;
      button.disabled = true;
      try {
        const next = await api.post(`/api/requests/${r.id}/decisions`, { decision, comment: comment.value });
        toast(t(`detail.decided.${decision}`), 'ok');
        update(next);
      } catch (err) {
        if (showFieldErrors(panel, err.details).length || !Array.isArray(err.details)) toast(errorText(err), 'error');
        button.disabled = false;
      }
    };
    mount(panel,
      h('h2', t('detail.decideTitle')),
      !ownSeat && actingFor.length > 0 && h('p.callout', t('approval.actingFor', { name: actingFor.map((u) => u.name).join(', ') })),
      h('p.muted.small', t('detail.decideHint')),
      h('label.field', h('span.field-label', t('detail.comment')), comment),
      h('div.row.end',
        h('button.btn.danger', { type: 'button', onClick: decide('reject') }, t('decision.reject')),
        h('button.btn', { type: 'button', onClick: decide('return') }, t('decision.return')),
        h('button.btn.primary', { type: 'button', onClick: decide('approve') }, t('decision.approve'))));
    return panel;
  }

  // ----- execution ---------------------------------------------------------

  function documentRecorder(r, exec, doc) {
    const note = h('input', { value: doc.execNote, maxlength: 500, placeholder: t('exec.notePh'), 'aria-label': t('exec.note'), dataset: { field: 'note' } });
    const verified = doc.sha256 ? h('input', { type: 'checkbox', checked: doc.execHashVerified === true, dataset: { field: 'hashVerified' } }) : null;
    const row = h('div.exec-doc');
    const record = (status) => async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const next = await api.post(`/api/executions/${exec.id}/documents/${doc.id}`, { status, note: note.value, hashVerified: verified ? verified.checked : undefined });
        update(next);
      } catch (err) {
        if (showFieldErrors(row, err.details).length || !Array.isArray(err.details)) toast(errorText(err), 'error');
        button.disabled = false;
      }
    };
    mount(row,
      h('div.exec-doc-head', h('strong', doc.name), labelChip(doc.labelId, r.names), h(`span.badge.d-${doc.execStatus}`, t(`docExec.${doc.execStatus}`))),
      doc.location && h('div.mono.small.wrap', doc.location),
      doc.sha256 && h('div.row.small', h('span.muted', 'SHA-256'), h('code.wrap', doc.sha256), copyButton(doc.sha256)),
      h('div.row',
        verified && h('label.check', verified, h('span', t('exec.hashVerified'))),
        h('div.grow', note),
        h('button.btn.small.primary', { type: 'button', onClick: record('done') }, t('docExec.done')),
        h('button.btn.small', { type: 'button', onClick: record('failed') }, t('docExec.failed')),
        h('button.btn.small', { type: 'button', onClick: record('skipped') }, t('docExec.skipped')),
        doc.execStatus !== 'pending' && h('button.btn.small.ghost', { type: 'button', onClick: record('pending') }, t('exec.undo'))));
    return row;
  }

  function executionPanel(r, v) {
    const ex = v.execution;
    if (!ex || !(ex.canClaim || ex.isMine || ex.canRetry)) return null;
    const panel = h('section.card.stack.execute', h('h2', t('exec.panelTitle')), h('p.notice', t('exec.manualNotice')));
    if (ex.canClaim) {
      const claim = h('button.btn.primary', { type: 'button', onClick: () => act(claim, () => api.post(`/api/executions/${ex.id}/claim`), t('exec.claimed.toast')) },
        ex.status === 'queued' ? t('exec.claim') : t('exec.takeOver'));
      panel.append(h('div.row', claim, ex.status !== 'queued' && h('span.muted.small', t('exec.takeOverHint'))));
    }
    if (ex.isMine) {
      const pending = r.documents.filter((d) => d.execStatus === 'pending').length;
      const message = h('input', { maxlength: 1000, placeholder: t('exec.messagePh'), 'aria-label': t('exec.message') });
      const complete = h('button.btn.primary', { type: 'button', disabled: pending > 0, onClick: () => act(complete, () => api.post(`/api/executions/${ex.id}/complete`, { message: message.value }), t('exec.completed.toast')) }, t('exec.complete'));
      const release = h('button.btn.ghost', { type: 'button', onClick: () => act(release, () => api.post(`/api/executions/${ex.id}/release`), t('exec.released.toast')) }, t('exec.release'));
      panel.append(
        h('div.stack', r.documents.map((doc) => documentRecorder(r, ex, doc))),
        h('div.row', h('div.grow', message), release, complete),
        pending > 0 && h('p.muted.small', t('exec.pendingLeft', { n: pending })));
    }
    if (ex.canRetry) {
      const retry = h('button.btn', { type: 'button', onClick: () => act(retry, () => api.post(`/api/executions/${ex.id}/retry`), t('exec.retried.toast')) }, t('exec.retry'));
      panel.append(h('div.row', retry, h('span.muted.small', t('exec.retryHint'))));
    }
    return panel;
  }

  // ----- page --------------------------------------------------------------

  function draw() {
    const { request: r, viewer: v } = data;
    const comment = h('textarea', { rows: 2, maxlength: 2000, placeholder: t('detail.addCommentPh'), 'aria-label': t('detail.addComment') });
    const send = h('button.btn', { type: 'button', onClick: () => {
      if (!comment.value.trim()) return;
      act(send, () => api.post(`/api/requests/${r.id}/comments`, { body: comment.value }));
    } }, t('detail.addComment'));

    mount(host,
      pageHeader(r.title || t('request.untitled'),
        h('span', h('span.mono', r.number ?? t('request.noNumber')), ' ', statusBadge(r.status), r.revision > 1 && h('span.muted', ` · ${t('detail.revision', { n: r.revision })}`)),
        headerActions(r, v)),

      r.statusReason && ['returned', 'rejected', 'cancelled', 'expired'].includes(r.status) && h('div.callout', { class: r.status === 'returned' ? 'warn' : '' },
        h('strong', t(`detail.reason.${r.status}`)), h('p', ['no_activity', 'approval_validity'].includes(r.statusReason) ? t(`detail.expired.${r.statusReason}`) : r.statusReason)),
      r.status === 'approved' && r.approvalValidUntil && h('div.callout', t('detail.validUntil', { when: fmtDateTime(r.approvalValidUntil) })),

      decisionPanel(r, v),
      executionPanel(r, v),

      h('section.card.stack',
        h('h2', t('detail.summary')),
        kv([
          [t('request.requester'), person(r.requester, { withTitle: true })],
          [t('request.action'), actionName(r.action, r.names)],
          r.targetLabelId && [t('request.targetLabel'), labelChip(r.targetLabelId, r.names)],
          [t('request.reason'), reasonName(r.reasonId, r.names)],
          [t('request.external'), r.external ? t('common.yes') : t('common.no')],
          r.dueDate && [t('request.dueDate'), fmtDate(r.dueDate)],
          r.submittedAt && [t('request.submitted'), fmtDateTime(r.submittedAt)],
          r.decidedAt && [t('request.decided'), fmtDateTime(r.decidedAt)],
          r.completedAt && [t('request.completed'), fmtDateTime(r.completedAt)],
          r.policyVersion && [t('detail.policyVersion'), `v${r.policyVersion}`],
        ]),
        h('div', h('h3', t('request.justification')), h('p.pre', r.justification || '–')),
        r.recipients.length > 0 && h('div', h('h3', t('form.recipients')),
          h('ul.plain', r.recipients.map((rec) => h('li', h('strong', rec.organization), [rec.name, rec.email].filter(Boolean).map((x) => ` · ${x}`)))))),

      h('section.card.stack',
        h('h2', t('detail.documents', { n: r.documents.length })),
        h('div.table-wrap', h('table.table',
          h('thead', h('tr', h('th', t('doc.name')), h('th', t('doc.label')), h('th', t('doc.size')), h('th', 'SHA-256'), h('th', t('detail.result')))),
          h('tbody', r.documents.map((d) => h('tr',
            h('td', h('strong', d.name), d.location && h('div.mono.small.muted.wrap', d.location), d.note && h('div.small', d.note)),
            h('td', labelChip(d.labelId, r.names)),
            h('td.muted', fmtBytes(d.sizeBytes) || '–'),
            h('td', d.sha256 ? h('span.row.nowrap', h('code', { title: d.sha256 }, d.sha256.slice(0, 12) + '…'), copyButton(d.sha256)) : h('span.muted', '–')),
            h('td', h(`span.badge.d-${d.execStatus}`, t(`docExec.${d.execStatus}`)),
              d.execHashVerified === true && h('span.muted.small', ' ' + t('exec.hashOk')),
              d.execHashVerified === false && h('span.overdue.small', ' ' + t('exec.hashBad')),
              d.execNote && h('div.small.muted', d.execNote)))))))),

      r.stages.length > 0 && h('section.card.stack',
        h('h2', t('detail.route')),
        stageList(r, v, r.stages),
        r.cc.length > 0 && h('p.small', h('span.muted', t('form.cc') + ' '), r.cc.map((u) => u.name).join(', ')),
        r.previousStages.length > 0 && h('details', h('summary', t('detail.previousRounds')), stageList(r, v, r.previousStages))),

      r.executions.length > 0 && h('section.card.stack',
        h('h2', t('detail.executions')),
        h('div.table-wrap', h('table.table',
          h('thead', h('tr', h('th', '#'), h('th', t('exec.mode')), h('th', t('request.status')), h('th', t('exec.operator')), h('th', t('exec.finished')), h('th', t('exec.message')))),
          h('tbody', r.executions.map((e) => h('tr',
            h('td', e.attempt), h('td', t(`exec.mode.${e.mode}`)), h('td', execBadge(e.status)),
            h('td', e.operator ? person(e.operator) : h('span.muted', e.mode === 'manual' ? '–' : t('audit.system'))),
            h('td.muted', fmtDateTime(e.finishedAt) || '–'),
            h('td.small', [e.externalRef, e.message].filter(Boolean).join(' · ') || '–'))))))),

      r.status !== 'draft' && h('section.card.stack',
        h('h2', t('detail.comments')),
        r.comments.length
          ? h('ul.comments', r.comments.map((c) => h('li', h('div.small', h('strong', c.author?.name), h('span.muted', ` · ${fmtDateTime(c.createdAt)}`)), h('p.pre', c.body))))
          : h('p.muted.small', t('detail.noComments')),
        v.canComment && h('div.row.top', h('div.grow', comment), send)),

      h('section.card.stack', h('h2', t('detail.history')), timeline(r.timeline)));
  }

  draw();
  return host;
}

