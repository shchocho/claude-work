// 화면에서 쓰는 코드값과 문구. 서버 쪽 사본은 server/consts.js.

export const LABELS = {
  general: { name: '일반', en: 'General' },
  confidential: { name: '대외비', en: 'Confidential' },
  highly: { name: '극비', en: 'Highly Confidential' },
};

export const CHANNELS = {
  gw: {
    name: 'G/W',
    full: 'G/W (그룹웨어 메일)',
    icon: 'building',
    summary: '회사 메일로 사외 수신자에게 보냅니다.',
    needsServer: true,
  },
  media: {
    name: '외부저장매체',
    full: '외부저장매체 (USB, CD, DVD 등)',
    icon: 'usb',
    summary: 'USB, CD, DVD 같은 매체에 저장해 전달합니다.',
    needsServer: false,
  },
  pmail: {
    name: '개인메일계정',
    full: '개인메일계정 (Naver, Hotmail 등)',
    icon: 'mail',
    summary: '내 개인 메일 주소로 보냅니다.',
    needsServer: true,
  },
};

export const MEDIA_TYPES = { usb: 'USB', cd: 'CD', dvd: 'DVD', hdd: '외장 HDD' };

export const RECIPIENT_TYPES = {
  customer: 'Customer',
  gov: '정부 및 공공기관',
  vendor: 'Vendor',
  other: '기타',
};

export const REVIEW = {
  pending: { name: '미검토', tone: 'neutral' },
  ok: { name: '적정', tone: 'control' },
  flagged: { name: '소명 요청', tone: 'audit' },
};

export const RELEASE_STATUS = {
  ready: { name: '송부 대기', tone: 'channel' },
  sent: { name: '송부 완료', tone: 'control' },
  expired: { name: '기간 만료', tone: 'neutral' },
};

export const AUDIT_ACTIONS = {
  'session.login': '로그인',
  'release.created': '암호화 해제',
  'release.denied': '해제 거부 (권한 없음)',
  'release.file.fetched': '해제 파일을 PC로 받음',
  'transfer.created': '송부 기록',
  'transfer.synced': '오프라인 송부 기록 동기화',
  'transfer.reviewed': '송부 건 검토',
  'audit.file.downloaded': '감사자가 파일 원본 열람',
  'audit.exported': '송부 이력 내보내기',
  'audit.verified': '감사 체인 검증',
};

export const ACKS = [
  '업무에 필요한 최소 범위의 문서이며, 위에 적은 수신처에만 보냅니다.',
  '해제자, 해제 일시, 해제 파일 원본이 기록되고 감사 대상이 된다는 점을 확인했습니다.',
  '해제한 파일은 이 센터에 등록된 송부 수단(G/W, 외부저장매체, 개인메일계정)으로만 사외에 보냅니다.',
];
