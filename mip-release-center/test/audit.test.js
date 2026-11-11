import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS_HASH } from '../server/audit.js';
import { canonicalJson, sha256Hex, toCsv } from '../server/util.js';
import { makeApp, makeOrg, submitted } from './helpers.js';

const actor = { type: 'user', id: 'usr_x', label: 'Tester <tester>', ip: '192.0.2.9' };

test('entries are chained from a fixed genesis hash', () => {
  const { services: { audit } } = makeApp();
  const first = audit.append(actor, 'test.one', { details: { b: 2, a: 1 } });
  const second = audit.append(actor, 'test.two', { entityType: 'thing', entityId: 't1', requestId: 'req_1' });
  assert.equal(first.seq, 1);
  assert.equal(first.prevHash, GENESIS_HASH);
  assert.equal(second.seq, 2);
  assert.equal(second.prevHash, first.hash);
  assert.notEqual(first.hash, second.hash);
  assert.deepEqual(audit.verify(), { ok: true, count: 2, headSeq: 2, headHash: second.hash });
});

test('the hash can be recomputed from an exported entry alone', () => {
  const { services: { audit } } = makeApp();
  audit.append(actor, 'test.one', { details: { nested: { z: 1, a: [3, 2, 1] }, text: '한글' } });
  const [entry] = audit.exportRows();
  const body = canonicalJson({
    seq: entry.seq, ts: entry.ts, actorType: entry.actorType, actorId: entry.actorId, actorLabel: entry.actorLabel, action: entry.action,
    entityType: entry.entityType, entityId: entry.entityId, requestId: entry.requestId, ip: entry.ip, details: entry.details,
  });
  assert.equal(sha256Hex(entry.prevHash + '\n' + body), entry.hash);
});

test('the database refuses to change or remove entries', () => {
  const { db, services: { audit } } = makeApp();
  audit.append(actor, 'test.one');
  assert.throws(() => db.run("UPDATE audit_log SET action = 'edited' WHERE seq = 1"), /append-only/);
  assert.throws(() => db.run('DELETE FROM audit_log WHERE seq = 1'), /append-only/);
  assert.equal(audit.verify().ok, true);
});

test('tampering behind the triggers is still detected', () => {
  const build = () => {
    const ctx = makeApp();
    for (let i = 0; i < 5; i += 1) ctx.services.audit.append(actor, 'test.step', { details: { i } });
    ctx.db.raw.exec('DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;');
    return ctx;
  };

  let ctx = build();
  ctx.db.raw.exec(`UPDATE audit_log SET details = '{"i":99}' WHERE seq = 3`);
  assert.deepEqual(pick(ctx.services.audit.verify()), { ok: false, brokenAt: 3, problem: 'entry_modified', count: 2 });

  ctx = build();
  ctx.db.raw.exec("UPDATE audit_log SET actor_label = 'Someone Else' WHERE seq = 1");
  assert.deepEqual(pick(ctx.services.audit.verify()), { ok: false, brokenAt: 1, problem: 'entry_modified', count: 0 });

  ctx = build();
  ctx.db.raw.exec('DELETE FROM audit_log WHERE seq = 2');
  assert.deepEqual(pick(ctx.services.audit.verify()), { ok: false, brokenAt: 3, problem: 'sequence_gap', count: 1 });

  ctx = build();
  ctx.db.raw.exec('DELETE FROM audit_log WHERE seq = 5');
  assert.equal(ctx.services.audit.verify().ok, true, 'cutting off the tail is only visible against a head hash kept elsewhere');
  assert.equal(ctx.services.audit.verify().count, 4);

  // Rewriting an entry together with its own hash still breaks the link from the next one.
  ctx = build();
  const row = ctx.db.get('SELECT * FROM audit_log WHERE seq = 2');
  ctx.db.raw.exec(`UPDATE audit_log SET hash = '${'f'.repeat(64)}' WHERE seq = 2`);
  const result = ctx.services.audit.verify();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 2);
  assert.ok(row.hash !== 'f'.repeat(64));
});

function pick(result) {
  return { ok: result.ok, brokenAt: result.brokenAt, problem: result.problem, count: result.count };
}

test('queries filter by family, actor, request and text, newest first', async () => {
  const ctx = makeApp();
  const org = await makeOrg(ctx);
  const { audit, approvals } = ctx.services;
  const row = submitted(ctx, org);
  approvals.decide(org.as('lead'), row.id, { decision: 'approve', comment: 'Fine by me' });

  const all = audit.query({});
  assert.ok(all.total >= 4);
  assert.ok(all.items[0].seq > all.items[1].seq, 'newest first by default');
  assert.deepEqual(audit.query({ action: 'approval.approved' }).items.map((e) => e.action), ['approval.approved']);
  assert.ok(audit.query({ action: 'request.' }).items.every((e) => e.action.startsWith('request.')));
  assert.ok(audit.query({ action: 'request.' }).items.length >= 3);
  assert.ok(audit.query({ actorId: org.ids.lead }).items.every((e) => e.actorId === org.ids.lead));
  assert.equal(audit.query({ requestId: row.id }).total, audit.forRequest(row.id).length);
  assert.equal(audit.query({ q: 'Fine by me' }).total, 1);
  assert.equal(audit.query({ q: '%' }).total, 0, 'wildcards are literal');

  const page = audit.query({ limit: 2, order: 'asc' });
  assert.deepEqual(page.items.map((e) => e.seq), [1, 2]);
  assert.equal(page.hasMore, true);
  const next = audit.query({ limit: 2, order: 'asc', afterSeq: 2 });
  assert.deepEqual(next.items.map((e) => e.seq), [3, 4]);
});

test('audit entries never contain passwords or token secrets', async () => {
  const ctx = makeApp();
  const org = await makeOrg(ctx);
  const { auth, users, audit } = ctx.services;
  const { secret } = auth.createToken(org.as('adm'), { name: 'SIEM', scopes: ['audit:read'] });
  const { temporaryPassword } = await users.resetPassword(org.as('adm'), org.ids.bob);
  await users.changeOwnPassword(org.as('alice'), 'Correct-Horse-42', 'Another-Good-Pass-77');
  const dump = JSON.stringify(audit.exportRows());
  for (const sensitive of [secret, temporaryPassword, 'Correct-Horse-42', 'Another-Good-Pass-77']) {
    assert.equal(dump.includes(sensitive), false);
  }
  assert.ok(dump.includes('token.created') && dump.includes('user.password_reset') && dump.includes('user.password_changed'));
});

test('CSV output escapes quotes, line breaks and formulas', () => {
  const csv = toCsv(
    [{ header: 'a', value: (r) => r.a }, { header: 'b', value: (r) => r.b }],
    [{ a: 'plain', b: 'with "quotes", commas' }, { a: '+1+1', b: 'two\nlines' }, { a: null, b: { x: 1 } }, { a: '@SUM(A1)', b: '-2' }],
  );
  assert.equal(csv, '﻿a,b\r\nplain,"with ""quotes"", commas"\r\n\'+1+1,"two\nlines"\r\n,"{""x"":1}"\r\n\'@SUM(A1),\'-2\r\n');
});
