import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { createSidecarAdapter } from '../server/mip/sidecar-adapter.js';
import { getSample } from '../server/samples.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

function frame(meta, file = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(meta), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([length, json, file]);
}

/** 쿠키를 들고 다니는 간단한 API 클라이언트. */
function client(base) {
  let cookie = '';
  async function call(method, url, body, headers = {}) {
    const response = await fetch(base + url, {
      method,
      headers: { ...(method === 'GET' ? {} : { 'x-mrc-client': '1' }), ...(cookie ? { cookie } : {}), ...headers },
      body,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  }
  return {
    login: (userId) => call('POST', '/api/session', JSON.stringify({ userId })),
    get: (url) => call('GET', url),
    json: async (url) => (await call('GET', url)).json(),
    post: (url, body, headers) => call('POST', url, body, headers),
    postJson: (url, body) => call('POST', url, JSON.stringify(body)),
  };
}

const RELEASE_META = {
  recipientType: 'customer',
  recipientName: 'ACME Corp. 구매팀',
  reason: '4분기 공급 견적 제출 요청에 따라 견적서를 전달합니다.',
  acks: [true, true, true],
};

describe('문서 해지 센터 API', () => {
  let app;
  let base;
  let kim;
  let park;
  let auditor;

  before(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrc-test-'));
    app = createApp({ dataDir });
    base = `http://127.0.0.1:${await listen(app.server)}`;
    kim = client(base);
    park = client(base);
    auditor = client(base);
    await kim.login('u-kim');
    await park.login('u-park');
    await auditor.login('u-lee');
  });

  after(async () => {
    await app.close();
    fs.rmSync(app.config.dataDir, { recursive: true, force: true });
  });

  async function sampleFile(id) {
    const response = await kim.get(`/api/samples/${id}`);
    assert.equal(response.status, 200);
    return Buffer.from(await response.arrayBuffer());
  }

  async function releaseSample(who, id = 'quote', meta = RELEASE_META) {
    const file = await sampleFile(id);
    const fileName = `${getSample(id).fileName}.pfile`;
    return who.post('/api/releases', frame({ ...meta, fileName }, file));
  }

  test('로그인하지 않으면 업무 API를 쓸 수 없다', async () => {
    const anonymous = client(base);
    assert.equal((await anonymous.get('/api/releases')).status, 401);
    assert.equal((await anonymous.json('/api/session')).user, null);
  });

  test('전용 헤더가 없는 상태 변경 요청은 거부한다', async () => {
    const response = await fetch(`${base}/api/session`, { method: 'POST', body: JSON.stringify({ userId: 'u-kim' }) });
    assert.equal(response.status, 403);
  });

  test('정적 파일은 웹 폴더 밖으로 나가지 못한다', async () => {
    const response = await fetch(`${base}/..%2Fpackage.json`);
    assert.equal(response.status, 404);
    assert.match((await fetch(`${base}/`)).headers.get('content-security-policy'), /default-src 'self'/);
  });

  test('보호 문서를 검사하면 등급과 해제 권한을 알려준다', async () => {
    const file = await sampleFile('quote');
    const info = await (await kim.post('/api/inspect', frame({ fileName: 'ACME_견적서_2026Q4.pdf.pfile' }, file))).json();
    assert.equal(info.protected, true);
    assert.equal(info.labelId, 'confidential');
    assert.equal(info.canUnprotect, true);
    assert.equal(info.originalName, 'ACME_견적서_2026Q4.pdf');

    const plain = await (await kim.post('/api/inspect', frame({ fileName: 'memo.txt' }, Buffer.from('hello')))).json();
    assert.equal(plain.protected, false);
  });

  test('자가 승인 후 해제하면 원본이 복원되고 해제 기록이 남는다', async () => {
    const response = await releaseSample(kim);
    assert.equal(response.status, 201);
    const { release } = await response.json();
    assert.match(release.code, /^REL-\d{6}-\d{3}$/);
    assert.equal(release.user.name, '김서연');
    assert.equal(release.fileName, 'ACME_견적서_2026Q4.pdf');
    assert.equal(release.status, 'ready');

    const download = await kim.get(`/api/releases/${release.id}/file`);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.deepEqual(bytes, getSample('quote').buffer);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), release.fileSha256);
    assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''ACME_%EA%B2%AC/);

    // 다른 사용자는 남의 해제 파일을 받을 수 없다.
    assert.equal((await park.get(`/api/releases/${release.id}/file`)).status, 404);
  });

  test('자가 승인 항목과 사유가 빠지면 해제하지 않는다', async () => {
    assert.equal((await releaseSample(kim, 'quote', { ...RELEASE_META, acks: [true, true, false] })).status, 400);
    assert.equal((await releaseSample(kim, 'quote', { ...RELEASE_META, reason: '짧음' })).status, 400);
  });

  test('권한이 없는 문서와 보호되지 않은 파일은 해제를 거부한다', async () => {
    const denied = await releaseSample(kim, 'hr');
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'NO_RIGHTS');

    const plain = await kim.post('/api/releases', frame({ ...RELEASE_META, fileName: 'memo.txt' }, Buffer.from('hello')));
    assert.equal(plain.status, 422);
  });

  test('헤더를 조작한 보호 파일은 복호화에 실패한다', async () => {
    const file = await sampleFile('hr');
    // 컨테이너 헤더의 권한 목록을 "누구나"로 바꾸고 길이 필드까지 맞춰 넣는다.
    const headerLength = file.readUInt32BE(8);
    const header = JSON.parse(file.subarray(12, 12 + headerLength).toString('utf8'));
    const forged = Buffer.from(JSON.stringify({ ...header, allowedUsers: '*' }), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(forged.length);
    const tampered = Buffer.concat([file.subarray(0, 8), length, forged, file.subarray(12 + headerLength)]);
    const response = await kim.post('/api/releases', frame({ ...RELEASE_META, fileName: 'x.csv.pfile' }, tampered));
    assert.equal(response.status, 502);
  });

  test('세 가지 송부 수단으로 보내면 송부 기록과 파일 원본이 저장된다', async () => {
    const { release } = await (await releaseSample(kim)).json();
    const send = (meta, file) => kim.post('/api/transfers', frame({ clientId: crypto.randomUUID(), releaseId: release.id, ...meta }, file));

    const media = await send({ channel: 'media', detail: { mediaType: 'usb', mediaTag: 'SEC-USB-0001' } });
    assert.equal(media.status, 201);
    const mediaBody = (await media.json()).transfer;
    assert.equal(mediaBody.hashMatch, true);
    assert.equal(mediaBody.capturedOffline, false);
    assert.equal(mediaBody.user.name, '김서연');

    const gw = await send({ channel: 'gw', detail: { to: ['buyer@acme.example'], subject: '견적서 송부', body: '첨부 확인 바랍니다.' } });
    assert.equal(gw.status, 201);
    const gwBody = (await gw.json()).transfer;
    const eml = fs.readFileSync(path.join(app.config.dataDir, 'outbox', `${gwBody.detail.messageId}.eml`), 'utf8');
    assert.match(eml, /To: buyer@acme\.example/);

    const pmail = await send({ channel: 'pmail', detail: { address: 'someone@naver.com' } });
    assert.equal(pmail.status, 201);

    const corp = await send({ channel: 'pmail', detail: { address: 'me@hanbit.example' } });
    assert.equal(corp.status, 400);

    const { releases } = await kim.json('/api/releases');
    const mine = releases.find((r) => r.id === release.id);
    assert.equal(mine.status, 'sent');
    assert.equal(mine.transfers.length, 3);
  });

  test('오프라인 기록은 PC 시각으로 저장되고 같은 요청을 두 번 받아도 한 건만 남는다', async () => {
    const { release } = await (await releaseSample(park, 'price', { ...RELEASE_META, recipientType: 'vendor', recipientName: '대성정공' })).json();
    const sentAt = new Date().toISOString();
    const meta = {
      clientId: crypto.randomUUID(), releaseId: release.id, channel: 'media',
      detail: { mediaType: 'usb', mediaTag: '' }, capturedOffline: true, sentAt,
    };
    const first = await park.post('/api/transfers', frame(meta, getSample('price').buffer));
    assert.equal(first.status, 201);
    const body = (await first.json()).transfer;
    assert.equal(body.capturedOffline, true);
    assert.equal(body.sentAt, sentAt);
    assert.equal(body.hashMatch, true);
    assert.ok(body.receivedAt >= body.sentAt);

    const again = await park.post('/api/transfers', frame(meta, getSample('price').buffer));
    assert.equal(again.status, 200);
    assert.equal((await again.json()).transfer.id, body.id);

    // 해제한 원본과 다른 파일을 보냈다면 불일치로 표시한다.
    const altered = await park.post('/api/transfers', frame({ ...meta, clientId: crypto.randomUUID() }, Buffer.from('다른 내용')));
    assert.equal((await altered.json()).transfer.hashMatch, false);

    // 메일은 서버가 보내므로 오프라인 기록이 될 수 없다.
    const mail = await park.post('/api/transfers', frame({ ...meta, clientId: crypto.randomUUID(), channel: 'pmail', detail: { address: 'a@naver.com' } }));
    assert.equal(mail.status, 400);

    // 남의 해제 건으로는 송부할 수 없다.
    const stolen = await kim.post('/api/transfers', frame({ ...meta, clientId: crypto.randomUUID() }));
    assert.equal(stolen.status, 404);
  });

  test('송부 가능 기간이 지난 해제 건은 송부할 수 없다', async () => {
    const sample = getSample('gov');
    const user = app.db.prepare('SELECT * FROM users WHERE id = ?').get('u-kim');
    const old = await app.services.createRelease(user, {
      meta: { ...RELEASE_META, fileName: `${sample.fileName}.pfile` },
      file: app.mock.protect(sample),
      now: new Date(Date.now() - 8 * 86_400_000),
    });
    const response = await kim.post('/api/transfers', frame({
      clientId: crypto.randomUUID(), releaseId: old.id, channel: 'media', detail: { mediaType: 'cd', mediaTag: '' },
    }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'EXPIRED');
  });

  test('감사 화면은 감사 담당자만 볼 수 있고 검토 결과가 기록된다', async () => {
    assert.equal((await kim.get('/api/audit/transfers')).status, 403);

    const { transfers } = await auditor.json('/api/audit/transfers?channel=media');
    assert.ok(transfers.length >= 2);
    assert.ok(transfers.every((t) => t.channel === 'media'));
    const mismatch = (await auditor.json('/api/audit/transfers?mismatch=1')).transfers;
    assert.equal(mismatch.length, 1);

    const target = transfers[0];
    const file = await auditor.get(`/api/audit/transfers/${target.id}/file`);
    assert.equal(file.status, 200);

    const needsNote = await auditor.postJson(`/api/audit/transfers/${target.id}/review`, { status: 'flagged', note: '' });
    assert.equal(needsNote.status, 400);
    const reviewed = await auditor.postJson(`/api/audit/transfers/${target.id}/review`, { status: 'flagged', note: '매체 관리번호를 소명해 주세요.' });
    assert.equal((await reviewed.json()).transfer.review.status, 'flagged');

    const stats = await auditor.json('/api/audit/stats');
    assert.equal(stats.flagged, 1);
    assert.equal(stats.daily.length, 14);
    assert.equal(stats.byChannel.reduce((sum, c) => sum + c.count, 0), stats.transfers);

    // 엑셀이 한글을 깨뜨리지 않도록 BOM으로 시작해야 한다. (text()는 BOM을 떼어 버리므로 바이트로 확인)
    const csvBytes = Buffer.from(await (await auditor.get('/api/audit/export.csv')).arrayBuffer());
    assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const csv = csvBytes.subarray(3).toString('utf8');
    assert.ok(csv.startsWith('"송부번호"'));
    assert.equal(csv.trim().split('\r\n').length, stats.transfers + 1);
  });

  test('감사 체인은 위·변조를 찾아낸다', async () => {
    const ok = await auditor.json('/api/audit/verify');
    assert.equal(ok.ok, true);
    assert.ok(ok.count > 10);

    const victim = app.db.prepare("SELECT seq, detail FROM audit_events WHERE action = 'transfer.created' LIMIT 1").get();
    app.db.prepare('UPDATE audit_events SET detail = ? WHERE seq = ?').run(victim.detail.replace('ACME', 'ACNE'), victim.seq);
    const broken = await auditor.json('/api/audit/verify');
    assert.equal(broken.ok, false);
    assert.equal(broken.brokenAt, victim.seq);
    app.db.prepare('UPDATE audit_events SET detail = ? WHERE seq = ?').run(victim.detail, victim.seq);
    assert.equal((await auditor.json('/api/audit/verify')).ok, true);
  });
});

describe('MIP 사이드카 어댑터', () => {
  test('검사와 해제를 사이드카 서비스에 위임한다', async () => {
    const seen = [];
    const sidecar = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ url: req.url, name: decodeURIComponent(req.headers['x-file-name']), email: req.headers['x-user-email'] });
        if (req.url === '/inspect') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ protected: true, supported: true, labelId: 'highly', canUnprotect: true, owner: 'owner@corp' }));
        } else if (Buffer.concat(chunks).toString() === 'deny') {
          res.statusCode = 403;
          res.end(JSON.stringify({ message: '권한이 없습니다.' }));
        } else {
          res.setHeader('content-type', 'application/pdf');
          res.setHeader('x-file-name', encodeURIComponent('계약서.pdf'));
          res.end(Buffer.from('PLAIN'));
        }
      });
    });
    const port = await listen(sidecar);
    try {
      const adapter = createSidecarAdapter({ url: `http://127.0.0.1:${port}/` });
      const user = { email: 'user@corp.example' };
      const info = await adapter.inspect({ buffer: Buffer.from('x'), fileName: '계약서.pdf', user });
      assert.equal(info.labelId, 'highly');
      const out = await adapter.unprotect({ buffer: Buffer.from('x'), fileName: '계약서.pdf', user });
      assert.equal(out.fileName, '계약서.pdf');
      assert.equal(out.buffer.toString(), 'PLAIN');
      assert.deepEqual(seen[0], { url: '/inspect', name: '계약서.pdf', email: 'user@corp.example' });
      await assert.rejects(adapter.unprotect({ buffer: Buffer.from('deny'), fileName: 'a', user }), /권한이 없습니다/);
    } finally {
      sidecar.close();
    }
  });
});
