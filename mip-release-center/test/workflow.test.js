import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_ACTOR } from '../server/rbac.js';
import { makeApp, makeOrg, content, doc, submitted, codeOf, detailsOf } from './helpers.js';

async function setup(overrides) {
  const ctx = makeApp(overrides);
  const org = await makeOrg(ctx);
  return { ...ctx, ...ctx.services, org, as: org.as };
}

const fieldErrors = (fn) => (detailsOf(fn) ?? []).map((e) => `${e.field}:${e.code}`).sort();
const actions = (s, requestId) => s.audit.forRequest(requestId).map((e) => e.action);

test('a request goes from draft through approval and execution to completed', async () => {
  const s = await setup();
  const { requests, approvals, executions, as } = s;

  const draft = requests.createDraft(as('alice'), content({ documents: [doc('a.docx'), doc('b.docx')] }));
  assert.equal(draft.status, 'draft');
  assert.equal(draft.number, null, 'drafts have no number yet');

  const pending = requests.submit(as('alice'), draft.id, { acknowledged: true });
  assert.equal(pending.status, 'pending');
  assert.match(pending.number, /^REL-2026-00001$/);
  assert.equal(pending.route_id, 'default');
  assert.equal(pending.policy_version, 1);

  assert.equal(approvals.inbox(as('lead')).length, 1);
  assert.equal(approvals.inbox(as('head')).length, 0);

  const approved = approvals.decide(as('lead'), draft.id, { decision: 'approve' });
  assert.equal(approved.status, 'approved');
  assert.ok(approved.approval_valid_until > s.clock.now().toISOString());
  assert.equal(approvals.inbox(as('lead')).length, 0);

  const queue = executions.list(as('op1'), { tab: 'queue' });
  assert.equal(queue.length, 1);
  const execId = queue[0].execution.id;
  executions.claim(as('op1'), execId);
  assert.equal(requests.core.getRow(draft.id).status, 'executing');
  for (const d of requests.core.documentsOf(draft.id)) executions.recordDocument(as('op1'), execId, d.id, { status: 'done', hashVerified: true });
  executions.complete(as('op1'), execId, { message: 'all done' });

  const done = requests.core.getRow(draft.id);
  assert.equal(done.status, 'completed');
  assert.ok(done.completed_at);
  assert.deepEqual(actions(s, draft.id), [
    'request.created', 'request.submitted', 'approval.approved', 'request.approved', 'execution.queued',
    'execution.claimed', 'execution.document_recorded', 'execution.document_recorded', 'execution.completed',
  ]);
  assert.equal(s.audit.verify().ok, true);
});

test('submission pins what was approved in the audit trail', async () => {
  const s = await setup();
  const row = submitted(s, s.org, 'alice', { documents: [doc('plan.docx', 'internal')] });
  const entry = s.audit.forRequest(row.id).find((e) => e.action === 'request.submitted');
  assert.equal(entry.details.number, row.number);
  assert.equal(entry.details.documents[0].name, 'plan.docx');
  assert.match(entry.details.documents[0].sha256, /^[0-9a-f]{64}$/);
  assert.match(entry.details.contentHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(entry.details.stages.map((st) => st.assignees), [['Lead']]);
});

test('submission checks the content against the policy', async () => {
  const s = await setup();
  const { requests, as } = s;
  const errorsFor = (overrides, ack = true) =>
    fieldErrors(() => {
      const draft = requests.createDraft(as('alice'), content(overrides));
      requests.submit(as('alice'), draft.id, { acknowledged: ack });
    });

  assert.deepEqual(errorsFor({ title: '', justification: 'short', documents: [] }), ['documents:required', 'justification:too_short', 'title:required']);
  assert.deepEqual(errorsFor({}, false), ['acknowledged:required']);
  assert.deepEqual(errorsFor({ documents: [doc('x.docx', 'secret')] }), ['documents[0].labelId:label_not_releasable']);
  assert.deepEqual(errorsFor({ documents: [doc('x.docx', 'general')] }), ['documents[0].labelId:label_not_protected'], 'nothing to remove on an unprotected label');
  assert.deepEqual(errorsFor({ documents: [doc('x.docx', null)] }), ['documents[0].labelId:required']);
  assert.deepEqual(errorsFor({ documents: [doc('same.docx'), doc('same.docx')] }), ['documents[1]:duplicate_document']);
  assert.deepEqual(errorsFor({ external: true }), ['recipients:required']);
  assert.deepEqual(errorsFor({ reasonId: 'external_partner' }), ['recipients:required'], 'an external reason makes the request external');
  assert.deepEqual(errorsFor({ external: true, recipients: [{ organization: '', email: 'not-an-email' }] }), ['recipients[0].email:invalid_email'], 'malformed input is caught before business rules');
  assert.deepEqual(errorsFor({ external: true, recipients: [{ organization: '' }] }), ['recipients[0].organization:required']);
  assert.deepEqual(errorsFor({ dueDate: '2020-01-01' }), ['dueDate:date_in_past']);

  // Label changes need a lower target.
  assert.deepEqual(errorsFor({ action: 'change_label' }), ['targetLabelId:required']);
  assert.deepEqual(errorsFor({ action: 'change_label', targetLabelId: 'confidential' }), ['documents[0].labelId:target_not_lower']);
  assert.deepEqual(errorsFor({ action: 'change_label', targetLabelId: 'general' }), []);

  // Granting access needs someone to grant it to, with an address.
  assert.deepEqual(errorsFor({ action: 'grant_access' }), ['recipients:required']);
  assert.deepEqual(errorsFor({ action: 'grant_access', recipients: [{ organization: 'Partner' }] }), ['recipients[0].email:required']);
  assert.deepEqual(errorsFor({ action: 'grant_access', recipients: [{ organization: 'Partner', email: 'a@partner.example' }] }), []);
});

test('drafts accept incomplete content but never malformed content', async () => {
  const s = await setup();
  const { requests, as } = s;
  assert.equal(requests.createDraft(as('alice'), {}).status, 'draft');
  assert.deepEqual(fieldErrors(() => requests.createDraft(as('alice'), { action: 'make_it_public' })), ['action:unknown_action']);
  assert.deepEqual(fieldErrors(() => requests.createDraft(as('alice'), { documents: [{ name: 'x', labelId: 'nope', sha256: 'zz' }] })), [
    'documents[0].labelId:unknown_label', 'documents[0].sha256:invalid_hash',
  ]);
  assert.deepEqual(fieldErrors(() => requests.createDraft(as('alice'), { title: 'x'.repeat(121) })), ['title:too_long']);
  const many = Array.from({ length: 31 }, (_, i) => doc(`f${i}.docx`));
  assert.deepEqual(fieldErrors(() => requests.createDraft(as('alice'), { documents: many })), ['documents:too_many']);
  // Control characters are dropped rather than stored.
  const row = requests.createDraft(as('alice'), { title: 'Budget\u0000 plan\r\nfor Q3' });
  assert.equal(row.title, 'Budget plan for Q3');
});

test('location rules from the policy are enforced', async () => {
  const s = await setup();
  const { requests, policy, as } = s;
  const pol = JSON.parse(JSON.stringify(policy.current().policy));
  pol.rules.requireLocation = true;
  pol.rules.requireHash = true;
  pol.rules.locationPrefixes = ['https://files.example/'];
  policy.save(as('sec1'), pol, {});
  const errorsFor = (document) => {
    const draft = requests.createDraft(as('alice'), content({ documents: [document] }));
    return fieldErrors(() => requests.submit(as('alice'), draft.id, { acknowledged: true }));
  };
  assert.deepEqual(errorsFor(doc('ok.docx')), []);
  assert.deepEqual(errorsFor(doc('a.docx', 'internal', { location: '' })), ['documents[0].location:required']);
  assert.deepEqual(errorsFor(doc('b.docx', 'internal', { location: 'C:\\Users\\me\\b.docx' })), ['documents[0].location:location_not_allowed']);
  assert.deepEqual(errorsFor(doc('c.docx', 'internal', { location: 'HTTPS://FILES.EXAMPLE/x', sha256: null })), ['documents[0].sha256:required']);
});

test('a rejection ends the request', async () => {
  const s = await setup();
  const { approvals, requests, as } = s;
  const row = submitted(s, s.org);
  assert.deepEqual(fieldErrors(() => approvals.decide(as('lead'), row.id, { decision: 'reject' })), ['comment:required']);
  const rejected = approvals.decide(as('lead'), row.id, { decision: 'reject', comment: 'Not needed for this purpose' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.status_reason, 'Not needed for this purpose');
  assert.ok(rejected.closed_at);
  assert.equal(codeOf(() => approvals.decide(as('lead'), row.id, { decision: 'approve' })), 'stage_not_active');
  assert.equal(codeOf(() => requests.cancel(as('alice'), row.id, {})), 'not_cancellable');
  assert.equal(s.executions.list(as('op1'), { tab: 'queue' }).length, 0);
});

test('a returned request can be corrected and goes through a fresh route', async () => {
  const s = await setup();
  const { approvals, requests, as } = s;
  const row = submitted(s, s.org, 'alice', { documents: [doc('spec.docx', 'confidential')] });
  assert.equal(row.route_id, 'confidential');
  approvals.decide(as('lead'), row.id, { decision: 'approve' });
  const returned = approvals.decide(as('sec1'), row.id, { decision: 'return', comment: 'Please name the recipient' });
  assert.equal(returned.status, 'returned');
  assert.equal(codeOf(() => approvals.decide(as('sec2'), row.id, { decision: 'approve' })), 'stage_not_active');

  // Nobody but the requester may edit, and only while it is returned.
  assert.equal(codeOf(() => requests.updateDraft(as('bob'), row.id, content())), 'request_not_found');
  requests.updateDraft(as('alice'), row.id, content({
    documents: [doc('spec.docx', 'confidential')], external: true, recipients: [{ organization: 'Partner Ltd' }], version: returned.version,
  }));
  const again = requests.submit(as('alice'), row.id, { acknowledged: true });
  assert.equal(again.status, 'pending');
  assert.equal(again.number, row.number, 'the number stays the same');
  assert.equal(again.revision, 2);
  assert.equal(again.route_id, 'confidential-external', 'the route follows the new content');
  assert.equal(again.submitted_at, row.submitted_at, 'lead time counts from the first submission');

  const detail = requests.detail(as('alice'), row.id);
  assert.deepEqual(detail.stages.map((st) => st.status), ['active', 'waiting', 'waiting']);
  assert.deepEqual(detail.previousStages.map((st) => st.status), ['approved', 'returned']);
  // Approvals from the earlier round do not carry over.
  assert.equal(approvals.inbox(as('lead')).length, 1);
  assert.equal(approvals.inbox(as('sec1')).length, 0);
});

test('stale edits are refused', async () => {
  const s = await setup();
  const { requests, as } = s;
  const draft = requests.createDraft(as('alice'), content());
  requests.updateDraft(as('alice'), draft.id, content({ title: 'First edit', version: draft.version }));
  assert.equal(codeOf(() => requests.updateDraft(as('alice'), draft.id, content({ title: 'Second edit', version: draft.version }))), 'stale_version');
  assert.equal(requests.core.getRow(draft.id).title, 'First edit');
});

test('nobody approves their own request, and no role is a shortcut', async () => {
  const s = await setup();
  const { approvals, as } = s;
  // lead asks; the approver is head.
  const row = submitted(s, s.org, 'lead');
  assert.equal(codeOf(() => approvals.decide(as('lead'), row.id, { decision: 'approve' })), 'own_request');
  for (const login of ['adm', 'sec1', 'aud', 'op1', 'bob']) {
    const code = codeOf(() => approvals.decide(as(login), row.id, { decision: 'approve' }));
    assert.ok(['not_approver', 'request_not_found'].includes(code), `${login} must not be able to approve (got ${code})`);
  }
  assert.equal(approvals.decide(as('head'), row.id, { decision: 'approve' }).status, 'approved');
});

test('one person cannot approve two stages of the same request', async () => {
  const s = await setup();
  const { approvals, policy, users, as, org } = s;
  // head is both the senior manager and, here, a security officer.
  users.update(SYSTEM_ACTOR, org.ids.head, { roles: ['requester', 'approver', 'security'] });
  const row = submitted(s, org, 'alice', {
    documents: [doc('spec.docx', 'confidential')], external: true, recipients: [{ organization: 'Partner Ltd' }],
  });
  approvals.decide(as('lead'), row.id, { decision: 'approve' });
  approvals.decide(as('head'), row.id, { decision: 'approve' });
  assert.equal(codeOf(() => approvals.decide(as('head'), row.id, { decision: 'approve' })), 'approved_earlier_stage');
  assert.equal(approvals.inbox(as('head')).length, 0, 'it is not offered to them either');
  assert.equal(approvals.decide(as('sec1'), row.id, { decision: 'approve' }).status, 'approved');

  // With the rule switched off the same person may sign again.
  const pol = JSON.parse(JSON.stringify(policy.current().policy));
  pol.rules.distinctApprovers = false;
  policy.save(as('sec1'), pol, {});
  const second = submitted(s, org, 'alice', {
    documents: [doc('other.docx', 'confidential')], external: true, recipients: [{ organization: 'Partner Ltd' }],
  });
  approvals.decide(as('lead'), second.id, { decision: 'approve' });
  approvals.decide(as('head'), second.id, { decision: 'approve' });
  assert.equal(approvals.decide(as('head'), second.id, { decision: 'approve' }).status, 'approved');
});

test('a stage can require more than one approval', async () => {
  const s = await setup();
  const { approvals, policy, as } = s;
  const pol = JSON.parse(JSON.stringify(policy.current().policy));
  pol.routes.find((r) => r.id === 'confidential').stages[1].minApprovals = 2;
  policy.save(as('sec1'), pol, {});
  const row = submitted(s, s.org, 'alice', { documents: [doc('spec.docx', 'confidential')] });
  approvals.decide(as('lead'), row.id, { decision: 'approve' });
  assert.equal(approvals.decide(as('sec1'), row.id, { decision: 'approve' }).status, 'pending');
  assert.equal(codeOf(() => approvals.decide(as('sec1'), row.id, { decision: 'approve' })), 'already_decided');
  assert.equal(approvals.decide(as('sec2'), row.id, { decision: 'approve' }).status, 'approved');
});

test('a delegate decides in the approver\'s seat, once, and only while the delegation runs', async () => {
  const s = await setup();
  const { approvals, requests, as, org, clock } = s;
  const row = submitted(s, org);
  assert.equal(codeOf(() => approvals.decide(as('carol'), row.id, { decision: 'approve' })), 'request_not_found');

  approvals.createDelegation(as('lead'), {
    toUserId: org.ids.carol,
    startsAt: clock.now().toISOString(),
    endsAt: new Date(clock.now().getTime() + 3 * 86400_000).toISOString(),
    reason: 'Leave',
  });
  const inbox = approvals.inbox(as('carol'));
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].actingFor[0].name, 'Lead');
  assert.equal(requests.detail(as('carol'), row.id).number, row.number, 'the delegate can read what they must decide');

  assert.equal(approvals.decide(as('carol'), row.id, { decision: 'approve', comment: 'On behalf of lead' }).status, 'approved');
  const decision = requests.detail(as('alice'), row.id).stages[0].decisions[0];
  assert.equal(decision.approver.name, 'Carol');
  assert.equal(decision.onBehalfOf.name, 'Lead');
  const entry = s.audit.forRequest(row.id).find((e) => e.action === 'approval.approved');
  assert.equal(entry.details.onBehalfOf.name, 'Lead');

  // The seat is used: lead cannot add a second approval on the same stage of a new request either way.
  const second = submitted(s, org, 'bob');
  approvals.decide(as('carol'), second.id, { decision: 'approve' });
  assert.equal(codeOf(() => approvals.decide(as('lead'), second.id, { decision: 'approve' })), 'stage_not_active');

  // After the delegation ends the delegate has no say.
  const third = submitted(s, org, 'bob', { title: 'Third' });
  clock.advance({ days: 4 });
  assert.equal(approvals.inbox(as('carol')).length, 0);
  assert.equal(codeOf(() => approvals.decide(as('carol'), third.id, { decision: 'approve' })), 'request_not_found');
  assert.equal(approvals.decide(as('lead'), third.id, { decision: 'approve' }).status, 'approved');
});

test('delegation rules', async () => {
  const s = await setup();
  const { approvals, as, org, clock } = s;
  const inDays = (n) => new Date(clock.now().getTime() + n * 86400_000).toISOString();
  assert.deepEqual(fieldErrors(() => approvals.createDelegation(as('lead'), { toUserId: org.ids.lead, endsAt: inDays(2) })), ['toUserId:cannot_delegate_to_self']);
  assert.deepEqual(fieldErrors(() => approvals.createDelegation(as('lead'), { toUserId: org.ids.bob, endsAt: inDays(-1) })), ['endsAt:date_in_past']);
  assert.deepEqual(fieldErrors(() => approvals.createDelegation(as('lead'), { toUserId: org.ids.bob, endsAt: inDays(60) })), ['endsAt:delegation_too_long']);
  assert.equal(codeOf(() => approvals.createDelegation(as('bob'), { fromUserId: org.ids.lead, toUserId: org.ids.bob, endsAt: inDays(2) })), 'cannot_delegate_for_others');

  const created = approvals.createDelegation(as('lead'), { toUserId: org.ids.bob, endsAt: inDays(2) });
  assert.equal(created.state, 'active');
  assert.equal(codeOf(() => approvals.createDelegation(as('lead'), { toUserId: org.ids.bob, endsAt: inDays(1) })), 'delegation_overlap');

  // A delegate still cannot decide on their own request.
  const own = submitted(s, org, 'bob');
  assert.equal(codeOf(() => approvals.decide(as('bob'), own.id, { decision: 'approve' })), 'own_request');

  // An administrator can set one up for someone who is away, and anyone can end their own.
  assert.equal(approvals.createDelegation(as('adm'), { fromUserId: org.ids.head, toUserId: org.ids.lead, endsAt: inDays(2) }).from.name, 'Head');
  assert.equal(codeOf(() => approvals.revokeDelegation(as('carol'), created.id)), 'not_found');
  assert.equal(approvals.revokeDelegation(as('lead'), created.id).state, 'revoked');
  assert.equal(codeOf(() => approvals.decide(as('bob'), submitted(s, org, 'alice').id, { decision: 'approve' })), 'request_not_found');
});

test('an open stage can be reassigned, with a reason, but never to the requester', async () => {
  const s = await setup();
  const { approvals, requests, as, org } = s;
  const row = submitted(s, org);
  const stageId = requests.detail(as('alice'), row.id).stages[0].id;
  assert.equal(codeOf(() => approvals.reassign(as('lead'), row.id, stageId, { userIds: [org.ids.head], reason: 'I am away' })), 'forbidden');
  assert.deepEqual(fieldErrors(() => approvals.reassign(as('sec1'), row.id, stageId, { userIds: [org.ids.head], reason: '' })), ['reason:required']);
  assert.deepEqual(fieldErrors(() => approvals.reassign(as('sec1'), row.id, stageId, { userIds: [org.ids.alice], reason: 'Manager has left' })), ['userIds:requester_cannot_approve']);

  approvals.reassign(as('sec1'), row.id, stageId, { userIds: [org.ids.head], reason: 'Manager has left the company' });
  // The former approver is no longer involved, so the request is out of their sight too.
  assert.equal(codeOf(() => approvals.decide(as('lead'), row.id, { decision: 'approve' })), 'request_not_found');
  assert.equal(approvals.inbox(as('head')).length, 1);
  const entry = s.audit.forRequest(row.id).find((e) => e.action === 'approval.reassigned');
  assert.deepEqual([entry.details.from, entry.details.to], [['Lead'], ['Head']]);
  assert.equal(approvals.decide(as('head'), row.id, { decision: 'approve' }).status, 'approved');
  assert.equal(codeOf(() => approvals.reassign(as('sec1'), row.id, stageId, { userIds: [org.ids.lead], reason: 'Too late now' })), 'stage_not_open');
});

test('who can see a request', async () => {
  const s = await setup();
  const { requests, approvals, executions, as, org } = s;
  const draft = requests.createDraft(as('alice'), content());
  const canRead = (login, id) => codeOf(() => requests.detail(as(login), id)) === null;

  // Drafts are private, even from privileged roles.
  assert.deepEqual(['alice', 'lead', 'sec1', 'aud', 'adm', 'op1'].map((l) => canRead(l, draft.id)), [true, false, false, false, false, false]);

  requests.submit(as('alice'), draft.id, { acknowledged: true });
  assert.deepEqual(['alice', 'lead', 'bob', 'carol', 'head', 'sec1', 'aud', 'adm', 'op1'].map((l) => canRead(l, draft.id)),
    [true, true, false, false, false, true, true, true, false]);

  approvals.decide(as('lead'), draft.id, { decision: 'approve' });
  assert.equal(canRead('op1', draft.id), true, 'operators see what they have to carry out');
  assert.equal(canRead('lead', draft.id), true, 'approvers keep access to what they decided');

  // Lists follow the same rules.
  assert.equal(requests.list(as('alice'), { scope: 'mine' }).total, 1);
  assert.equal(requests.list(as('bob'), { scope: 'mine' }).total, 0);
  assert.equal(requests.list(as('lead'), { scope: 'involved' }).total, 1);
  assert.equal(requests.list(as('aud'), { scope: 'all' }).total, 1);
  assert.equal(codeOf(() => requests.list(as('bob'), { scope: 'all' })), 'scope_not_allowed');
  assert.equal(executions.list(as('op1'), { tab: 'queue' }).length, 1);
  assert.equal(codeOf(() => executions.list(as('alice'), { tab: 'queue' })), 'not_operator');
});

test('list filters and search', async () => {
  const s = await setup();
  const { requests, approvals, as, org } = s;
  const a = submitted(s, org, 'alice', { title: 'Alpha migration notes', reasonId: 'migration', documents: [doc('alpha.docx')] });
  submitted(s, org, 'alice', { title: 'Beta contract', documents: [doc('beta.docx', 'confidential')], external: true, recipients: [{ organization: 'Partner Ltd' }] });
  submitted(s, org, 'bob', { title: 'Gamma handover', reasonId: 'handover', documents: [doc('gamma.docx')] });
  approvals.decide(as('lead'), a.id, { decision: 'approve' });
  const titles = (filters) => requests.list(as('aud'), { scope: 'all', sort: 'oldest', ...filters }).items.map((r) => r.title.split(' ')[0]);
  assert.deepEqual(titles({}), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(titles({ status: 'approved' }), ['Alpha']);
  assert.deepEqual(titles({ status: 'pending,approved' }), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(titles({ labelId: 'confidential' }), ['Beta']);
  assert.deepEqual(titles({ external: 'true' }), ['Beta']);
  assert.deepEqual(titles({ reasonId: 'handover' }), ['Gamma']);
  assert.deepEqual(titles({ requesterId: org.ids.bob }), ['Gamma']);
  assert.deepEqual(titles({ q: 'contract' }), ['Beta']);
  assert.deepEqual(titles({ q: 'gamma.docx' }), ['Gamma'], 'document names are searched');
  assert.deepEqual(titles({ q: 'REL-2026-00001' }), ['Alpha']);
  assert.deepEqual(titles({ q: 'Bob' }), ['Gamma'], 'requester names are searched');
  assert.deepEqual(titles({ q: '100%_' }), [], 'wildcards in the query are literal');
  assert.deepEqual(requests.statusCounts(as('aud'), { scope: 'all' }), { approved: 1, pending: 2 });
  const page = requests.list(as('aud'), { scope: 'all', pageSize: 2, page: 2, sort: 'oldest' });
  assert.deepEqual([page.total, page.items.length], [3, 1]);
});

test('cancelling', async () => {
  const s = await setup();
  const { requests, approvals, executions, as, org } = s;
  const row = submitted(s, org);
  assert.equal(codeOf(() => requests.cancel(as('bob'), row.id, { reason: 'Not mine' })), 'request_not_found');
  assert.equal(codeOf(() => requests.cancel(as('lead'), row.id, { reason: 'I would rather not' })), 'cannot_cancel');
  assert.equal(requests.cancel(as('alice'), row.id, {}).status, 'cancelled');
  assert.equal(approvals.inbox(as('lead')).length, 0);

  // An officer can stop a request but must say why.
  const second = submitted(s, org);
  assert.deepEqual(fieldErrors(() => requests.cancel(as('sec1'), second.id, {})), ['reason:required']);
  assert.equal(requests.cancel(as('sec1'), second.id, { reason: 'Duplicate of an earlier request' }).status, 'cancelled');

  // Approved but not started: the work order goes away with it.
  const third = submitted(s, org);
  approvals.decide(as('lead'), third.id, { decision: 'approve' });
  requests.cancel(as('alice'), third.id, { reason: 'No longer needed' });
  assert.equal(executions.list(as('op1'), { tab: 'queue' }).length, 0);
  assert.equal(executions.latestFor(third.id).status, 'cancelled');

  // Once an operator has started, the requester can no longer pull it.
  const fourth = submitted(s, org);
  approvals.decide(as('lead'), fourth.id, { decision: 'approve' });
  executions.claim(as('op1'), executions.latestFor(fourth.id).id);
  assert.equal(codeOf(() => requests.cancel(as('alice'), fourth.id, {})), 'not_cancellable');
});

test('execution: separation of duties, partial results and retry', async () => {
  const s = await setup();
  const { requests, approvals, executions, as, org, clock } = s;
  // op1 is also a requester; they may not carry out their own request.
  const own = submitted(s, org, 'op1');
  approvals.decide(as('sec1'), own.id, { decision: 'approve' });
  assert.equal(codeOf(() => executions.claim(as('op1'), executions.latestFor(own.id).id)), 'operator_is_requester');
  assert.equal(executions.claim(as('op2'), executions.latestFor(own.id).id).status, 'claimed');

  const row = submitted(s, org, 'alice', { documents: [doc('one.docx'), doc('two.docx'), doc('three.docx')] });
  approvals.decide(as('lead'), row.id, { decision: 'approve' });
  const exec = executions.latestFor(row.id);
  const [d1, d2, d3] = requests.core.documentsOf(row.id);

  assert.equal(codeOf(() => executions.recordDocument(as('op1'), exec.id, d1.id, { status: 'done' })), 'execution_not_claimed');
  executions.claim(as('op1'), exec.id);
  assert.equal(codeOf(() => executions.claim(as('op2'), exec.id)), 'execution_not_claimable');
  assert.equal(codeOf(() => executions.recordDocument(as('op2'), exec.id, d1.id, { status: 'done' })), 'not_your_execution');
  assert.deepEqual(fieldErrors(() => executions.recordDocument(as('op1'), exec.id, d1.id, { status: 'failed' })), ['note:required']);

  executions.recordDocument(as('op1'), exec.id, d1.id, { status: 'done', hashVerified: true });
  assert.equal(codeOf(() => executions.complete(as('op1'), exec.id, {})), 'documents_pending');
  executions.recordDocument(as('op1'), exec.id, d2.id, { status: 'failed', note: 'File not found at the location' });
  executions.recordDocument(as('op1'), exec.id, d3.id, { status: 'skipped', note: 'Already unprotected' });
  executions.complete(as('op1'), exec.id, {});
  assert.equal(requests.core.getRow(row.id).status, 'partial');
  assert.equal(executions.getExec(exec.id).status, 'partial');

  // Retry reopens only what did not succeed.
  const retry = executions.retry(as('op2'), exec.id);
  assert.equal(retry.attempt, 2);
  assert.equal(requests.core.getRow(row.id).status, 'approved');
  assert.deepEqual(requests.core.documentsOf(row.id).map((d) => d.exec_status), ['done', 'pending', 'pending']);
  executions.claim(as('op2'), retry.id);
  executions.recordDocument(as('op2'), retry.id, d2.id, { status: 'done' });
  executions.recordDocument(as('op2'), retry.id, d3.id, { status: 'done' });
  executions.complete(as('op2'), retry.id, {});
  assert.equal(requests.core.getRow(row.id).status, 'completed');
  assert.equal(codeOf(() => executions.retry(as('op2'), retry.id)), 'execution_not_retryable');

  // Nothing done at all is a failure, and a retry needs a still-valid approval.
  const failing = submitted(s, org, 'bob');
  approvals.decide(as('lead'), failing.id, { decision: 'approve' });
  const fexec = executions.latestFor(failing.id);
  executions.claim(as('op1'), fexec.id);
  executions.recordDocument(as('op1'), fexec.id, requests.core.documentsOf(failing.id)[0].id, { status: 'failed', note: 'Access denied by the file server' });
  executions.complete(as('op1'), fexec.id, {});
  assert.equal(requests.core.getRow(failing.id).status, 'failed');
  clock.advance({ days: 8 });
  assert.equal(codeOf(() => executions.retry(as('op1'), fexec.id)), 'approval_expired');
});

test('an operator can hand work back, and optional rules tighten execution', async () => {
  const s = await setup();
  const { requests, approvals, executions, policy, as, org } = s;
  const row = submitted(s, org);
  approvals.decide(as('lead'), row.id, { decision: 'approve' });
  const exec = executions.latestFor(row.id);
  executions.claim(as('op1'), exec.id);
  executions.release(as('op1'), exec.id);
  assert.equal(requests.core.getRow(row.id).status, 'approved');
  assert.equal(executions.list(as('op2'), { tab: 'queue' }).length, 1);

  const pol = JSON.parse(JSON.stringify(policy.current().policy));
  pol.rules.requireHash = true;
  pol.rules.operatorMustDifferFromApprovers = true;
  policy.save(as('sec1'), pol, {});
  executions.claim(as('op2'), exec.id);
  const [d] = requests.core.documentsOf(row.id);
  assert.deepEqual(fieldErrors(() => executions.recordDocument(as('op2'), exec.id, d.id, { status: 'done' })), ['hashVerified:hash_verification_required']);
  executions.recordDocument(as('op2'), exec.id, d.id, { status: 'done', hashVerified: true });

  // sec1 approves a request and, being given the operator role, still may not carry it out.
  s.users.update(SYSTEM_ACTOR, org.ids.sec1, { roles: ['requester', 'security', 'operator'] });
  const other = submitted(s, org, 'carol');
  approvals.decide(as('sec1'), other.id, { decision: 'approve' });
  assert.equal(codeOf(() => executions.claim(as('sec1'), executions.latestFor(other.id).id)), 'operator_is_approver');
});

test('the sweeper reminds, expires stale requests and expires unused approvals', async () => {
  const s = await setup();
  const { requests, approvals, executions, sweeper, notifier, as, org, clock } = s;
  const waiting = submitted(s, org, 'alice', { title: 'Waiting' });
  assert.deepEqual(sweeper.run(), { overdue: 0, expiredWaiting: 0, expiredApprovals: 0 });

  clock.advance({ hours: 49 });
  assert.equal(requests.detail(as('alice'), waiting.id).stages[0].overdue, true);
  const before = notifier.unreadCount(org.ids.lead);
  assert.equal(sweeper.run().overdue, 1);
  assert.equal(sweeper.run().overdue, 0, 'one reminder per stage');
  assert.equal(notifier.unreadCount(org.ids.lead), before + 1);
  assert.ok(s.audit.forRequest(waiting.id).some((e) => e.action === 'approval.overdue' && e.actorType === 'system'));

  const approvedRow = submitted(s, org, 'bob', { title: 'Approved' });
  approvals.decide(as('lead'), approvedRow.id, { decision: 'approve' });
  clock.advance({ days: 8 });
  const result = sweeper.run();
  assert.equal(result.expiredApprovals, 1);
  const expired = requests.core.getRow(approvedRow.id);
  assert.deepEqual([expired.status, expired.status_reason], ['expired', 'approval_validity']);
  assert.equal(executions.latestFor(approvedRow.id).status, 'cancelled');
  assert.equal(codeOf(() => executions.claim(as('op1'), executions.latestFor(approvedRow.id).id)), 'execution_not_claimable');

  clock.advance({ days: 25 });
  assert.equal(sweeper.run().expiredWaiting, 1);
  const stale = requests.core.getRow(waiting.id);
  assert.deepEqual([stale.status, stale.status_reason], ['expired', 'no_activity']);
  assert.equal(codeOf(() => approvals.decide(as('lead'), waiting.id, { decision: 'approve' })), 'stage_not_active');
  assert.equal(s.audit.verify().ok, true);
});

test('route preview, duplicate warnings and cloning', async () => {
  const s = await setup();
  const { requests, as, org } = s;
  const preview = requests.previewRoute(as('alice'), content({ documents: [doc('spec.docx', 'confidential')], external: true }));
  assert.equal(preview.route.id, 'confidential-external');
  assert.deepEqual(preview.stages.map((st) => st.assignees.map((u) => u.name)), [['Lead'], ['Head'], ['Sec1', 'Sec2']]);
  assert.equal(requests.previewRoute(as('alice'), { title: 'only a title' }).ready, false);
  // A problem with the route is reported, not thrown: the form shows it inline.
  assert.equal(requests.previewRoute(as('sec2'), content({ external: true })).error.code, 'approvers_overlap');

  const first = submitted(s, org, 'alice', { documents: [doc('shared.docx')] });
  const warned = requests.previewRoute(as('bob'), content({ documents: [doc('shared.docx')] }));
  assert.deepEqual(warned.warnings, [{ code: 'document_in_open_request', index: 0, number: first.number }]);

  const copy = requests.clone(as('alice'), first.id);
  assert.equal(copy.status, 'draft');
  assert.equal(copy.number, null);
  assert.equal(requests.core.documentsOf(copy.id)[0].name, 'shared.docx');
  assert.equal(codeOf(() => requests.clone(as('lead'), first.id)), 'not_your_request');
});

test('comments reach the people involved and drafts can be deleted', async () => {
  const s = await setup();
  const { requests, notifier, as, org } = s;
  const row = submitted(s, org);
  const before = notifier.unreadCount(org.ids.alice);
  requests.addComment(as('lead'), row.id, 'Which meeting is this for?');
  assert.equal(notifier.unreadCount(org.ids.alice), before + 1);
  assert.equal(codeOf(() => requests.addComment(as('bob'), row.id, 'Me too')), 'request_not_found');
  assert.deepEqual(fieldErrors(() => requests.addComment(as('alice'), row.id, '   ')), ['body:required']);
  assert.equal(requests.detail(as('alice'), row.id).comments[0].body, 'Which meeting is this for?');

  const draft = requests.createDraft(as('alice'), content());
  assert.equal(codeOf(() => requests.deleteDraft(as('bob'), draft.id)), 'request_not_found');
  assert.equal(codeOf(() => requests.deleteDraft(as('alice'), row.id)), 'not_editable');
  assert.deepEqual(requests.deleteDraft(as('alice'), draft.id), { deleted: true });
  assert.equal(requests.core.getRow(draft.id), null);
});

test('request numbers count up per year and CSV export is spreadsheet-safe', async () => {
  const s = await setup();
  const { requests, as, org, clock } = s;
  const first = submitted(s, org, 'alice', { title: '=HYPERLINK("http://evil.example")' });
  const second = submitted(s, org, 'bob');
  assert.deepEqual([first.number, second.number], ['REL-2026-00001', 'REL-2026-00002']);
  clock.advance({ days: 320 });
  assert.equal(submitted(s, org, 'bob', { title: 'Next year' }).number, 'REL-2027-00001');

  const csv = requests.exportCsv(as('aud'), { scope: 'all' });
  assert.ok(csv.startsWith('\uFEFFnumber,status,title'), 'starts with a BOM so Excel reads UTF-8');
  assert.ok(csv.includes('"\'=HYPERLINK(""http://evil.example"")"'), 'formula cells are neutralised');
  assert.ok(s.audit.query({ action: 'request.exported' }).items.length === 1);
});

test('users without the requester role cannot file requests', async () => {
  const s = await setup();
  assert.equal(codeOf(() => s.requests.createDraft(s.as('aud'), content())), 'cannot_create_requests');
});

test('carbon copies are told when a request is approved and can read it', async () => {
  const s = await setup();
  const { requests, approvals, policy, notifier, as, org } = s;
  const pol = JSON.parse(JSON.stringify(policy.current().policy));
  pol.routes.find((r) => r.id === 'default').cc = [{ type: 'users', userIds: [org.ids.carol] }];
  policy.save(as('sec1'), pol, {});
  const row = submitted(s, org);
  assert.equal(codeOf(() => requests.detail(as('carol'), row.id)), null);
  const before = notifier.unreadCount(org.ids.carol);
  approvals.decide(as('lead'), row.id, { decision: 'approve' });
  assert.equal(notifier.unreadCount(org.ids.carol), before + 1);
  assert.equal(notifier.list(org.ids.carol)[0].type, 'request_approved_cc');
});
