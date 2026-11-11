// First-run setup: an administrator account for a new database and, in demo
// mode only, a sample organisation with requests in every state.
import { generatePassword } from './users.js';
import { SYSTEM_ACTOR } from './rbac.js';
import { sha256Hex } from './util.js';

export const DEMO_PASSWORD = 'Demo-2026-pass!';

const DEPARTMENTS = [
  ['rnd', '연구개발본부', null],
  ['platform', '플랫폼개발팀', 'rnd'],
  ['design', '제품설계팀', 'rnd'],
  ['sales', '영업본부', null],
  ['overseas', '해외영업팀', 'sales'],
  ['security', '정보보호실', null],
  ['itops', 'IT운영팀', null],
  ['auditing', '감사팀', null],
];

// login, name, title, department, roles, manager
export const DEMO_ACCOUNTS = [
  { login: 'admin', name: '시스템 관리자', title: '관리자', department: 'itops', roles: ['admin'], manager: null },
  { login: 'han.jiwon', name: '한지원', title: '연구개발본부장', department: 'rnd', roles: ['requester', 'approver'], manager: null },
  { login: 'park.minjun', name: '박민준', title: '플랫폼개발팀장', department: 'platform', roles: ['requester', 'approver'], manager: 'han.jiwon' },
  { login: 'kim.seoyeon', name: '김서연', title: '선임연구원', department: 'platform', roles: ['requester'], manager: 'park.minjun' },
  { login: 'lee.dohyun', name: '이도현', title: '연구원', department: 'platform', roles: ['requester'], manager: 'park.minjun' },
  { login: 'choi.yuna', name: '최유나', title: '제품설계팀장', department: 'design', roles: ['requester', 'approver'], manager: 'han.jiwon' },
  { login: 'jung.haeun', name: '정하은', title: '책임연구원', department: 'design', roles: ['requester'], manager: 'choi.yuna' },
  { login: 'oh.sejin', name: '오세진', title: '영업본부장', department: 'sales', roles: ['requester', 'approver'], manager: null },
  { login: 'yoon.taeyang', name: '윤태양', title: '해외영업팀장', department: 'overseas', roles: ['requester', 'approver'], manager: 'oh.sejin' },
  { login: 'kang.minseo', name: '강민서', title: '대리', department: 'overseas', roles: ['requester'], manager: 'yoon.taeyang' },
  { login: 'shin.jaehyun', name: '신재현', title: '정보보호실장', department: 'security', roles: ['requester', 'security'], manager: null },
  { login: 'lim.sua', name: '임수아', title: '보안담당', department: 'security', roles: ['requester', 'security'], manager: 'shin.jaehyun' },
  { login: 'seo.junho', name: '서준호', title: '실행 담당', department: 'itops', roles: ['requester', 'operator'], manager: null },
  { login: 'moon.jiho', name: '문지호', title: '실행 담당', department: 'itops', roles: ['requester', 'operator'], manager: null },
  { login: 'baek.eunji', name: '백은지', title: '감사역', department: 'auditing', roles: ['auditor'], manager: null },
];

/** Make sure a new database has someone who can sign in and set things up. */
export async function ensureAdmin(app, print = console.log) {
  const { users } = app.services;
  if (users.count() > 0 || app.config.authMode !== 'local') return null;
  const supplied = app.config.adminPassword;
  const { user, temporaryPassword } = await users.create(SYSTEM_ACTOR, {
    login: app.config.adminLogin,
    name: 'Administrator',
    roles: ['admin'],
    password: supplied || undefined,
    mustChangePassword: true,
  });
  if (temporaryPassword) {
    print('');
    print('  A first administrator account was created.');
    print(`    login:    ${user.login}`);
    print(`    password: ${temporaryPassword}`);
    print('  It is shown only this once and must be changed at first sign-in.');
    print('');
  }
  return user;
}

/** Sample organisation and requests. Only ever called for an empty database in demo mode. */
export async function seedDemo(app) {
  const { users, requests, approvals, executions, policy } = app.services;
  const { db, clock } = app;
  if (users.count() > 0) return false;

  const realNow = clock.now.bind(clock);
  const base = realNow().getTime();
  let offsetMs = 0;
  clock.now = () => new Date(base + offsetMs);
  // Moves the clock; events are written in order, each a little later than the last.
  const at = (daysAgo, hour = 10, minute = 0) => {
    const d = new Date(base - daysAgo * 86400_000);
    d.setHours(hour, minute, 0, 0);
    offsetMs = Math.min(d.getTime(), base - 60_000) - base;
  };
  const later = (minutes) => {
    offsetMs = Math.min(offsetMs + minutes * 60_000, -30_000);
  };

  try {
    at(120);
    const deptIds = {};
    for (const [key, name, parent] of DEPARTMENTS) {
      deptIds[key] = users.createDepartment(SYSTEM_ACTOR, { name, parentId: parent ? deptIds[parent] : null }).id;
    }
    const ids = {};
    for (const account of DEMO_ACCOUNTS) {
      const { user } = await users.create(SYSTEM_ACTOR, {
        login: account.login,
        name: account.name,
        title: account.title,
        email: `${account.login}@example.com`,
        departmentId: deptIds[account.department],
        managerId: account.manager ? ids[account.manager] : null,
        roles: account.roles,
        password: DEMO_PASSWORD,
      });
      ids[account.login] = user.id;
    }
    const as = (login) => users.principalFor(users.rowById(ids[login]), '10.0.0.' + (10 + DEMO_ACCOUNTS.findIndex((a) => a.login === login)));
    const doc = (name, labelId, location, sizeKb, note = '') => ({
      name, labelId, location, sizeBytes: sizeKb * 1024, sha256: sha256Hex(`${location}/${name}`), note,
    });
    const sp = 'https://example.sharepoint.com/sites';

    const make = (login, content, ack = true) => {
      const row = requests.createDraft(as(login), content);
      later(4);
      return requests.submit(as(login), row.id, { acknowledged: ack });
    };
    const approve = (login, id, comment = '') => {
      later(35);
      approvals.decide(as(login), id, { decision: 'approve', comment });
    };
    const runAll = (login, id, { failIndex = -1, note = '' } = {}) => {
      later(50);
      const exec = executions.latestFor(id);
      executions.claim(as(login), exec.id);
      requests.core.documentsOf(id).forEach((d, i) => {
        later(3);
        if (i === failIndex) executions.recordDocument(as(login), exec.id, d.id, { status: 'failed', note: note || '지정한 위치에서 파일을 찾을 수 없음' });
        else executions.recordDocument(as(login), exec.id, d.id, { status: 'done', hashVerified: true });
      });
      later(2);
      executions.complete(as(login), exec.id, { message: failIndex >= 0 ? '일부 문서는 위치 확인 후 다시 신청 필요' : '' });
    };

    // Events are written oldest first so the audit trail reads in time order.

    // Older completed requests so the reports have something to show.
    const fillers = [
      [82, 'lee.dohyun', 'internal', 'handover', 'remove_protection', false, 'park.minjun'],
      [76, 'kang.minseo', 'confidential', 'external_partner', 'grant_access', true, 'yoon.taeyang'],
      [70, 'jung.haeun', 'internal', 'archive', 'remove_protection', false, 'choi.yuna'],
      [63, 'kim.seoyeon', 'internal', 'compatibility', 'remove_protection', false, 'park.minjun'],
      [58, 'kang.minseo', 'internal', 'external_partner', 'remove_protection', true, 'yoon.taeyang'],
      [51, 'lee.dohyun', 'internal', 'migration', 'change_label', false, 'park.minjun'],
      [47, 'jung.haeun', 'confidential', 'regulatory', 'remove_protection', true, 'choi.yuna'],
      [40, 'kim.seoyeon', 'internal', 'mislabel', 'change_label', false, 'park.minjun'],
      [36, 'kang.minseo', 'confidential', 'external_partner', 'grant_access', true, 'yoon.taeyang'],
      [30, 'lee.dohyun', 'internal', 'handover', 'remove_protection', false, 'park.minjun'],
      [26, 'jung.haeun', 'internal', 'archive', 'remove_protection', false, 'choi.yuna'],
    ];
    const reasonTitle = { handover: '업무 인수인계 문서', external_partner: '협력사 제출 자료', archive: '보존 대상 문서', compatibility: '시스템 호환용 문서', migration: '이관 대상 문서', regulatory: '감독기관 제출 자료', mislabel: '레이블 정정 대상 문서' };
    fillers.forEach(([daysAgo, login, labelId, reasonId, action, external, manager], index) => {
      at(daysAgo, 9 + (index % 7), 10 + index);
      const account = DEMO_ACCOUNTS.find((a) => a.login === login);
      const row = make(login, {
        title: `${reasonTitle[reasonId]} ${String(index + 1).padStart(2, '0')}`,
        action,
        targetLabelId: action === 'change_label' ? 'general' : null,
        reasonId,
        justification: '정해진 업무 절차에 따라 필요한 문서이며, 사용 범위와 보관 위치를 팀 내에서 확인했습니다.',
        external,
        documents: [doc(`${reasonTitle[reasonId].replace(/ /g, '_')}_${index + 1}.docx`, labelId, `${sp}/${account.department}/archive`, 120 + index * 37)],
        recipients: external ? [{ organization: '협력사', name: '', email: action === 'grant_access' ? `contact${index}@partner.example` : '' }] : [],
      });
      // Walk whatever route the policy chose: each stage's first approver signs.
      for (let guard = 0; guard < 6; guard += 1) {
        const fresh = requests.core.getRow(row.id);
        if (fresh.status !== 'pending') break;
        const assignee = requests.core.assigneeIdsOf(fresh.current_stage_id)[0];
        const approver = DEMO_ACCOUNTS.find((a) => ids[a.login] === assignee)?.login ?? manager;
        approve(approver, row.id);
      }
      runAll(index % 2 ? 'seo.junho' : 'moon.jiho', row.id);
    });

    // Completed: confidential documents sent to a partner, three approvals.
    at(21, 9, 20);
    const r1 = make('kim.seoyeon', {
      title: '협력사 공동개발 설계 검토 자료 제출',
      action: 'remove_protection',
      reasonId: 'external_partner',
      justification: '3분기 공동개발 과제의 설계 검토 회의에 쓸 자료입니다. 협력사 검토 도구가 보호된 문서를 열지 못해 해제본이 필요합니다.',
      external: true,
      dueDate: null,
      documents: [
        doc('공동개발_인터페이스_정의서_v3.docx', 'confidential', `${sp}/platform/공동개발`, 842),
        doc('모듈_성능_측정_결과.xlsx', 'confidential', `${sp}/platform/공동개발`, 1260),
      ],
      recipients: [{ organization: '한빛시스템즈', name: '조은호 책임', email: 'eunho.cho@hanbit.example' }],
    });
    approve('park.minjun', r1.id, '공동개발 계약 범위 안의 자료임을 확인했습니다.');
    approve('han.jiwon', r1.id);
    approve('lim.sua', r1.id, 'NDA 체결 확인. 제출 후 원본은 계속 보호 상태로 둘 것.');
    runAll('seo.junho', r1.id);

    // Rejected by the manager.
    at(17, 14, 5);
    const r2 = make('yoon.taeyang', {
      title: '해외 대리점 가격 정책표 전달',
      action: 'remove_protection',
      reasonId: 'external_partner',
      justification: '신규 대리점 계약 협상을 앞두고 지역별 가격 정책표를 미리 공유하려고 합니다.',
      external: true,
      documents: [doc('2026_지역별_가격정책.xlsx', 'confidential', `${sp}/sales/가격`, 388)],
      recipients: [{ organization: 'Nordwind Trading', name: 'A. Lindqvist', email: 'a.lindqvist@nordwind.example' }],
    });
    later(90);
    approvals.decide(as('oh.sejin'), r2.id, { decision: 'reject', comment: '계약 체결 전에는 전체 가격표를 내보낼 수 없습니다. 해당 지역 요약본만 따로 만들어 다시 신청하세요.' });

    // Completed downgrade for a migration.
    at(14, 11, 0);
    const r3 = make('lee.dohyun', {
      title: '위키 이관 대상 운영 문서 레이블 하향',
      action: 'change_label',
      targetLabelId: 'general',
      reasonId: 'migration',
      justification: '사내 위키를 새 시스템으로 옮기면서 운영 가이드 문서를 일반 등급으로 내립니다. 내용 검토는 팀 내에서 마쳤습니다.',
      documents: [
        doc('배포_절차_가이드.docx', 'internal', `${sp}/platform/운영`, 210),
        doc('장애_대응_체크리스트.docx', 'internal', `${sp}/platform/운영`, 96),
        doc('온콜_인수인계_양식.docx', 'internal', `${sp}/platform/운영`, 64),
      ],
    });
    approve('park.minjun', r3.id);
    runAll('moon.jiho', r3.id);

    // Partly completed: one document could not be found.
    at(11, 10, 30);
    const r4 = make('jung.haeun', {
      title: '설계 표준서 장기 보존용 해제',
      action: 'remove_protection',
      reasonId: 'archive',
      justification: '폐기 예정 제품군의 설계 표준서를 기록 보존 시스템에 넣기 위한 해제입니다. 보존 시스템은 자체 접근 통제를 적용합니다.',
      documents: [
        doc('설계표준_STD-104.docx', 'internal', '\\\\fileserver\\design\\standards', 512),
        doc('설계표준_STD-105.docx', 'internal', '\\\\fileserver\\design\\standards', 498),
        doc('설계표준_STD-109.docx', 'internal', '\\\\fileserver\\design\\old', 530),
      ],
    });
    approve('choi.yuna', r4.id);
    runAll('seo.junho', r4.id, { failIndex: 2 });

    // Cancelled by the requester.
    at(9, 17, 0);
    const r10 = make('kim.seoyeon', {
      title: '세미나 발표 자료 해제',
      action: 'remove_protection',
      reasonId: 'other',
      justification: '외부 세미나 발표 자료로 쓰려고 했으나 발표 범위를 다시 정하는 중입니다.',
      documents: [doc('플랫폼_아키텍처_소개.pptx', 'internal', `${sp}/platform/발표`, 5400)],
    });
    later(200);
    requests.cancel(as('kim.seoyeon'), r10.id, { reason: '발표 자료를 공개용으로 새로 만들기로 했습니다.' });

    // Returned for more information by security.
    at(6, 15, 10);
    const r5 = make('kim.seoyeon', {
      title: '감독기관 제출용 시험 성적서',
      action: 'remove_protection',
      reasonId: 'regulatory',
      justification: '인증 갱신 심사에 필요한 시험 성적서를 감독기관 제출 포털에 올려야 합니다.',
      external: true,
      documents: [doc('전자파_적합성_시험성적서.docx', 'confidential', `${sp}/platform/인증`, 2210)],
      recipients: [{ organization: '국립전파연구원', name: '', email: '' }],
    });
    approve('park.minjun', r5.id);
    approve('han.jiwon', r5.id);
    later(120);
    approvals.decide(as('lim.sua'), r5.id, { decision: 'return', comment: '제출 포털의 접수 공문 번호와 제출 기한을 사유에 적어 주세요. 부록의 고객사 이름은 가린 판본인지도 확인이 필요합니다.' });

    // Pending and already past its deadline.
    at(4, 10, 0);
    make('jung.haeun', {
      title: '도면 관리 시스템 호환을 위한 해제',
      action: 'remove_protection',
      reasonId: 'compatibility',
      justification: '도면 관리 시스템이 보호된 첨부 파일을 미리보기로 열지 못합니다. 시스템 안에서는 프로젝트 권한으로만 접근됩니다.',
      documents: [doc('조립도_AS-88_주석.docx', 'internal', '\\\\fileserver\\design\\drawings', 3120)],
    });

    // Executing: an operator is half way through.
    at(3, 9, 40);
    const r6 = make('kang.minseo', {
      title: '수출 계약 부속 기술 사양서 제출',
      action: 'remove_protection',
      reasonId: 'external_partner',
      justification: '수출 계약서 부속 문서로 들어갈 기술 사양서입니다. 상대 법무팀이 문서 관리 시스템에 등록해야 해서 해제본을 요청했습니다.',
      external: true,
      documents: [
        doc('기술사양서_EX-2207_A.docx', 'internal', `${sp}/sales/계약/EX-2207`, 734),
        doc('기술사양서_EX-2207_B.docx', 'internal', `${sp}/sales/계약/EX-2207`, 690),
      ],
      recipients: [{ organization: 'Meridian Components', name: 'R. Okafor', email: 'r.okafor@meridian.example' }],
    });
    approve('yoon.taeyang', r6.id);
    approve('shin.jaehyun', r6.id, '수출 통제 대상 아님을 확인.');
    later(60);
    const exec6 = executions.latestFor(r6.id);
    executions.claim(as('moon.jiho'), exec6.id);
    later(6);
    executions.recordDocument(as('moon.jiho'), exec6.id, requests.core.documentsOf(r6.id)[0].id, { status: 'done', hashVerified: true });

    // A delegation that is active right now: 박민준 is away, 최유나 decides for him.
    at(2, 9, 0);
    approvals.createDelegation(as('park.minjun'), {
      toUserId: ids['choi.yuna'],
      startsAt: clock.now().toISOString(),
      endsAt: new Date(base + 5 * 86400_000).toISOString(),
      reason: '해외 출장',
    });

    // Approved and waiting for an operator.
    at(1, 13, 15);
    const r7 = make('lee.dohyun', {
      title: '빌드 서버 이관 문서 레이블 하향',
      action: 'change_label',
      targetLabelId: 'general',
      reasonId: 'migration',
      justification: '빌드 서버 교체에 맞춰 설정 문서를 새 저장소로 옮깁니다. 계정 정보가 들어 있지 않음을 확인했습니다.',
      documents: [
        doc('빌드_파이프라인_구성.docx', 'internal', `${sp}/platform/빌드`, 154),
        doc('아티팩트_보관_정책.docx', 'internal', `${sp}/platform/빌드`, 88),
      ],
    });
    approve('park.minjun', r7.id);

    // Pending at the second stage: granting access instead of removing protection.
    at(1, 16, 30);
    const r8 = make('kang.minseo', {
      title: '고객사 검토용 견적서 열람 권한',
      action: 'grant_access',
      reasonId: 'external_partner',
      justification: '견적서는 보호 상태로 두고 고객사 구매 담당자 두 명에게만 열람 권한을 추가하려고 합니다.',
      documents: [doc('견적서_Q-5521.docx', 'confidential', `${sp}/sales/견적`, 143)],
      recipients: [
        { organization: 'Meridian Components', name: 'R. Okafor', email: 'r.okafor@meridian.example' },
        { organization: 'Meridian Components', name: 'L. Hartmann', email: 'l.hartmann@meridian.example' },
      ],
    });
    approve('yoon.taeyang', r8.id, '보호를 유지하는 방식이라 적절합니다.');

    // Waiting for 박민준, so his delegate sees it in her inbox too.
    offsetMs = -5 * 3600_000;
    make('lee.dohyun', {
      title: '테스트 데이터셋 설명서 인수인계',
      action: 'remove_protection',
      reasonId: 'handover',
      justification: '담당자 변경으로 테스트 데이터셋 설명서를 넘깁니다. 인수자는 같은 본부 소속이며 사내 저장소에만 보관합니다.',
      documents: [doc('테스트_데이터셋_설명서.docx', 'internal', `${sp}/platform/테스트`, 410)],
    });

    // A draft that was never submitted.
    offsetMs = -3 * 3600_000;
    requests.createDraft(as('lee.dohyun'), {
      title: '신규 입사자 교육 자료',
      action: 'change_label',
      targetLabelId: 'general',
      reasonId: 'handover',
      justification: '',
      documents: [doc('온보딩_가이드.docx', 'internal', `${sp}/platform/교육`, 300)],
    });

    // Let the overdue reminder for the late request appear in its timeline.
    offsetMs = -60_000;
    app.services.sweeper.run();
    db.setMeta('demo_seeded_at', new Date(base).toISOString());
    return { users: DEMO_ACCOUNTS.length, policyVersion: policy.current().version };
  } finally {
    clock.now = realNow;
  }
}
