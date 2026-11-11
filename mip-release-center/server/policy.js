// The release policy: label taxonomy, request types, reasons, approval routes
// and rules. It is data, kept as versioned JSON, so the same app fits
// different organisations and labelling schemes without code changes.
import { fail } from './http.js';
import { canonicalJson } from './util.js';

export const APPROVER_TYPES = ['manager', 'department_approver', 'role', 'users'];
export const APPROVER_ROLES = ['approver', 'security', 'auditor', 'admin', 'operator'];
export const EXECUTOR_MODES = ['manual', 'webhook', 'simulate'];
const ACTION_FLAGS = ['requiresTargetLabel', 'targetMustBeLower', 'requiresRecipients', 'requiresRecipientEmail', 'requiresProtectedSource'];
const RULE_BOOLEANS = [
  'distinctApprovers',
  'operatorMustDifferFromRequester',
  'operatorMustDifferFromApprovers',
  'requireAcknowledgement',
  'requireLocation',
  'requireHash',
  'requireCommentOnApproval',
];
const RULE_NUMBERS = {
  approvalValidityDays: [1, 90],
  pendingExpiryDays: [1, 365],
  maxDocumentsPerRequest: [1, 200],
  minJustificationLength: [0, 1000],
  maxDelegationDays: [1, 365],
};
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const DEFAULT_POLICY = {
  schema: 1,
  numbering: { prefix: 'REL' },
  notice: {
    ko: '문서 원본은 이 시스템에 올라가지 않습니다. 파일 이름, 위치, 해시 같은 식별 정보만 기록되며, 실제 해제는 승인이 끝난 뒤 실행 담당자가 조직의 권한으로 처리합니다.',
    en: 'Documents themselves are never uploaded here. Only identifying details such as file name, location and hash are recorded; after approval an operator carries out the release with the organisation\'s own rights.',
  },
  acknowledgement: {
    ko: '신청 내용이 사실이며, 보호가 해제된 문서를 승인받은 목적에만 쓰고 그 관리 책임이 본인에게 있음을 확인합니다.',
    en: 'I confirm this request is accurate, that the released documents will be used only for the approved purpose, and that I am responsible for handling them.',
  },
  labels: [
    { id: 'public', name: { ko: '공개', en: 'Public' }, rank: 0, protected: false, releasable: true, color: '#3f8f5b', externalId: '' },
    { id: 'general', name: { ko: '일반', en: 'General' }, rank: 1, protected: false, releasable: true, color: '#3b78c4', externalId: '' },
    { id: 'internal', name: { ko: '사내한', en: 'Internal' }, rank: 2, protected: true, releasable: true, color: '#a8741a', externalId: '' },
    { id: 'confidential', name: { ko: '대외비', en: 'Confidential' }, rank: 3, protected: true, releasable: true, color: '#c8561f', externalId: '' },
    { id: 'custom', name: { ko: '사용자 지정 보호', en: 'Custom protection' }, rank: 3, protected: true, releasable: true, color: '#7a5bb5', externalId: '' },
    { id: 'secret', name: { ko: '극비', en: 'Highly Confidential' }, rank: 4, protected: true, releasable: false, color: '#b3302a', externalId: '' },
  ],
  actions: [
    {
      id: 'remove_protection',
      name: { ko: '보호 해제', en: 'Remove protection' },
      description: {
        ko: '문서의 암호화와 사용 제한을 없앱니다. 해제된 사본은 누구나 열 수 있게 됩니다.',
        en: 'Removes encryption and usage restrictions. The released copy can be opened by anyone.',
      },
      enabled: true,
      requiresTargetLabel: false,
      targetMustBeLower: false,
      requiresRecipients: false,
      requiresRecipientEmail: false,
      requiresProtectedSource: true,
    },
    {
      id: 'change_label',
      name: { ko: '레이블 하향', en: 'Downgrade label' },
      description: {
        ko: '더 낮은 등급의 레이블로 바꿉니다. 새 레이블의 보호 수준이 그대로 적용됩니다.',
        en: 'Changes to a lower label. The protection of the new label then applies.',
      },
      enabled: true,
      requiresTargetLabel: true,
      targetMustBeLower: true,
      requiresRecipients: false,
      requiresRecipientEmail: false,
      requiresProtectedSource: false,
    },
    {
      id: 'grant_access',
      name: { ko: '외부 사용자 권한 부여', en: 'Grant access to recipients' },
      description: {
        ko: '보호는 유지하고 지정한 수신자에게만 열람 권한을 추가합니다. 해제보다 안전한 방법입니다.',
        en: 'Keeps protection and adds access only for the named recipients. Safer than removing protection.',
      },
      enabled: true,
      requiresTargetLabel: false,
      targetMustBeLower: false,
      requiresRecipients: true,
      requiresRecipientEmail: true,
      requiresProtectedSource: true,
    },
  ],
  reasons: [
    { id: 'external_partner', name: { ko: '협력사·고객 제출', en: 'Submission to partner or customer' }, external: true, enabled: true },
    { id: 'regulatory', name: { ko: '감독기관·법적 제출', en: 'Regulatory or legal submission' }, external: true, enabled: true },
    { id: 'migration', name: { ko: '시스템 이관', en: 'System migration' }, external: false, enabled: true },
    { id: 'archive', name: { ko: '장기 보존', en: 'Long-term archiving' }, external: false, enabled: true },
    { id: 'handover', name: { ko: '업무 인수인계', en: 'Work handover' }, external: false, enabled: true },
    { id: 'compatibility', name: { ko: '업무 시스템 호환', en: 'Tool compatibility' }, external: false, enabled: true },
    { id: 'mislabel', name: { ko: '레이블 오분류 정정', en: 'Correcting a wrong label' }, external: false, enabled: true },
    { id: 'other', name: { ko: '기타', en: 'Other' }, external: false, enabled: true },
  ],
  routes: [
    {
      id: 'confidential-external',
      name: { ko: '대외비 이상 외부 반출', en: 'Confidential or higher, leaving the organisation' },
      when: { minLabelRank: 3, external: true },
      stages: [
        { name: { ko: '부서장', en: 'Manager' }, approver: { type: 'manager', level: 1 }, minApprovals: 1, slaHours: 24, optional: false },
        { name: { ko: '상위 부서장', en: 'Senior manager' }, approver: { type: 'manager', level: 2 }, minApprovals: 1, slaHours: 24, optional: true },
        { name: { ko: '보안담당', en: 'Security' }, approver: { type: 'role', role: 'security' }, minApprovals: 1, slaHours: 24, optional: false },
      ],
      cc: [],
    },
    {
      id: 'confidential',
      name: { ko: '대외비 이상', en: 'Confidential or higher' },
      when: { minLabelRank: 3 },
      stages: [
        { name: { ko: '부서장', en: 'Manager' }, approver: { type: 'manager', level: 1 }, minApprovals: 1, slaHours: 24, optional: false },
        { name: { ko: '보안담당', en: 'Security' }, approver: { type: 'role', role: 'security' }, minApprovals: 1, slaHours: 24, optional: false },
      ],
      cc: [],
    },
    {
      id: 'external',
      name: { ko: '외부 반출', en: 'Leaving the organisation' },
      when: { external: true },
      stages: [
        { name: { ko: '부서장', en: 'Manager' }, approver: { type: 'manager', level: 1 }, minApprovals: 1, slaHours: 24, optional: false },
        { name: { ko: '보안담당', en: 'Security' }, approver: { type: 'role', role: 'security' }, minApprovals: 1, slaHours: 48, optional: false },
      ],
      cc: [],
    },
    {
      id: 'default',
      name: { ko: '기본', en: 'Default' },
      when: {},
      stages: [
        { name: { ko: '부서장', en: 'Manager' }, approver: { type: 'manager', level: 1 }, minApprovals: 1, slaHours: 48, optional: false },
      ],
      cc: [],
    },
  ],
  fallbackApprover: { type: 'role', role: 'security' },
  rules: {
    approvalValidityDays: 7,
    pendingExpiryDays: 30,
    maxDocumentsPerRequest: 30,
    minJustificationLength: 20,
    maxDelegationDays: 31,
    distinctApprovers: true,
    operatorMustDifferFromRequester: true,
    operatorMustDifferFromApprovers: false,
    requireAcknowledgement: true,
    requireLocation: false,
    requireHash: false,
    requireCommentOnApproval: false,
    locationPrefixes: [],
  },
  executor: { mode: 'manual' },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Check a policy and return a cleaned copy plus a list of problems, each with a
 * JSON path so the editor can point at the offending field.
 */
export function validatePolicy(input, { userExists = () => true, departmentExists = () => true, config = {} } = {}) {
  const errors = [];
  const err = (path, code, params) => errors.push(params ? { path, code, params } : { path, code });

  const text = (value, path, { required = true, max = 80 } = {}) => {
    const out = {};
    if (value === undefined || value === null) {
      if (required) err(path, 'required');
      return out;
    }
    if (!isPlainObject(value)) {
      err(path, 'invalid_text');
      return out;
    }
    for (const [locale, str] of Object.entries(value)) {
      if (!/^[a-z]{2}$/.test(locale) || typeof str !== 'string') {
        err(`${path}.${locale}`, 'invalid_text');
        continue;
      }
      const trimmed = str.trim();
      if (trimmed.length > max) err(`${path}.${locale}`, 'too_long', { max });
      if (trimmed) out[locale] = trimmed;
    }
    if (required && !Object.keys(out).length) err(path, 'required');
    return out;
  };
  const id = (value, path, seen) => {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
      err(path, 'invalid_id');
      return '';
    }
    if (seen.has(value)) err(path, 'duplicate_id');
    seen.add(value);
    return value;
  };
  const integer = (value, path, min, max, dflt) => {
    if (value === undefined || value === null) {
      if (dflt === undefined) err(path, 'required');
      return dflt;
    }
    if (!Number.isInteger(value) || value < min || value > max) {
      err(path, 'out_of_range', { min, max });
      return dflt;
    }
    return value;
  };
  const flag = (value, path, dflt = false) => {
    if (value === undefined || value === null) return dflt;
    if (typeof value !== 'boolean') {
      err(path, 'invalid_boolean');
      return dflt;
    }
    return value;
  };
  const array = (value, path, min, max) => {
    if (!Array.isArray(value)) {
      err(path, 'invalid_list');
      return [];
    }
    if (value.length < min || value.length > max) err(path, 'list_size', { min, max });
    return value;
  };
  const knownKeys = (obj, path, keys) => {
    for (const key of Object.keys(obj)) if (!keys.includes(key)) err(`${path ? path + '.' : ''}${key}`, 'unknown_field');
  };

  if (!isPlainObject(input)) return { policy: null, errors: [{ path: '', code: 'invalid_policy' }] };
  knownKeys(input, '', ['schema', 'numbering', 'notice', 'acknowledgement', 'labels', 'actions', 'reasons', 'routes', 'fallbackApprover', 'rules', 'executor']);
  if (input.schema !== 1) err('schema', 'unsupported_schema');

  const policy = { schema: 1 };

  const prefix = isPlainObject(input.numbering) ? input.numbering.prefix : undefined;
  if (typeof prefix !== 'string' || !/^[A-Z][A-Z0-9]{1,7}$/.test(prefix)) err('numbering.prefix', 'invalid_prefix');
  policy.numbering = { prefix: typeof prefix === 'string' ? prefix : 'REL' };
  policy.notice = text(input.notice, 'notice', { required: false, max: 1000 });
  policy.acknowledgement = text(input.acknowledgement, 'acknowledgement', { required: false, max: 1000 });

  // labels
  const labelIds = new Set();
  policy.labels = array(input.labels, 'labels', 1, 30).map((label, i) => {
    const path = `labels[${i}]`;
    if (!isPlainObject(label)) {
      err(path, 'invalid_item');
      return null;
    }
    knownKeys(label, path, ['id', 'name', 'rank', 'protected', 'releasable', 'color', 'externalId']);
    const color = label.color ?? '';
    if (color !== '' && (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color))) err(`${path}.color`, 'invalid_color');
    const externalId = label.externalId ?? '';
    if (typeof externalId !== 'string' || externalId.length > 100) err(`${path}.externalId`, 'too_long', { max: 100 });
    return {
      id: id(label.id, `${path}.id`, labelIds),
      name: text(label.name, `${path}.name`, { max: 60 }),
      rank: integer(label.rank, `${path}.rank`, 0, 100, 0),
      protected: flag(label.protected, `${path}.protected`),
      releasable: flag(label.releasable, `${path}.releasable`, true),
      color: typeof color === 'string' ? color.toLowerCase() : '',
      externalId: typeof externalId === 'string' ? externalId.trim() : '',
    };
  }).filter(Boolean);

  // actions
  const actionIds = new Set();
  policy.actions = array(input.actions, 'actions', 1, 10).map((action, i) => {
    const path = `actions[${i}]`;
    if (!isPlainObject(action)) {
      err(path, 'invalid_item');
      return null;
    }
    knownKeys(action, path, ['id', 'name', 'description', 'enabled', ...ACTION_FLAGS]);
    const out = {
      id: id(action.id, `${path}.id`, actionIds),
      name: text(action.name, `${path}.name`, { max: 60 }),
      description: text(action.description, `${path}.description`, { required: false, max: 300 }),
      enabled: flag(action.enabled, `${path}.enabled`, true),
    };
    for (const key of ACTION_FLAGS) out[key] = flag(action[key], `${path}.${key}`);
    if (out.targetMustBeLower && !out.requiresTargetLabel) err(`${path}.targetMustBeLower`, 'needs_target_label');
    if (out.requiresRecipientEmail && !out.requiresRecipients) err(`${path}.requiresRecipientEmail`, 'needs_recipients');
    return out;
  }).filter(Boolean);
  if (policy.actions.length && !policy.actions.some((a) => a.enabled)) err('actions', 'none_enabled');

  // reasons
  const reasonIds = new Set();
  policy.reasons = array(input.reasons, 'reasons', 1, 30).map((reason, i) => {
    const path = `reasons[${i}]`;
    if (!isPlainObject(reason)) {
      err(path, 'invalid_item');
      return null;
    }
    knownKeys(reason, path, ['id', 'name', 'external', 'enabled']);
    return {
      id: id(reason.id, `${path}.id`, reasonIds),
      name: text(reason.name, `${path}.name`, { max: 60 }),
      external: flag(reason.external, `${path}.external`),
      enabled: flag(reason.enabled, `${path}.enabled`, true),
    };
  }).filter(Boolean);
  if (policy.reasons.length && !policy.reasons.some((r) => r.enabled)) err('reasons', 'none_enabled');

  const approver = (spec, path, { fallback = false } = {}) => {
    if (!isPlainObject(spec)) {
      err(path, 'invalid_approver');
      return { type: 'role', role: 'security' };
    }
    knownKeys(spec, path, ['type', 'level', 'role', 'userIds']);
    if (!APPROVER_TYPES.includes(spec.type)) {
      err(`${path}.type`, 'invalid_approver_type');
      return { type: 'role', role: 'security' };
    }
    if (fallback && !['role', 'users'].includes(spec.type)) err(`${path}.type`, 'fallback_needs_role_or_users');
    if (spec.type === 'manager') return { type: 'manager', level: integer(spec.level, `${path}.level`, 1, 5, 1) };
    if (spec.type === 'department_approver') return { type: 'department_approver' };
    if (spec.type === 'role') {
      if (!APPROVER_ROLES.includes(spec.role)) err(`${path}.role`, 'unknown_role');
      return { type: 'role', role: spec.role };
    }
    const userIds = array(spec.userIds, `${path}.userIds`, 1, 20).filter((u, j) => {
      if (typeof u !== 'string' || !userExists(u)) {
        err(`${path}.userIds[${j}]`, 'unknown_user');
        return false;
      }
      return true;
    });
    return { type: 'users', userIds: [...new Set(userIds)] };
  };

  // routes
  const routeIds = new Set();
  const refList = (value, path, known, code) => {
    const items = array(value, path, 1, 30);
    items.forEach((item, j) => {
      if (!known(item)) err(`${path}[${j}]`, code);
    });
    return [...new Set(items.filter((item) => typeof item === 'string'))];
  };
  policy.routes = array(input.routes, 'routes', 1, 30).map((route, i) => {
    const path = `routes[${i}]`;
    if (!isPlainObject(route)) {
      err(path, 'invalid_item');
      return null;
    }
    knownKeys(route, path, ['id', 'name', 'when', 'stages', 'cc']);
    const when = {};
    const rawWhen = route.when ?? {};
    if (!isPlainObject(rawWhen)) err(`${path}.when`, 'invalid_condition');
    else {
      knownKeys(rawWhen, `${path}.when`, ['actions', 'labels', 'reasons', 'departments', 'minLabelRank', 'maxLabelRank', 'external', 'minDocuments']);
      if (rawWhen.actions !== undefined) when.actions = refList(rawWhen.actions, `${path}.when.actions`, (v) => actionIds.has(v), 'unknown_action');
      if (rawWhen.labels !== undefined) when.labels = refList(rawWhen.labels, `${path}.when.labels`, (v) => labelIds.has(v), 'unknown_label');
      if (rawWhen.reasons !== undefined) when.reasons = refList(rawWhen.reasons, `${path}.when.reasons`, (v) => reasonIds.has(v), 'unknown_reason');
      if (rawWhen.departments !== undefined) {
        when.departments = refList(rawWhen.departments, `${path}.when.departments`, (v) => typeof v === 'string' && departmentExists(v), 'unknown_department');
      }
      if (rawWhen.minLabelRank !== undefined) when.minLabelRank = integer(rawWhen.minLabelRank, `${path}.when.minLabelRank`, 0, 100, 0);
      if (rawWhen.maxLabelRank !== undefined) when.maxLabelRank = integer(rawWhen.maxLabelRank, `${path}.when.maxLabelRank`, 0, 100, 100);
      if (when.minLabelRank !== undefined && when.maxLabelRank !== undefined && when.minLabelRank > when.maxLabelRank) {
        err(`${path}.when.maxLabelRank`, 'rank_range');
      }
      if (rawWhen.external !== undefined) when.external = flag(rawWhen.external, `${path}.when.external`);
      if (rawWhen.minDocuments !== undefined) when.minDocuments = integer(rawWhen.minDocuments, `${path}.when.minDocuments`, 1, 200, 1);
    }
    const stages = array(route.stages, `${path}.stages`, 1, 6).map((stage, j) => {
      const sp = `${path}.stages[${j}]`;
      if (!isPlainObject(stage)) {
        err(sp, 'invalid_item');
        return null;
      }
      knownKeys(stage, sp, ['name', 'approver', 'minApprovals', 'slaHours', 'optional']);
      return {
        name: text(stage.name, `${sp}.name`, { max: 40 }),
        approver: approver(stage.approver, `${sp}.approver`),
        minApprovals: integer(stage.minApprovals, `${sp}.minApprovals`, 1, 5, 1),
        slaHours: stage.slaHours === null || stage.slaHours === undefined ? null : integer(stage.slaHours, `${sp}.slaHours`, 1, 720, null),
        optional: flag(stage.optional, `${sp}.optional`),
      };
    }).filter(Boolean);
    if (stages.length && stages.every((s) => s.optional)) err(`${path}.stages`, 'all_stages_optional');
    return {
      id: id(route.id, `${path}.id`, routeIds),
      name: text(route.name, `${path}.name`, { max: 80 }),
      when,
      stages,
      cc: route.cc === undefined ? [] : array(route.cc, `${path}.cc`, 0, 5).map((spec, j) => approver(spec, `${path}.cc[${j}]`)),
    };
  }).filter(Boolean);
  const last = policy.routes[policy.routes.length - 1];
  if (last && Object.keys(last.when).length) err(`routes[${policy.routes.length - 1}].when`, 'last_route_must_match_all');

  if (input.fallbackApprover === undefined || input.fallbackApprover === null) policy.fallbackApprover = null;
  else policy.fallbackApprover = approver(input.fallbackApprover, 'fallbackApprover', { fallback: true });

  // rules
  const rules = isPlainObject(input.rules) ? input.rules : (err('rules', 'required'), {});
  knownKeys(rules, 'rules', [...Object.keys(RULE_NUMBERS), ...RULE_BOOLEANS, 'locationPrefixes']);
  policy.rules = {};
  for (const [key, [min, max]] of Object.entries(RULE_NUMBERS)) {
    policy.rules[key] = integer(rules[key], `rules.${key}`, min, max, DEFAULT_POLICY.rules[key]);
  }
  for (const key of RULE_BOOLEANS) policy.rules[key] = flag(rules[key], `rules.${key}`, DEFAULT_POLICY.rules[key]);
  policy.rules.locationPrefixes = rules.locationPrefixes === undefined
    ? []
    : array(rules.locationPrefixes, 'rules.locationPrefixes', 0, 20)
        .filter((p, i) => {
          if (typeof p !== 'string' || !p.trim() || p.length > 200) {
            err(`rules.locationPrefixes[${i}]`, 'invalid_prefix');
            return false;
          }
          return true;
        })
        .map((p) => p.trim());

  // executor
  const mode = isPlainObject(input.executor) ? input.executor.mode : undefined;
  if (!EXECUTOR_MODES.includes(mode)) err('executor.mode', 'invalid_executor');
  else if (mode === 'webhook' && !config.executorWebhookUrl) err('executor.mode', 'executor_not_configured');
  else if (mode === 'simulate' && !config.demo) err('executor.mode', 'simulate_needs_demo');
  policy.executor = { mode: EXECUTOR_MODES.includes(mode) ? mode : 'manual' };

  return { policy, errors };
}

/** Facts about one request that route conditions are evaluated against. */
export function matchesRoute(route, facts) {
  const when = route.when ?? {};
  if (when.actions && !when.actions.includes(facts.action)) return false;
  if (when.labels && !facts.labelIds.some((l) => when.labels.includes(l))) return false;
  if (when.reasons && !when.reasons.includes(facts.reasonId)) return false;
  if (when.departments && !facts.departmentIds.some((d) => when.departments.includes(d))) return false;
  if (when.minLabelRank !== undefined && !(facts.topRank >= when.minLabelRank)) return false;
  if (when.maxLabelRank !== undefined && !(facts.topRank <= when.maxLabelRank)) return false;
  if (when.external !== undefined && when.external !== facts.external) return false;
  if (when.minDocuments !== undefined && !(facts.documentCount >= when.minDocuments)) return false;
  return true;
}

/**
 * Can every stage collect its approvals from different people? Each stage needs
 * `need` distinct users from its candidates and no user may serve two stages.
 * Sizes are tiny (at most 6 stages of 5), so plain backtracking is enough.
 */
export function distinctApproversFeasible(stages) {
  const slots = [];
  for (const stage of stages) for (let i = 0; i < stage.need; i += 1) slots.push(stage.candidates);
  slots.sort((a, b) => a.length - b.length);
  const used = new Set();
  const place = (index) => {
    if (index === slots.length) return true;
    for (const candidate of slots[index]) {
      if (used.has(candidate)) continue;
      used.add(candidate);
      if (place(index + 1)) return true;
      used.delete(candidate);
    }
    return false;
  };
  return place(0);
}

export function createPolicyService({ db, clock, audit, users, config, logger }) {
  let cache = null;

  function load() {
    const row = db.get('SELECT * FROM policy_versions ORDER BY version DESC LIMIT 1');
    if (!row) return null;
    return {
      version: row.version,
      policy: JSON.parse(row.policy),
      note: row.note ?? '',
      createdAt: row.created_at,
      createdBy: row.created_by_label ?? '',
    };
  }

  function ensureInitial() {
    if (load()) return;
    db.run(
      'INSERT INTO policy_versions (version, policy, note, created_by, created_by_label, created_at) VALUES (1, ?, ?, NULL, ?, ?)',
      JSON.stringify(DEFAULT_POLICY), 'Initial policy', 'system', clock.now().toISOString(),
    );
  }

  function current() {
    cache ??= load();
    return cache;
  }

  function version(v) {
    const row = db.get('SELECT * FROM policy_versions WHERE version = ?', v);
    if (!row) return null;
    return { version: row.version, policy: JSON.parse(row.policy), note: row.note ?? '', createdAt: row.created_at, createdBy: row.created_by_label ?? '' };
  }

  function versions() {
    return db
      .all('SELECT version, note, created_by_label, created_at FROM policy_versions ORDER BY version DESC LIMIT 200')
      .map((r) => ({ version: r.version, note: r.note ?? '', createdBy: r.created_by_label ?? '', createdAt: r.created_at }));
  }

  function validate(input) {
    return validatePolicy(input, {
      userExists: (id) => Boolean(users.rowById(id)),
      departmentExists: (id) => Boolean(users.departmentById(id)),
      config,
    });
  }

  function save(actor, input, { note = '', baseVersion } = {}) {
    const { policy, errors } = validate(input);
    if (errors.length) throw fail.invalid(errors, 'Policy is not valid');
    const cleanNote = String(note ?? '').trim().slice(0, 300);
    return db.tx(() => {
      const before = load();
      if (baseVersion !== undefined && baseVersion !== null && Number(baseVersion) !== before.version) {
        throw fail.conflict('policy_conflict', 'The policy was changed by someone else', { currentVersion: before.version });
      }
      const changedSections = Object.keys(policy).filter((key) => canonicalJson(policy[key]) !== canonicalJson(before.policy[key]));
      if (!changedSections.length) return before;
      const next = before.version + 1;
      db.run(
        'INSERT INTO policy_versions (version, policy, note, created_by, created_by_label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        next, JSON.stringify(policy), cleanNote, actor.type === 'user' ? actor.id : null, actor.label, clock.now().toISOString(),
      );
      audit.append(actor, 'policy.updated', {
        entityType: 'policy', entityId: String(next), details: { version: next, previousVersion: before.version, note: cleanNote, changedSections },
      });
      cache = null;
      return current();
    });
  }

  /** The executor the policy asks for, or manual when its prerequisites are missing. */
  function executorMode() {
    const mode = current().policy.executor?.mode ?? 'manual';
    if (mode === 'webhook' && !config.executorWebhookUrl) {
      logger?.warn('Policy asks for the webhook executor but MRC_EXECUTOR_WEBHOOK_URL is not set; using manual');
      return 'manual';
    }
    if (mode === 'simulate' && !config.demo) return 'manual';
    return mode;
  }

  // ----- lookups -----------------------------------------------------------

  const labelOf = (policy, id) => policy.labels.find((l) => l.id === id) ?? null;
  const actionOf = (policy, id) => policy.actions.find((a) => a.id === id) ?? null;
  const reasonOf = (policy, id) => policy.reasons.find((r) => r.id === id) ?? null;

  /** Highest-ranked label among the given ids. */
  function topLabel(policy, labelIds) {
    let top = null;
    for (const id of labelIds) {
      const label = labelOf(policy, id);
      if (label && (!top || label.rank > top.rank)) top = label;
    }
    return top;
  }

  function factsFor(policy, { action, labelIds, external, reasonId, departmentId, documentCount }) {
    const top = topLabel(policy, labelIds);
    return {
      action,
      labelIds,
      topRank: top ? top.rank : 0,
      topLabelId: top ? top.id : null,
      external: Boolean(external),
      reasonId,
      departmentIds: users.departmentChain(departmentId).map((d) => d.id),
      documentCount,
    };
  }

  function resolveRoute(policy, facts) {
    return policy.routes.find((route) => matchesRoute(route, facts)) ?? null;
  }

  /** Active users who may fill an approver slot for this requester. Never the requester. */
  function resolveApprovers(spec, requester) {
    let rows = [];
    if (spec.type === 'manager') {
      const chain = users.managerChain(requester.id).filter((m) => m.active);
      const target = chain[(spec.level ?? 1) - 1];
      rows = target ? [target] : [];
    } else if (spec.type === 'department_approver') {
      for (const dept of users.departmentChain(requester.department_id)) {
        rows = db
          .all('SELECT * FROM users WHERE active = 1 AND department_id = ? ORDER BY name COLLATE NOCASE', dept.id)
          .filter((row) => users.rolesOf(row).includes('approver'));
        rows = rows.filter((row) => row.id !== requester.id);
        if (rows.length) break;
      }
    } else if (spec.type === 'role') {
      rows = users.activeWithRole(spec.role);
    } else if (spec.type === 'users') {
      rows = spec.userIds.map((id) => users.rowById(id)).filter((row) => row && row.active);
    }
    return rows.filter((row) => row.id !== requester.id);
  }

  /**
   * Turn a route into concrete stages with named approvers for this requester.
   * Throws when a required stage has nobody who can approve: a request must
   * never be accepted into a route that cannot finish.
   */
  function buildStages(policy, route, requester) {
    const stages = [];
    route.stages.forEach((spec, index) => {
      let assignees = resolveApprovers(spec.approver, requester);
      let note = null;
      if (!assignees.length && spec.optional) {
        stages.push({ name: spec.name, approverSpec: spec.approver, minApprovals: spec.minApprovals, slaHours: spec.slaHours, assignees: [], skipped: true, note: 'no_approver_skipped' });
        return;
      }
      if (!assignees.length && spec.approver.type === 'manager') {
        assignees = resolveApprovers({ type: 'department_approver' }, requester);
        if (assignees.length) note = 'fallback_department_approver';
      }
      if (!assignees.length && policy.fallbackApprover) {
        assignees = resolveApprovers(policy.fallbackApprover, requester);
        if (assignees.length) note = 'fallback_approver';
      }
      if (!assignees.length) {
        throw fail.unprocessable('no_approver', 'No approver is available for a required stage', { stageIndex: index, stageName: spec.name });
      }
      if (assignees.length < spec.minApprovals) {
        throw fail.unprocessable('not_enough_approvers', 'A stage needs more approvers than are available', {
          stageIndex: index, stageName: spec.name, needed: spec.minApprovals, available: assignees.length,
        });
      }
      stages.push({ name: spec.name, approverSpec: spec.approver, minApprovals: spec.minApprovals, slaHours: spec.slaHours, assignees, skipped: false, note });
    });
    if (policy.rules.distinctApprovers) {
      const active = stages.filter((s) => !s.skipped).map((s) => ({ need: s.minApprovals, candidates: s.assignees.map((u) => u.id) }));
      if (!distinctApproversFeasible(active)) {
        throw fail.unprocessable('approvers_overlap', 'The stages cannot be approved by different people');
      }
    }
    const cc = [];
    for (const spec of route.cc ?? []) for (const row of resolveApprovers(spec, requester)) if (!cc.some((u) => u.id === row.id)) cc.push(row);
    return { stages, cc };
  }

  /** Names for labels, actions and reasons as they were in a given policy version. */
  function snapshotNames(policyVersion) {
    const source = (policyVersion && version(policyVersion)?.policy) || current().policy;
    return {
      labels: source.labels.map((l) => ({ id: l.id, name: l.name, color: l.color, rank: l.rank, protected: l.protected })),
      actions: source.actions.map((a) => ({ id: a.id, name: a.name })),
      reasons: source.reasons.map((r) => ({ id: r.id, name: r.name })),
    };
  }

  return {
    ensureInitial,
    current,
    version,
    versions,
    validate,
    save,
    executorMode,
    labelOf,
    actionOf,
    reasonOf,
    topLabel,
    factsFor,
    resolveRoute,
    resolveApprovers,
    buildStages,
    snapshotNames,
  };
}
