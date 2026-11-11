// Policy editor: labels, request types, reasons, approval routes and rules.
// Edits happen on a local draft; nothing changes until it is saved as a new version.
import { h, mount, icon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { t, tl, has, fmtDateTime } from '../lib/i18n.js';
import { state } from '../lib/state.js';
import { pageHeader, tabs, toast, errorText, busy, confirmDialog, userPicker, person, check, field } from '../lib/ui.js';
import { reloadSession } from '../main.js';

const SECTIONS = ['routes', 'labels', 'actions', 'reasons', 'rules', 'texts', 'simulate', 'history', 'json'];
const APPROVER_ROLES = ['approver', 'security', 'auditor', 'admin', 'operator'];
const ACTION_FLAGS = ['requiresTargetLabel', 'targetMustBeLower', 'requiresRecipients', 'requiresRecipientEmail', 'requiresProtectedSource'];
const RULE_NUMBERS = [['approvalValidityDays', 1, 90], ['pendingExpiryDays', 1, 365], ['maxDocumentsPerRequest', 1, 200], ['minJustificationLength', 0, 1000], ['maxDelegationDays', 1, 365]];
const RULE_FLAGS = ['distinctApprovers', 'operatorMustDifferFromRequester', 'operatorMustDifferFromApprovers', 'requireAcknowledgement', 'requireLocation', 'requireHash', 'requireCommentOnApproval'];

const policyMessage = (e) => (has(`policyError.${e.code}`) ? t(`policyError.${e.code}`, e.params) : has(`field.${e.code}`) ? t(`field.${e.code}`, e.params) : e.code);

export async function policyView({ query }) {
  const [current, departments] = await Promise.all([api.get('/api/policy'), api.get('/api/directory/departments')]);
  let draft = structuredClone(current.policy);
  let baseline = JSON.stringify(current.policy);
  let errors = [];
  let section = SECTIONS.includes(query.section) ? query.section : 'routes';
  const fresh = new WeakSet(); // rows added in this session may still change their id
  const userCache = new Map();

  const body = h('div');
  const errorHost = h('div');
  const saveButton = h('button.btn.primary', { type: 'button' }, t('policy.save'));
  const resetButton = h('button.btn.ghost', { type: 'button' }, t('policy.reset'));
  const dirty = () => JSON.stringify(draft) !== baseline;
  const touched = () => {
    saveButton.disabled = !dirty();
    resetButton.disabled = !dirty();
  };

  // ----- input helpers -----------------------------------------------------

  const text = (obj, key, attrs = {}) => h('input', { value: obj[key] ?? '', onInput: (e) => {
    obj[key] = e.target.value;
    touched();
  }, ...attrs });
  const localized = (obj, key, { multiline = false, max = 80 } = {}) => {
    obj[key] ??= {};
    const make = (locale) => h(multiline ? 'textarea' : 'input', { value: obj[key][locale] ?? '', maxlength: max, rows: 3, placeholder: locale.toUpperCase(), 'aria-label': locale, onInput: (e) => {
      if (e.target.value.trim()) obj[key][locale] = e.target.value;
      else delete obj[key][locale];
      touched();
    } });
    return h('div.pair', { class: multiline ? 'tall' : '' }, make('ko'), make('en'));
  };
  const number = (obj, key, { min, max, nullable = false, removable = false } = {}) => h('input.num', { type: 'number', min, max, value: obj[key] ?? '', onInput: (e) => {
    if (e.target.value === '') {
      if (removable) delete obj[key];
      else obj[key] = nullable ? null : undefined;
    } else obj[key] = Number(e.target.value);
    touched();
  } });
  const flag = (obj, key, label) => check(label, { checked: Boolean(obj[key]), onChange: (e) => {
    obj[key] = e.target.checked;
    touched();
  } });
  /** Checkbox group stored as an array; an empty selection removes the key (meaning "any"). */
  const multi = (obj, key, options) => h('div.row.wrap', options.map(([value, label]) => check(label, { checked: Boolean(obj[key]?.includes(value)), onChange: (e) => {
    const set = new Set(obj[key] ?? []);
    if (e.target.checked) set.add(value);
    else set.delete(value);
    if (set.size) obj[key] = [...set];
    else delete obj[key];
    touched();
  } })));
  const removeButton = (list, index) => h('button.icon-btn', { type: 'button', 'aria-label': t('common.remove'), title: t('common.remove'), onClick: () => {
    list.splice(index, 1);
    draw();
  } }, icon('trash'));
  const moveButtons = (list, index, { lastFixed = false } = {}) => {
    const limit = list.length - (lastFixed ? 1 : 0);
    const move = (delta) => () => {
      const [item] = list.splice(index, 1);
      list.splice(index + delta, 0, item);
      draw();
    };
    return [
      h('button.icon-btn', { type: 'button', 'aria-label': t('policy.moveUp'), disabled: index === 0 || index >= limit, onClick: move(-1) }, icon('up')),
      h('button.icon-btn', { type: 'button', 'aria-label': t('policy.moveDown'), disabled: index >= limit - 1, onClick: move(1) }, icon('down')),
    ];
  };
  const idInput = (item) => text(item, 'id', { class: 'mono', maxlength: 40, readOnly: !fresh.has(item), title: fresh.has(item) ? '' : t('policy.idLocked'), spellcheck: 'false' });
  const addRow = (list, item, at = list.length) => {
    fresh.add(item);
    list.splice(at, 0, item);
    draw();
  };

  async function usersByIds(ids) {
    const missing = ids.filter((id) => !userCache.has(id));
    if (missing.length) {
      const { items } = await api.get('/api/directory/users', { ids: missing.join(',') });
      for (const user of items) userCache.set(user.id, user);
    }
    return ids.map((id) => userCache.get(id) ?? { id, name: id, departmentName: '' });
  }

  /** Editor for "who approves": line manager, department approver, a role, or named people. */
  function approverEditor(spec, { types = ['manager', 'department_approver', 'role', 'users'] } = {}) {
    const extra = h('span.row');
    const drawExtra = () => {
      if (spec.type === 'manager') mount(extra, h('label.inline-label', t('policy.managerLevel'), number(spec, 'level', { min: 1, max: 5 })));
      else if (spec.type === 'role') mount(extra, h('select', { onChange: (e) => {
        spec.role = e.target.value;
        touched();
      } }, APPROVER_ROLES.map((role) => h('option', { value: role, selected: spec.role === role }, t(`role.${role}`)))));
      else if (spec.type === 'users') {
        mount(extra, h('span.muted.small', t('common.loading')));
        usersByIds(spec.userIds ?? []).then((value) => {
          for (const user of value) userCache.set(user.id, user);
          mount(extra, userPicker({ multiple: true, value, onChange: (list) => {
            for (const user of list) userCache.set(user.id, user);
            spec.userIds = list.map((u) => u.id);
            touched();
          } }));
        });
      } else mount(extra);
    };
    drawExtra();
    return h('div.row.approver',
      h('select', { 'aria-label': t('policy.approverType'), onChange: (e) => {
        for (const key of Object.keys(spec)) delete spec[key];
        spec.type = e.target.value;
        if (spec.type === 'manager') spec.level = 1;
        if (spec.type === 'role') spec.role = 'security';
        if (spec.type === 'users') spec.userIds = [];
        touched();
        drawExtra();
      } }, types.map((type) => h('option', { value: type, selected: spec.type === type }, t(`policy.approver.${type}`)))),
      extra);
  }

  // ----- sections ----------------------------------------------------------

  const sections = {
    routes() {
      const labelOptions = draft.labels.map((l) => [l.id, tl(l.name) || l.id]);
      const actionOptions = draft.actions.map((a) => [a.id, tl(a.name) || a.id]);
      const reasonOptions = draft.reasons.map((r) => [r.id, tl(r.name) || r.id]);
      const departmentOptions = departments.items.map((d) => [d.id, d.name]);
      return h('div.stack',
        h('p.muted', t('policy.routesHint')),
        draft.routes.map((route, index) => {
          const last = index === draft.routes.length - 1;
          route.when ??= {};
          route.cc ??= [];
          return h('section.card.stack.route',
            h('div.row',
              h('span.badge', `${index + 1}`),
              h('label.inline-label', 'ID', idInput(route)),
              h('div.grow', localized(route, 'name')),
              moveButtons(draft.routes, index, { lastFixed: true }),
              !last && removeButton(draft.routes, index)),
            last
              ? h('p.muted.small', t('policy.catchAll'))
              : h('details.conditions', { open: true }, h('summary', t('policy.conditions')),
                h('div.form-grid',
                  h('div.field', h('span.field-label', t('policy.when.minLabelRank')), number(route.when, 'minLabelRank', { min: 0, max: 100, removable: true })),
                  h('div.field', h('span.field-label', t('policy.when.maxLabelRank')), number(route.when, 'maxLabelRank', { min: 0, max: 100, removable: true })),
                  h('div.field', h('span.field-label', t('policy.when.minDocuments')), number(route.when, 'minDocuments', { min: 1, max: 200, removable: true })),
                  h('div.field', h('span.field-label', t('policy.when.external')),
                    h('select', { onChange: (e) => {
                      if (e.target.value === '') delete route.when.external;
                      else route.when.external = e.target.value === 'true';
                      touched();
                    } }, [['', t('common.any')], ['true', t('common.yes')], ['false', t('common.no')]].map(([value, label]) =>
                      h('option', { value, selected: String(route.when.external ?? '') === value }, label))))),
                h('div.field', h('span.field-label', t('policy.when.actions')), multi(route.when, 'actions', actionOptions)),
                h('div.field', h('span.field-label', t('policy.when.labels')), multi(route.when, 'labels', labelOptions)),
                h('div.field', h('span.field-label', t('policy.when.reasons')), multi(route.when, 'reasons', reasonOptions)),
                departmentOptions.length > 0 && h('div.field', h('span.field-label', t('policy.when.departments')), multi(route.when, 'departments', departmentOptions))),
            h('h3', t('policy.stages')),
            h('ol.stage-edit', route.stages.map((stage, si) => h('li.stack',
              h('div.row',
                h('div.grow', localized(stage, 'name', { max: 40 })),
                moveButtons(route.stages, si),
                route.stages.length > 1 && removeButton(route.stages, si)),
              approverEditor(stage.approver),
              h('div.row.wrap',
                h('label.inline-label', t('policy.minApprovals'), number(stage, 'minApprovals', { min: 1, max: 5 })),
                h('label.inline-label', t('policy.slaHours'), number(stage, 'slaHours', { min: 1, max: 720, nullable: true })),
                flag(stage, 'optional', t('policy.optionalStage')))))),
            h('div.row',
              h('button.btn.small.ghost', { type: 'button', onClick: () => {
                route.stages.push({ name: { ko: '', en: '' }, approver: { type: 'manager', level: 1 }, minApprovals: 1, slaHours: 24, optional: false });
                draw();
              } }, icon('plus'), t('policy.addStage')),
              h('button.btn.small.ghost', { type: 'button', onClick: () => {
                route.cc.push({ type: 'role', role: 'security' });
                draw();
              } }, icon('plus'), t('policy.addCc'))),
            route.cc.length > 0 && h('div.stack', h('h3', t('form.cc')), route.cc.map((spec, ci) => h('div.row', approverEditor(spec), removeButton(route.cc, ci)))));
        }),
        h('button.btn', { type: 'button', onClick: () => addRow(draft.routes, {
          id: `route-${draft.routes.length + 1}`, name: { ko: '', en: '' }, when: {},
          stages: [{ name: { ko: '부서장', en: 'Manager' }, approver: { type: 'manager', level: 1 }, minApprovals: 1, slaHours: 24, optional: false }], cc: [],
        }, Math.max(0, draft.routes.length - 1)) }, icon('plus'), t('policy.addRoute')));
    },

    labels() {
      return h('div.stack',
        h('p.muted', t('policy.labelsHint')),
        h('div.table-wrap', h('table.table.edit',
          h('thead', h('tr', h('th', 'ID'), h('th', t('policy.name')), h('th', t('policy.rank')), h('th', t('policy.protected')), h('th', t('policy.releasable')), h('th', t('policy.color')), h('th', t('policy.externalId')), h('th', ''))),
          h('tbody', draft.labels.map((label, index) => h('tr',
            h('td', idInput(label)),
            h('td', localized(label, 'name', { max: 60 })),
            h('td', number(label, 'rank', { min: 0, max: 100 })),
            h('td', flag(label, 'protected', '')),
            h('td', flag(label, 'releasable', '')),
            h('td', h('input', { type: 'color', value: label.color || '#888888', 'aria-label': t('policy.color'), onInput: (e) => {
              label.color = e.target.value;
              touched();
            } })),
            h('td', text(label, 'externalId', { class: 'mono', maxlength: 100, placeholder: 'GUID', spellcheck: 'false' })),
            h('td', draft.labels.length > 1 && removeButton(draft.labels, index))))))),
        h('button.btn', { type: 'button', onClick: () => addRow(draft.labels, { id: `label-${draft.labels.length + 1}`, name: { ko: '', en: '' }, rank: 1, protected: true, releasable: true, color: '#888888', externalId: '' }) }, icon('plus'), t('policy.addLabel')));
    },

    actions() {
      return h('div.stack',
        h('p.muted', t('policy.actionsHint')),
        draft.actions.map((action, index) => h('section.card.stack',
          h('div.row', h('label.inline-label', 'ID', idInput(action)), h('div.grow', localized(action, 'name', { max: 60 })), flag(action, 'enabled', t('policy.enabled')), draft.actions.length > 1 && removeButton(draft.actions, index)),
          h('div.field', h('span.field-label', t('policy.description')), localized(action, 'description', { max: 300, multiline: true })),
          h('div.row.wrap', ACTION_FLAGS.map((key) => flag(action, key, t(`policy.flag.${key}`)))))),
        h('button.btn', { type: 'button', onClick: () => addRow(draft.actions, {
          id: `action-${draft.actions.length + 1}`, name: { ko: '', en: '' }, description: {}, enabled: true,
          requiresTargetLabel: false, targetMustBeLower: false, requiresRecipients: false, requiresRecipientEmail: false, requiresProtectedSource: false,
        }) }, icon('plus'), t('policy.addAction')));
    },

    reasons() {
      return h('div.stack',
        h('p.muted', t('policy.reasonsHint')),
        h('div.table-wrap', h('table.table.edit',
          h('thead', h('tr', h('th', 'ID'), h('th', t('policy.name')), h('th', t('policy.reasonExternal')), h('th', t('policy.enabled')), h('th', ''))),
          h('tbody', draft.reasons.map((reason, index) => h('tr',
            h('td', idInput(reason)), h('td', localized(reason, 'name', { max: 60 })), h('td', flag(reason, 'external', '')), h('td', flag(reason, 'enabled', '')),
            h('td', draft.reasons.length > 1 && removeButton(draft.reasons, index))))))),
        h('button.btn', { type: 'button', onClick: () => addRow(draft.reasons, { id: `reason-${draft.reasons.length + 1}`, name: { ko: '', en: '' }, external: false, enabled: true }) }, icon('plus'), t('policy.addReason')));
    },

    rules() {
      const rules = draft.rules;
      rules.locationPrefixes ??= [];
      const hasFallback = Boolean(draft.fallbackApprover);
      const modes = [['manual', true], ['webhook', state.app.executorWebhookConfigured], ['simulate', state.app.demo]];
      return h('div.stack',
        h('section.card.stack', h('h2', t('policy.rulesLimits')),
          h('div.form-grid', RULE_NUMBERS.map(([key, min, max]) => field(t(`policy.rule.${key}`), number(rules, key, { min, max }))))),
        h('section.card.stack', h('h2', t('policy.rulesControls')), RULE_FLAGS.map((key) => flag(rules, key, t(`policy.rule.${key}`)))),
        h('section.card.stack', h('h2', t('policy.rule.locationPrefixes')),
          h('p.muted.small', t('policy.locationHint')),
          h('textarea.mono', { rows: 4, value: rules.locationPrefixes.join('\n'), placeholder: 'https://contoso.sharepoint.com/\n\\\\fileserver\\', onInput: (e) => {
            rules.locationPrefixes = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
            touched();
          } })),
        h('section.card.stack', h('h2', t('policy.fallback')),
          h('p.muted.small', t('policy.fallbackHint')),
          check(t('policy.fallbackUse'), { checked: hasFallback, onChange: (e) => {
            draft.fallbackApprover = e.target.checked ? { type: 'role', role: 'security' } : null;
            draw();
          } }),
          hasFallback && approverEditor(draft.fallbackApprover, { types: ['role', 'users'] })),
        h('section.card.stack', h('h2', t('policy.executor')),
          h('p.muted.small', t('policy.executorHint')),
          modes.map(([mode, available]) => h('label.choice', { class: draft.executor.mode === mode ? 'selected' : '' },
            h('input', { type: 'radio', name: 'executor', checked: draft.executor.mode === mode, disabled: !available, onChange: () => {
              draft.executor.mode = mode;
              draw();
            } }),
            h('span', h('strong', t(`exec.mode.${mode}`)), h('span.muted.small', t(`policy.executor.${mode}`) + (available ? '' : ` ${t('policy.executorUnavailable')}`)))))));
    },

    texts() {
      draft.numbering ??= { prefix: 'REL' };
      return h('div.stack',
        h('section.card.stack', h('h2', t('policy.numbering')),
          field(t('policy.prefix'), text(draft.numbering, 'prefix', { class: 'mono', maxlength: 8 }), { hint: t('policy.prefixHint', { example: `${draft.numbering.prefix}-${new Date().getFullYear()}-00001` }) })),
        h('section.card.stack', h('h2', t('policy.notice')), h('p.muted.small', t('policy.noticeHint')), localized(draft, 'notice', { multiline: true, max: 1000 })),
        h('section.card.stack', h('h2', t('policy.ack')), h('p.muted.small', t('policy.ackHint')), localized(draft, 'acknowledgement', { multiline: true, max: 1000 })));
    },

    simulate() {
      const sample = { requesterId: state.user.id, action: draft.actions.find((a) => a.enabled)?.id ?? '', labelIds: [], external: false, reasonId: '' };
      const result = h('div');
      const run = h('button.btn.primary', { type: 'button', onClick: () => busy(run, async () => {
        const data = await api.post('/api/policy/simulate', { policy: draft, sample });
        mount(result, h('section.card.stack',
          data.route ? h('p', h('span.muted', t('form.route') + ' '), h('strong', tl(data.route.name) || data.route.id)) : h('p.field-error', t('error.no_route')),
          data.requester && h('p.small.muted', t('policy.simRequester'), ' ', person(data.requester, { withTitle: true })),
          data.error && h('p.field-error', t(`error.${data.error.code}`, { ...data.error.details, stageName: tl(data.error.details?.stageName) })),
          data.stages && h('ol.stages', data.stages.map((stage) => h('li.stage', { class: stage.skipped ? 'skipped' : '' },
            h('div.stage-head', h('strong', tl(stage.name)), stage.minApprovals > 1 && h('span.muted.small', t('form.minApprovals', { n: stage.minApprovals }))),
            stage.skipped ? h('div.muted.small', t('stage.note.no_approver_skipped')) : h('div.small', stage.assignees.map((u, i) => [i > 0 && ', ', person(u, { withTitle: true })])),
            stage.note && !stage.skipped && h('div.muted.small', t(`stage.note.${stage.note}`))))),
          data.cc?.length > 0 && h('p.small', h('span.muted', t('form.cc') + ' '), data.cc.map((u) => u.name).join(', '))));
      }) }, t('policy.simRun'));
      return h('div.stack',
        h('p.muted', t('policy.simHint')),
        h('section.card.stack',
          h('div.field', h('span.field-label', t('request.requester')), userPicker({ value: [{ id: state.user.id, name: state.user.name, departmentName: state.user.departmentName }], onChange: (user) => {
            sample.requesterId = user?.id ?? state.user.id;
          } })),
          h('div.form-grid',
            field(t('request.action'), h('select', { onChange: (e) => {
              sample.action = e.target.value;
            } }, draft.actions.map((a) => h('option', { value: a.id, selected: sample.action === a.id }, tl(a.name) || a.id)))),
            field(t('request.reason'), h('select', { onChange: (e) => {
              sample.reasonId = e.target.value;
            } }, h('option', { value: '' }, t('common.any')), draft.reasons.map((r) => h('option', { value: r.id }, tl(r.name) || r.id))))),
          h('div.field', h('span.field-label', t('policy.simLabels')), multi(sample, 'labelIds', draft.labels.map((l) => [l.id, tl(l.name) || l.id]))),
          check(t('form.external'), { onChange: (e) => {
            sample.external = e.target.checked;
          } }),
          h('div.row', run)),
        result);
    },

    history() {
      const host = h('div.card', h('p.muted', t('common.loading')));
      api.get('/api/policy/versions').then(({ items }) => {
        mount(host, h('div.table-wrap', h('table.table',
          h('thead', h('tr', h('th', t('policy.version')), h('th', t('policy.savedAt')), h('th', t('policy.savedBy')), h('th', t('policy.note')), h('th', ''))),
          h('tbody', items.map((v) => h('tr',
            h('td', `v${v.version}`, v.version === current.version && h('span.badge.s-completed', t('policy.currentVersion'))),
            h('td.muted', fmtDateTime(v.createdAt)), h('td', v.createdBy.replace(/\s*<.*>$/, '')), h('td', v.note || '–'),
            h('td', v.version !== current.version && h('button.btn.small.ghost', { type: 'button', onClick: (e) => busy(e.currentTarget, async () => {
              const old = await api.get(`/api/policy/versions/${v.version}`);
              draft = structuredClone(old.policy);
              toast(t('policy.loadedVersion', { v: v.version }));
              select('routes');
            }) }, t('policy.loadVersion')))))))));
      }).catch((err) => mount(host, h('p.field-error', errorText(err))));
      return h('div.stack', h('p.muted', t('policy.historyHint')), host);
    },

    json() {
      const area = h('textarea.mono.json-edit', { rows: 26, spellcheck: 'false', value: JSON.stringify(draft, null, 2) });
      const file = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onChange: async (e) => {
        const [picked] = e.target.files;
        if (picked) area.value = await picked.text();
      } });
      return h('div.stack',
        h('p.muted', t('policy.jsonHint')),
        h('div.row',
          h('button.btn', { type: 'button', onClick: () => {
            try {
              const parsed = JSON.parse(area.value);
              if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
              draft = parsed;
              toast(t('policy.jsonApplied'));
              touched();
            } catch {
              toast(t('policy.jsonInvalid'), 'error');
            }
          } }, t('policy.jsonApply')),
          h('button.btn.ghost', { type: 'button', onClick: () => file.click() }, t('policy.jsonImport')),
          h('button.btn.ghost', { type: 'button', onClick: () => {
            const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' }));
            h('a', { href: url, download: `policy-v${current.version}.json` }).click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } }, t('policy.jsonExport')), file),
        area);
    },
  };

  // ----- frame -------------------------------------------------------------

  const tabHost = h('div');
  function select(next) {
    section = next;
    history.replaceState(null, '', `#/policy?section=${next}`);
    draw();
  }
  function drawErrors() {
    mount(errorHost, errors.length > 0 && h('div.error-summary', { role: 'alert' },
      h('strong', t('policy.errorsTitle', { n: errors.length })),
      h('ul', errors.slice(0, 30).map((e) => h('li', h('code', e.path || '/'), ' ', policyMessage(e))))));
  }
  function draw() {
    mount(tabHost, tabs(SECTIONS.map((id) => [id, t(`policy.section.${id}`)]), section, select));
    mount(body, sections[section]());
    drawErrors();
    touched();
  }

  saveButton.addEventListener('click', async () => {
    const result = await api.post('/api/policy/validate', { policy: draft }).catch((err) => ({ valid: false, errors: [{ path: '', code: err.code }] }));
    errors = result.errors;
    drawErrors();
    if (!result.valid) {
      toast(t('policy.invalid'), 'error');
      errorHost.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    const note = await confirmDialog({ title: t('policy.saveTitle'), message: t('policy.saveMessage', { v: current.version + 1 }), confirmLabel: t('policy.save'), input: { label: t('policy.note'), maxLength: 300, multiline: false } });
    if (note === undefined) return;
    busy(saveButton, async () => {
      try {
        await api.put('/api/policy', { policy: draft, note, baseVersion: current.version });
      } catch (err) {
        if (Array.isArray(err.details) && err.details[0]?.path !== undefined) {
          errors = err.details;
          drawErrors();
        }
        throw err;
      }
      toast(t('policy.savedToast'), 'ok');
      await reloadSession();
    });
  });
  resetButton.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: t('policy.reset'), message: t('policy.resetMessage'), danger: true }))) return;
    draft = JSON.parse(baseline);
    errors = [];
    draw();
  });
  window.addEventListener('beforeunload', (e) => {
    if (document.body.contains(body) && dirty()) e.preventDefault();
  });

  draw();
  return h('div.stack',
    pageHeader(t('nav.policy'), t('policy.sub', { v: current.version, when: fmtDateTime(current.createdAt), by: current.createdBy.replace(/\s*<.*>$/, '') }), resetButton, saveButton),
    tabHost, errorHost, body);
}

