// 체험용 샘플 문서. 모의 어댑터로 보호해서 내려준다.

const BOM = String.fromCharCode(0xfeff);

function simplePdf(lines) {
  const escape = (s) => s.replace(/[\\()]/g, '\\$&');
  const stream = ['BT', '/F1 12 Tf', '72 770 Td', '18 TL', ...lines.map((l) => `(${escape(l)}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const SAMPLES = [
  {
    id: 'quote',
    fileName: 'ACME_견적서_2026Q4.pdf',
    mime: 'application/pdf',
    labelId: 'confidential',
    owner: '영업1팀 김서연',
    protectedAt: '2026-10-28T02:14:00.000Z',
    allowedUsers: '*',
    hint: '고객사 제출용 견적서',
    build: () =>
      simplePdf([
        'HANBIT PRECISION - QUOTATION',
        'Quote No. HB-Q-2026-1042        Valid until 2026-12-31',
        'To: ACME Corp. Purchasing Team',
        '',
        'Item                         Qty      Unit Price      Amount',
        'Linear actuator LA-220       1,200    USD 84.00       USD 100,800',
        'Controller board CB-7        1,200    USD 31.50       USD 37,800',
        'On-site commissioning        1        USD 9,400       USD 9,400',
        '',
        'Total                                                 USD 148,000',
        '',
        'Sensitivity: Confidential (sample document for the release center demo)',
      ]),
  },
  {
    id: 'price',
    fileName: '협력사_부품단가표_2026.csv',
    mime: 'text/csv; charset=utf-8',
    labelId: 'highly',
    owner: '구매팀 박준호',
    protectedAt: '2026-11-02T05:40:00.000Z',
    allowedUsers: '*',
    hint: 'Vendor 공유용 단가표',
    build: () =>
      Buffer.from(
        `${BOM}품번,품명,협력사,단가(원),월 소요량,비고\n` +
          'HB-1101,알루미늄 하우징,대성정공,12400,3000,2026년 1분기 재협상\n' +
          'HB-1102,스테인리스 샤프트,우림금속,8900,3000,\n' +
          'HB-2204,제어 보드 CB-7,한일전자,21700,1500,환율 연동\n' +
          'HB-3310,방수 실링 키트,세진화학,1350,6000,\n',
        'utf8'
      ),
  },
  {
    id: 'gov',
    fileName: '스마트제조_국책과제_사업계획서_초안.txt',
    mime: 'text/plain; charset=utf-8',
    labelId: 'confidential',
    owner: '경영기획팀',
    protectedAt: '2026-11-05T01:05:00.000Z',
    allowedUsers: '*',
    hint: '정부·공공기관 제출 서류',
    build: () =>
      Buffer.from(
        '스마트제조 혁신 기술개발 사업계획서 (초안)\n\n' +
          '1. 과제명: 정밀 액추에이터 조립 공정의 AI 기반 품질 예측\n' +
          '2. 주관기관: 한빛정밀\n' +
          '3. 총 사업비: 18억 원 (정부출연금 12억 원, 민간부담금 6억 원)\n' +
          '4. 수행 기간: 2027.03 ~ 2029.02 (24개월)\n\n' +
          '※ 문서 해지 센터 체험용 샘플 문서입니다.\n',
        'utf8'
      ),
  },
  {
    id: 'hr',
    fileName: '임원_인사평가_결과.csv',
    mime: 'text/csv; charset=utf-8',
    labelId: 'highly',
    owner: '인사팀',
    protectedAt: '2026-10-15T08:30:00.000Z',
    allowedUsers: ['hr.lead@hanbit.example'],
    hint: '권한이 없는 문서 (해제 거부 확인용)',
    build: () => Buffer.from(`${BOM}성명,직위,평가\n(샘플),(샘플),(샘플)\n`, 'utf8'),
  },
];

export function listSamples() {
  return SAMPLES.map(({ id, fileName, labelId, hint }) => ({ id, fileName: `${fileName}.pfile`, labelId, hint }));
}

/** 샘플 원문과 보호 설정. 보호(암호화)는 어댑터가 한다. */
export function getSample(id) {
  const sample = SAMPLES.find((s) => s.id === id);
  if (!sample) return null;
  const { build, hint, id: _id, ...protection } = sample;
  return { ...protection, buffer: build() };
}
