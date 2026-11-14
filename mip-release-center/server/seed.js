import crypto from 'node:crypto';
import { getSample } from './samples.js';

// 데모용 이력. 실제 업무 로직(services)을 그대로 거치므로 감사 체인과 보관 파일이 모두 유효하다.
// `npm run demo` 로 시작했고 기록이 하나도 없을 때만 넣는다.

const DAY = 86_400_000;

export async function seedDemo(app, now = new Date()) {
  const { db, services, mock } = app;
  if (db.prepare('SELECT COUNT(*) AS n FROM releases').get().n > 0) return false;

  const users = Object.fromEntries(db.prepare('SELECT * FROM users').all().map((u) => [u.id, u]));
  const at = (daysAgo, hour, minute = 0) => {
    const d = new Date(now.getTime() - daysAgo * DAY);
    d.setHours(hour, minute, 0, 0);
    return d > now ? new Date(now.getTime() - 60_000) : d;
  };
  const protectedSample = (id) => {
    const sample = getSample(id);
    return { file: mock.protect(sample), fileName: `${sample.fileName}.pfile`, plain: sample.buffer };
  };

  async function release(userId, sampleId, when, recipientType, recipientName, reason) {
    const sample = protectedSample(sampleId);
    const result = await services.createRelease(users[userId], {
      meta: { fileName: sample.fileName, recipientType, recipientName, reason, acks: [true, true, true], device: 'Windows · Chrome' },
      file: sample.file,
      now: when,
    });
    return { ...result, plain: sample.plain };
  }

  async function transfer(userId, rel, when, channel, detail, extra = {}) {
    const { transfer: t } = await services.createTransfer(users[userId], {
      meta: {
        clientId: crypto.randomUUID(), releaseId: rel.id, channel, detail, device: 'Windows · Chrome',
        ...(extra.offline ? { capturedOffline: true, sentAt: when.toISOString() } : {}),
      },
      file: extra.file ?? (extra.offline ? rel.plain : undefined),
      now: extra.offline ? new Date(when.getTime() + (extra.syncDelayHours ?? 5) * 3_600_000) : when,
    });
    return t;
  }

  const r1 = await release('u-kim', 'quote', at(12, 10, 12), 'customer', 'ACME Corp. 구매팀', '4분기 공급 견적 제출 요청에 따라 최종 견적서를 고객사 구매 담당자에게 전달합니다.');
  const t1 = await transfer('u-kim', r1, at(12, 10, 20), 'gw', { to: ['purchasing@acme.example'], subject: '[한빛정밀] 2026년 4분기 견적서 송부', body: '요청하신 견적서를 첨부합니다.' });

  const r2 = await release('u-park', 'price', at(9, 14, 5), 'vendor', '대성정공', '2026년 단가 재협상 회의 자료로, 해당 협력사 품목 단가를 공유해야 합니다.');
  const t2 = await transfer('u-park', r2, at(9, 14, 30), 'media', { mediaType: 'usb', mediaTag: 'SEC-USB-0142' });

  const r3 = await release('u-kim', 'gov', at(6, 9, 40), 'gov', '산업기술평가관리원', '국책과제 사업계획서 초안을 전담기관 사전 검토용으로 제출합니다.');
  const t3 = await transfer('u-kim', r3, at(6, 9, 55), 'gw', { to: ['review@keit.example'], subject: '스마트제조 과제 사업계획서 초안 제출', body: '사전 검토 부탁드립니다.' });

  // 출장지에서 네트워크 없이 USB로 넘긴 건: PC에 먼저 기록되고 복귀 후 서버로 올라온다.
  const r4 = await release('u-park', 'price', at(4, 8, 30), 'vendor', '우림금속', '협력사 현장 실사에서 단가표를 오프라인으로 전달해야 합니다.');
  const t4 = await transfer('u-park', r4, at(4, 15, 10), 'media', { mediaType: 'usb', mediaTag: '' }, { offline: true, syncDelayHours: 19 });

  const r5 = await release('u-kim', 'quote', at(2, 17, 45), 'customer', 'ACME Corp. 구매팀', '고객사 담당자가 사외에서 급히 확인을 요청해 재택 중 개인 메일로 전달합니다.');
  const t5 = await transfer('u-kim', r5, at(2, 18, 2), 'pmail', { address: 'seoyeon.k@naver.com', body: '고객사 미팅 전 모바일 확인용' });

  // 해제한 원본과 다른 파일이 매체에 담긴 건(원본 불일치).
  const r6 = await release('u-park', 'price', at(1, 11, 0), 'vendor', '한일전자', '제어 보드 단가 협의를 위해 해당 품목 단가를 공유합니다.');
  const altered = Buffer.concat([r6.plain, Buffer.from('HB-9999,미등록 품목,한일전자,0,0,\n', 'utf8')]);
  await transfer('u-park', r6, at(1, 13, 20), 'media', { mediaType: 'hdd', mediaTag: '' }, { offline: true, file: altered, syncDelayHours: 3 });

  await release('u-kim', 'gov', at(0, 9, 5), 'gov', '중소벤처기업부', '과제 신청 마감 전 주무부처 담당 사무관에게 사업계획서를 제출합니다.');

  const auditor = users['u-lee'];
  services.reviewTransfer(auditor, t1.id, { status: 'ok', note: '' }, at(11, 9, 0));
  services.reviewTransfer(auditor, t2.id, { status: 'ok', note: '보안 USB 반출 대장과 일치' }, at(8, 9, 30));
  services.reviewTransfer(auditor, t3.id, { status: 'ok', note: '' }, at(5, 10, 0));
  services.reviewTransfer(auditor, t4.id, { status: 'flagged', note: '매체 관리번호가 없습니다. 사용한 USB의 관리번호를 소명해 주세요.' }, at(3, 11, 0));
  void t5;
  return true;
}
