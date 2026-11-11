import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, validatePolicy, matchesRoute, distinctApproversFeasible } from '../server/policy.js';
import { SYSTEM_ACTOR } from '../server/rbac.js';
import { makeApp, makeOrg, codeOf, detailsOf } from './helpers.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const codesAt = (errors, path) => errors.filter((e) => e.path === path).map((e) => e.code);

test('the built-in policy is valid and survives a round trip unchanged', () => {
  const { policy, errors } = validatePolicy(clone(DEFAULT_POLICY));
  assert.deepEqual(errors, []);
  assert.deepEqual(policy, DEFAULT_POLICY);
});

test('validation points at the field that is wrong', () => {
  const p = clone(DEFAULT_POLICY);
  p.labels[0].id = 'Bad Id';
  p.labels[1].color = 'red';
  p.labels[2].rank = -1;
  p.routes[0].stages[0].approver = { type: 'role', role: 'janitor' };
  p.routes[1].when.labels = ['nope'];
  p.rules.approvalValidityDays = 0;
  p.surprise = true;
  const { errors } = validatePolicy(p);
  assert.deepEqual(codesAt(errors, 'labels[0].id'), ['invalid_id']);
  assert.deepEqual(codesAt(errors, 'labels[1].color'), ['invalid_color']);
  assert.deepEqual(codesAt(errors, 'labels[2].rank'), ['out_of_range']);
  assert.deepEqual(codesAt(errors, 'routes[0].stages[0].approver.role'), ['unknown_role']);
  assert.deepEqual(codesAt(errors, 'routes[1].when.labels[0]'), ['unknown_label']);
  assert.deepEqual(codesAt(errors, 'rules.approvalValidityDays'), ['out_of_range']);
  assert.deepEqual(codesAt(errors, 'surprise'), ['unknown_field']);
});

test('a policy must end with a route that matches everything', () => {
  const p = clone(DEFAULT_POLICY);
  p.routes.pop();
  const { errors } = validatePolicy(p);
  assert.deepEqual(codesAt(errors, `routes[${p.routes.length - 1}].when`), ['last_route_must_match_all']);
});

test('structural rules: duplicate ids, all-optional stages, flag dependencies', () => {
  const p = clone(DEFAULT_POLICY);
  p.labels[1].id = p.labels[0].id;
  p.routes[3].stages[0].optional = true;
  p.actions[0].targetMustBeLower = true;
  p.actions.forEach((a) => {
    a.enabled = false;
  });
  const { errors } = validatePolicy(p);
  assert.deepEqual(codesAt(errors, 'labels[1].id'), ['duplicate_id']);
  assert.deepEqual(codesAt(errors, 'routes[3].stages'), ['all_stages_optional']);
  assert.deepEqual(codesAt(errors, 'actions[0].targetMustBeLower'), ['needs_target_label']);
  assert.deepEqual(codesAt(errors, 'actions'), ['none_enabled']);
});

test('executor modes need their prerequisites', () => {
  const webhook = clone(DEFAULT_POLICY);
  webhook.executor.mode = 'webhook';
  assert.deepEqual(codesAt(validatePolicy(webhook, { config: {} }).errors, 'executor.mode'), ['executor_not_configured']);
  assert.deepEqual(validatePolicy(webhook, { config: { executorWebhookUrl: 'https://exec.example/run' } }).errors, []);
  const simulate = clone(DEFAULT_POLICY);
  simulate.executor.mode = 'simulate';
  assert.deepEqual(codesAt(validatePolicy(simulate, { config: {} }).errors, 'executor.mode'), ['simulate_needs_demo']);
  assert.deepEqual(validatePolicy(simulate, { config: { demo: true } }).errors, []);
});

test('user and department references are checked against the directory', () => {
  const p = clone(DEFAULT_POLICY);
  p.routes[0].stages[0].approver = { type: 'users', userIds: ['usr_known', 'usr_missing'] };
  p.routes[0].when.departments = ['dep_missing'];
  const { errors } = validatePolicy(p, { userExists: (id) => id === 'usr_known', departmentExists: () => false });
  assert.deepEqual(codesAt(errors, 'routes[0].stages[0].approver.userIds[1]'), ['unknown_user']);
  assert.deepEqual(codesAt(errors, 'routes[0].when.departments[0]'), ['unknown_department']);
});

test('route conditions', () => {
  const facts = { action: 'remove_protection', labelIds: ['internal', 'confidential'], topRank: 3, external: true, reasonId: 'archive', departmentIds: ['team', 'division'], documentCount: 4 };
  const match = (when) => matchesRoute({ when }, facts);
  assert.equal(match({}), true);
  assert.equal(match({ actions: ['remove_protection'] }), true);
  assert.equal(match({ actions: ['change_label'] }), false);
  assert.equal(match({ labels: ['confidential'] }), true);
  assert.equal(match({ labels: ['secret'] }), false);
  assert.equal(match({ reasons: ['archive', 'migration'] }), true);
  assert.equal(match({ reasons: ['migration'] }), false);
  assert.equal(match({ departments: ['division'] }), true, 'a parent department covers its teams');
  assert.equal(match({ departments: ['elsewhere'] }), false);
  assert.equal(match({ minLabelRank: 3 }), true);
  assert.equal(match({ minLabelRank: 4 }), false);
  assert.equal(match({ maxLabelRank: 2 }), false);
  assert.equal(match({ external: true }), true);
  assert.equal(match({ external: false }), false);
  assert.equal(match({ minDocuments: 4 }), true);
  assert.equal(match({ minDocuments: 5 }), false);
  assert.equal(match({ minLabelRank: 3, external: true, actions: ['remove_protection'] }), true);
  assert.equal(match({ minLabelRank: 3, external: false }), false, 'every condition must hold');
});

test('the default policy routes by sensitivity and destination', async () => {
  const ctx = makeApp();
  const org = await makeOrg(ctx);
  const { policy, users } = ctx.services;
  const pol = policy.current().policy;
  const requester = users.rowById(org.ids.alice);
  const routeFor = (labelIds, external, action = 'remove_protection') =>
    policy.resolveRoute(pol, policy.factsFor(pol, { action, labelIds, external, reasonId: 'archive', departmentId: requester.department_id, documentCount: labelIds.length })).id;
  assert.equal(routeFor(['internal'], false), 'default');
  assert.equal(routeFor(['internal'], true), 'external');
  assert.equal(routeFor(['confidential'], false), 'confidential');
  assert.equal(routeFor(['confidential'], true), 'confidential-external');
  assert.equal(routeFor(['internal', 'confidential'], false), 'confidential', 'the most sensitive document decides');
  assert.equal(routeFor(['custom'], true), 'confidential-external');
});

test('distinct approvers: feasible only when stages can use different people', () => {
  assert.equal(distinctApproversFeasible([{ need: 1, candidates: ['a'] }, { need: 1, candidates: ['b'] }]), true);
  assert.equal(distinctApproversFeasible([{ need: 1, candidates: ['a'] }, { need: 1, candidates: ['a'] }]), false);
  assert.equal(distinctApproversFeasible([{ need: 1, candidates: ['a', 'b'] }, { need: 1, candidates: ['a'] }]), true, 'b takes the first stage');
  assert.equal(distinctApproversFeasible([{ need: 2, candidates: ['a', 'b'] }, { need: 1, candidates: ['a', 'b'] }]), false);
  assert.equal(distinctApproversFeasible([{ need: 2, candidates: ['a', 'b', 'c'] }, { need: 1, candidates: ['a', 'b'] }]), true);
  assert.equal(distinctApproversFeasible([]), true);
});

test('stages get concrete approvers; the requester is never one of them', async () => {
  const ctx = makeApp();
  const org = await makeOrg(ctx);
  const { policy, users } = ctx.services;
  const pol = policy.current().policy;
  const route = pol.routes.find((r) => r.id === 'confidential-external');

  const forAlice = policy.buildStages(pol, route, users.rowById(org.ids.alice)).stages;
  assert.deepEqual(forAlice.map((s) => s.assignees.map((u) => u.login)), [['lead'], ['head'], ['sec1', 'sec2']]);
  assert.deepEqual(forAlice.map((s) => s.skipped), [false, false, false]);

  // lead's manager is head and there is nobody above: the optional senior stage is skipped.
  const forLead = policy.buildStages(pol, route, users.rowById(org.ids.lead)).stages;
  assert.deepEqual(forLead.map((s) => s.assignees.map((u) => u.login)), [['head'], [], ['sec1', 'sec2']]);
  assert.equal(forLead[1].skipped, true);
  assert.equal(forLead[1].note, 'no_approver_skipped');

  // A security officer asking for a release is not among their own approvers.
  users.update(SYSTEM_ACTOR, org.ids.sec1, { managerId: org.ids.head });
  const external = pol.routes.find((r) => r.id === 'external');
  const forSec = policy.buildStages(pol, external, users.rowById(org.ids.sec1)).stages;
  assert.deepEqual(forSec.map((s) => s.assignees.map((u) => u.login)), [['head'], ['sec2']]);

  // Without a manager the only other security officer would have to sign both
  // stages, which "different approvers" forbids, so the request is refused.
  assert.equal(codeOf(() => policy.buildStages(pol, external, users.rowById(org.ids.sec2))), 'approvers_overlap');
});

test('a missing manager falls back to department approvers, then to the fallback approver', async () => {
  const ctx = makeApp();
  const org = await makeOrg(ctx);
  const { policy, users } = ctx.services;
  const pol = policy.current().policy;
  const route = pol.routes.find((r) => r.id === 'default');

  // carol has no manager and her department has no approver: security steps in.
  const forCarol = policy.buildStages(pol, route, users.rowById(org.ids.carol)).stages;
  assert.deepEqual(forCarol[0].assignees.map((u) => u.login), ['sec1', 'sec2']);
  assert.equal(forCarol[0].note, 'fallback_approver');

  // head has no manager, but an approver exists in the division's own department... except head is that approver.
  users.update(SYSTEM_ACTOR, org.ids.bob, { roles: ['requester', 'approver'], departmentId: org.departments.division });
  const forHead = policy.buildStages(pol, route, users.rowById(org.ids.head)).stages;
  assert.deepEqual(forHead[0].assignees.map((u) => u.login), ['bob']);
  assert.equal(forHead[0].note, 'fallback_department_approver');
});

test('an inactive manager is passed over for the next one up', async () => {
  const ctx = makeApp();
  const org = await makeOrg(ctx);
  const { policy, users } = ctx.services;
  const pol = policy.current().policy;
  users.update(SYSTEM_ACTOR, org.ids.lead, { active: false });
  const stages = policy.buildStages(pol, pol.routes.find((r) => r.id === 'default'), users.rowById(org.ids.alice)).stages;
  assert.deepEqual(stages[0].assignees.map((u) => u.login), ['head']);
});

test('a route that cannot finish is refused up front', async () => {
  const ctx = makeApp();
  const org = await makeOrg(ctx);
  const { policy, users } = ctx.services;
  const pol = JSON.parse(JSON.stringify(policy.current().policy));
  const alice = users.rowById(org.ids.alice);

  // Nobody holds the role and there is no fallback.
  pol.fallbackApprover = null;
  const noOne = { stages: [{ name: { en: 'Audit' }, approver: { type: 'users', userIds: [org.ids.alice] }, minApprovals: 1, slaHours: null, optional: false }], cc: [] };
  assert.equal(codeOf(() => policy.buildStages(pol, noOne, alice)), 'no_approver');

  // Two approvals wanted, one person available.
  const tooFew = { stages: [{ name: { en: 'Manager' }, approver: { type: 'manager', level: 1 }, minApprovals: 2, slaHours: null, optional: false }], cc: [] };
  assert.equal(codeOf(() => policy.buildStages(pol, tooFew, alice)), 'not_enough_approvers');
  assert.deepEqual(detailsOf(() => policy.buildStages(pol, tooFew, alice)).needed, 2);

  // The same single person in two stages cannot satisfy "different approvers".
  const same = {
    stages: [
      { name: { en: 'One' }, approver: { type: 'users', userIds: [org.ids.lead] }, minApprovals: 1, slaHours: null, optional: false },
      { name: { en: 'Two' }, approver: { type: 'users', userIds: [org.ids.lead] }, minApprovals: 1, slaHours: null, optional: false },
    ],
    cc: [],
  };
  assert.equal(codeOf(() => policy.buildStages(pol, same, alice)), 'approvers_overlap');
  pol.rules.distinctApprovers = false;
  assert.equal(policy.buildStages(pol, same, alice).stages.length, 2);
});

test('saving a policy versions it, audits it and detects concurrent edits', async () => {
  const ctx = makeApp();
  const org = await makeOrg(ctx);
  const { policy, audit } = ctx.services;
  const draft = JSON.parse(JSON.stringify(policy.current().policy));
  draft.rules.approvalValidityDays = 3;
  const saved = policy.save(org.as('sec1'), draft, { note: 'Shorter validity', baseVersion: 1 });
  assert.equal(saved.version, 2);
  assert.equal(policy.current().policy.rules.approvalValidityDays, 3);
  assert.equal(policy.version(1).policy.rules.approvalValidityDays, 7, 'earlier versions stay readable');

  const entry = audit.query({ action: 'policy.updated' }).items[0];
  assert.deepEqual(entry.details.changedSections, ['rules']);
  assert.equal(entry.details.note, 'Shorter validity');

  assert.equal(codeOf(() => policy.save(org.as('sec1'), draft, { baseVersion: 1 })), 'policy_conflict');
  assert.equal(policy.save(org.as('sec1'), draft, { baseVersion: 2 }).version, 2, 'saving without changes makes no new version');

  draft.labels.push({ id: 'broken id', name: { en: 'x' }, rank: 1, protected: true, releasable: true });
  assert.equal(codeOf(() => policy.save(org.as('sec1'), draft, {})), 'validation_failed');
});
