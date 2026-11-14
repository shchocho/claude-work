// 서버와 화면이 함께 쓰는 코드값. 화면 쪽 사본은 web/js/lib/consts.js 에 있다.

export const LABELS = {
  general: { id: 'general', name: '일반', en: 'General', rank: 1 },
  confidential: { id: 'confidential', name: '대외비', en: 'Confidential', rank: 2 },
  highly: { id: 'highly', name: '극비', en: 'Highly Confidential', rank: 3 },
};

export const CHANNELS = {
  gw: 'G/W',
  media: '외부저장매체',
  pmail: '개인메일계정',
};

export const MEDIA_TYPES = { usb: 'USB', cd: 'CD', dvd: 'DVD', hdd: '외장 HDD' };

export const RECIPIENT_TYPES = {
  customer: 'Customer',
  gov: '정부 및 공공기관',
  vendor: 'Vendor',
  other: '기타',
};

export const REVIEW_STATUSES = {
  pending: '미검토',
  ok: '적정',
  flagged: '소명 요청',
};

export const DEMO_USERS = [
  { id: 'u-kim', name: '김서연', dept: '영업1팀', title: '책임', email: 'seoyeon.kim@hanbit.example', role: 'user' },
  { id: 'u-park', name: '박준호', dept: '구매팀', title: '선임', email: 'junho.park@hanbit.example', role: 'user' },
  { id: 'u-lee', name: '이지은', dept: '정보보호팀', title: '책임', email: 'jieun.lee@hanbit.example', role: 'auditor' },
];
