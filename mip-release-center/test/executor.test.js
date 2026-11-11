import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signPayload } from '../server/outbox.js';
import { makeApp, makeOrg, serve, doc, submitted, codeOf } from './helpers.js';

const SECRET = 'a-shared-secret-of-enough-length';
const EXEC_URL = 'https://executor.example/jobs';

/** A stand-in for the organisation's executor endpoint. */
function fakeEndpoint() {
  const calls = [];
  const state = { fail: false, response: { externalRef: 'JOB-77' } };
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body, json: JSON.parse(init.body) });
    if (state.fail) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return new Response(JSON.stringify(state.response), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, state, fetchImpl };
}

async function setupWebhook() {
  const endpoint = fakeEndpoint();
  const ctx = makeApp({ executorWebhookUrl: EXEC_URL, executorWebhookSecret: SECRET, baseUrl: 'https://release.example' }, { fetchImpl: endpoint.fetchImpl });
  const org = await makeOrg(ctx);
  const { policy } = ctx.services;
  const pol = structuredClone(policy.current().policy);
  pol.executor.mode = 'webhook';
  pol.labels.find((l) => l.id === 'internal').externalId = '11111111-2222-3333-4444-555555555555';
  policy.save(org.as('sec1'), pol, {});
  return { ...ctx, ...ctx.services, org, as: org.as, endpoint };
}

function approvedRequest(s, overrides) {
  const row = submitted(s, s.org, 'alice', overrides);
  s.approvals.decide(s.as('lead'), row.id, { decision: 'approve' });
  return row;
}

function callback(s, execId, body, { secret = SECRET, timestamp } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(timestamp ?? Math.floor(s.clock.now().getTime() / 1000));
  return s.executions.handleCallback(execId, Buffer.from(raw), { 'x-mrc-timestamp': ts, 'x-mrc-signature': signPayload(secret, ts, raw) }, '198.51.100.4');
}

test('an approved request is handed to the executor with a verifiable signature', async () => {
  const s = await setupWebhook();
  const row = approvedRequest(s, { documents: [doc('a.docx'), doc('b.docx')] });
  const exec = s.executions.latestFor(row.id);
  assert.deepEqual([exec.mode, exec.status], ['webhook', 'dispatching']);
  assert.equal(s.requests.core.getRow(row.id).status, 'approved', 'not executing until the hand-over succeeded');
  assert.equal(s.endpoint.calls.length, 0, 'nothing is sent inside the approval transaction');

  await s.outbox.drain();
  assert.equal(s.endpoint.calls.length, 1);
  const call = s.endpoint.calls[0];
  assert.equal(call.url, EXEC_URL);
  assert.equal(call.headers['X-MRC-Event'], 'execution.dispatch');
  assert.equal(call.headers['X-MRC-Signature'], signPayload(SECRET, call.headers['X-MRC-Timestamp'], call.body));
  assert.equal(call.json.executionId, exec.id);
  assert.equal(call.json.callbackUrl, `https://release.example/api/executions/${exec.id}/callback`);
  assert.equal(call.json.request.number, row.number);
  assert.equal(call.json.request.action, 'remove_protection');
  assert.deepEqual(call.json.documents.map((d) => d.name), ['a.docx', 'b.docx']);
  assert.equal(call.json.documents[0].label.externalId, '11111111-2222-3333-4444-555555555555');
  assert.match(call.json.documents[0].sha256, /^[0-9a-f]{64}$/);

  const running = s.executions.latestFor(row.id);
  assert.deepEqual([running.status, running.external_ref], ['running', 'JOB-77']);
  assert.equal(s.requests.core.getRow(row.id).status, 'executing');
  await s.outbox.drain();
  assert.equal(s.endpoint.calls.length, 1, 'delivered once');
});

test('the executor reports results through a signed callback', async () => {
  const s = await setupWebhook();
  const row = approvedRequest(s, { documents: [doc('a.docx'), doc('b.docx')] });
  await s.outbox.drain();
  const exec = s.executions.latestFor(row.id);
  const [a, b] = s.requests.core.documentsOf(row.id);

  assert.equal(codeOf(() => callback(s, exec.id, { documents: [] }, { secret: 'the-wrong-secret-entirely-000' })), 'invalid_signature');
  const stale = Math.floor(s.clock.now().getTime() / 1000) - 3600;
  assert.equal(codeOf(() => callback(s, exec.id, { documents: [] }, { timestamp: stale })), 'invalid_signature');
  assert.equal(codeOf(() => callback(s, 'exe_missing', { documents: [] })), 'execution_not_found');

  const progress = callback(s, exec.id, { documents: [{ id: a.id, status: 'done', sha256: a.sha256 }] });
  assert.deepEqual(progress, { ok: true, final: false, status: 'running' });
  assert.equal(s.requests.core.getRow(row.id).status, 'executing');

  const final = callback(s, exec.id, { documents: [{ id: b.id, status: 'done' }], message: 'released to the outbound folder' });
  assert.deepEqual(final, { ok: true, final: true, status: 'succeeded' });
  assert.equal(s.requests.core.getRow(row.id).status, 'completed');
  const docs = s.requests.core.documentsOf(row.id);
  assert.deepEqual(docs.map((d) => [d.exec_status, d.exec_hash_verified]), [['done', 1], ['done', null]]);
  assert.deepEqual(callback(s, exec.id, { documents: [] }), { ok: true, ignored: true, status: 'succeeded' }, 'late repeats are harmless');
  const entry = s.audit.forRequest(row.id).find((e) => e.action === 'execution.completed');
  assert.deepEqual([entry.actorType, entry.actorLabel, entry.ip], ['system', 'executor', '198.51.100.4']);
});

test('a result for a different file than the approved one never counts as done', async () => {
  const s = await setupWebhook();
  const row = approvedRequest(s, { documents: [doc('a.docx'), doc('b.docx')] });
  await s.outbox.drain();
  const exec = s.executions.latestFor(row.id);
  const [a, b] = s.requests.core.documentsOf(row.id);
  callback(s, exec.id, {
    final: true,
    documents: [{ id: a.id, status: 'done', sha256: 'f'.repeat(64) }, { id: 'doc_from_another_request', status: 'done' }],
  });
  const docs = s.requests.core.documentsOf(row.id);
  assert.deepEqual(docs.map((d) => d.exec_status), ['failed', 'failed']);
  assert.match(docs[0].exec_note, /^hash mismatch/);
  assert.equal(docs[1].exec_note, 'no result reported');
  assert.equal(docs[1].id, b.id);
  assert.equal(s.requests.core.getRow(row.id).status, 'failed');
});

test('delivery is retried with backoff and gives up cleanly', async () => {
  const s = await setupWebhook();
  s.endpoint.state.fail = true;
  const row = approvedRequest(s);
  const exec = s.executions.latestFor(row.id);
  await s.outbox.drain();
  assert.equal(s.endpoint.calls.length, 1);
  await s.outbox.drain();
  assert.equal(s.endpoint.calls.length, 1, 'waits for the backoff before trying again');
  assert.equal(s.db.get('SELECT last_error FROM outbox').last_error, 'ECONNREFUSED');

  for (let i = 0; i < 8; i += 1) {
    s.clock.advance({ hours: 4 });
    await s.outbox.drain();
  }
  assert.equal(s.endpoint.calls.length, 6, 'six attempts in all');
  assert.equal(s.executions.getExec(exec.id).status, 'failed');
  assert.match(s.executions.getExec(exec.id).message, /^dispatch failed/);
  assert.equal(s.requests.core.getRow(row.id).status, 'failed');
  assert.ok(s.audit.forRequest(row.id).some((e) => e.action === 'execution.dispatch_failed'));
  assert.deepEqual(s.outbox.stats(), { pending: 0, delivered: 0, failed: 1 });

  // The approval is still valid, so an operator can send it again once the endpoint is back.
  s.endpoint.state.fail = false;
  const retried = s.executions.retry(s.as('op1'), exec.id);
  assert.equal(retried.attempt, 2);
  await s.outbox.drain();
  assert.equal(s.executions.getExec(retried.id).status, 'running');
  assert.equal(s.endpoint.calls.at(-1).json.attempt, 2);
});

test('an operator can take over an execution the endpoint never finished', async () => {
  const s = await setupWebhook();
  const row = approvedRequest(s);
  await s.outbox.drain();
  const exec = s.executions.latestFor(row.id);
  const claimed = s.executions.claim(s.as('op1'), exec.id);
  assert.equal(claimed.status, 'claimed');
  assert.ok(s.audit.forRequest(row.id).some((e) => e.action === 'execution.taken_over'));
  const [d] = s.requests.core.documentsOf(row.id);
  // A callback that arrives afterwards is ignored rather than overriding the operator.
  assert.deepEqual(callback(s, exec.id, { final: true, documents: [{ id: d.id, status: 'failed', note: 'late' }] }), { ok: true, ignored: true, status: 'claimed' });
  s.executions.recordDocument(s.as('op1'), exec.id, d.id, { status: 'done' });
  s.executions.complete(s.as('op1'), exec.id, {});
  assert.equal(s.requests.core.getRow(row.id).status, 'completed');
});

test('cancelling before hand-over stops the delivery', async () => {
  const s = await setupWebhook();
  const row = approvedRequest(s);
  s.requests.cancel(s.as('alice'), row.id, { reason: 'changed my mind' });
  await s.outbox.drain();
  assert.equal(s.endpoint.calls.length, 0);
  assert.equal(s.executions.latestFor(row.id).status, 'cancelled');
});

test('the callback endpoint over HTTP needs no session but does need the signature', async (t) => {
  const s = await setupWebhook();
  const server = await serve(s);
  t.after(server.close);
  const row = approvedRequest(s);
  await s.outbox.drain();
  const exec = s.executions.latestFor(row.id);
  const [d] = s.requests.core.documentsOf(row.id);
  const raw = JSON.stringify({ final: true, documents: [{ id: d.id, status: 'done' }] });
  const ts = String(Math.floor(s.clock.now().getTime() / 1000));
  const c = server.client();
  const unsigned = await c.post(`/api/executions/${exec.id}/callback`, raw);
  assert.deepEqual([unsigned.status, unsigned.json.error.code], [401, 'invalid_signature']);
  const tampered = await c.post(`/api/executions/${exec.id}/callback`, raw.replace('done', 'skip'), { 'X-MRC-Timestamp': ts, 'X-MRC-Signature': signPayload(SECRET, ts, raw) });
  assert.equal(tampered.status, 401);
  const ok = await c.post(`/api/executions/${exec.id}/callback`, raw, { 'X-MRC-Timestamp': ts, 'X-MRC-Signature': signPayload(SECRET, ts, raw) });
  assert.deepEqual([ok.status, ok.json], [200, { ok: true, final: true, status: 'succeeded' }]);
  assert.equal(s.requests.core.getRow(row.id).status, 'completed');
});

test('without an executor secret the callback endpoint does not exist', async () => {
  const ctx = makeApp();
  assert.equal(codeOf(() => ctx.services.executions.handleCallback('exe_x', Buffer.from('{}'), {}, null)), 'not_found');
});

test('the policy cannot select an executor the deployment has not configured', async () => {
  const ctx = makeApp();
  const org = await makeOrg(ctx);
  const pol = structuredClone(ctx.services.policy.current().policy);
  pol.executor.mode = 'webhook';
  assert.equal(codeOf(() => ctx.services.policy.save(org.as('sec1'), pol, {})), 'validation_failed');
  pol.executor.mode = 'simulate';
  assert.equal(codeOf(() => ctx.services.policy.save(org.as('sec1'), pol, {})), 'validation_failed');
});

test('demo mode can simulate execution without touching anything', async () => {
  const ctx = makeApp({ demo: true });
  const org = await makeOrg(ctx);
  const { policy, approvals, requests, executions } = ctx.services;
  const pol = structuredClone(policy.current().policy);
  pol.executor.mode = 'simulate';
  policy.save(org.as('sec1'), pol, {});
  const row = submitted(ctx, org);
  approvals.decide(org.as('lead'), row.id, { decision: 'approve' });
  assert.equal(requests.core.getRow(row.id).status, 'completed');
  assert.equal(requests.core.documentsOf(row.id)[0].exec_note, 'simulated');
  assert.equal(executions.latestFor(row.id).mode, 'simulate');
  const entry = ctx.services.audit.forRequest(row.id).find((e) => e.action === 'execution.completed');
  assert.equal(entry.details.simulated, true);
});

test('notifications are copied to the notification webhook when one is configured', async () => {
  const endpoint = fakeEndpoint();
  const ctx = makeApp({ notifyWebhookUrl: 'https://hooks.example/notify', notifyWebhookSecret: 'notify-secret', baseUrl: 'https://release.example' }, { fetchImpl: endpoint.fetchImpl });
  const org = await makeOrg(ctx);
  const row = submitted(ctx, org);
  await ctx.services.outbox.drain();
  assert.equal(endpoint.calls.length, 1);
  const call = endpoint.calls[0];
  assert.equal(call.url, 'https://hooks.example/notify');
  assert.equal(call.json.event, 'approval_requested');
  assert.deepEqual(call.json.recipients.map((r) => r.login), ['lead']);
  assert.equal(call.json.request.url, `https://release.example/#/requests/${row.id}`);
  assert.equal(call.headers['X-MRC-Signature'], signPayload('notify-secret', call.headers['X-MRC-Timestamp'], call.body));
  // In-app notifications exist either way.
  assert.equal(ctx.services.notifier.list(org.ids.lead)[0].type, 'approval_requested');
});
