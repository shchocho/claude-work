import crypto from 'node:crypto';
import { LABELS } from '../consts.js';

// 모의 MIP 어댑터.
// 실제 MIP SDK 없이도 "보호된 파일 → 권한 확인 → 복호화" 흐름을 끝까지 돌려 볼 수 있도록
// AES-256-GCM 으로 감싼 자체 컨테이너를 쓴다. 운영에서는 sidecar-adapter.js 로 바꾼다.
//
// 컨테이너: "MIPMOCK1" + [4바이트 헤더 길이] + 헤더 JSON + 암호문

const MAGIC = Buffer.from('MIPMOCK1', 'ascii');
const OLE_MAGIC = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const OOXML_EXT = /\.(docx|xlsx|pptx|docm|xlsm|pptm)$/i;

export function createMockAdapter({ tenantKey }) {
  const key = crypto.scryptSync(tenantKey, 'mrc-mock-mip', 32);

  function protect({ buffer, fileName, mime, labelId, owner, protectedAt, allowedUsers = '*' }) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const header = {
      v: 1,
      labelId,
      owner,
      protectedAt,
      originalName: fileName,
      mime,
      size: buffer.length,
      allowedUsers,
      iv: iv.toString('base64'),
    };
    // 헤더(등급·권한)를 바꿔치기하면 복호화가 실패하도록 인증 데이터로 묶는다.
    const aad = Buffer.from(JSON.stringify(header), 'utf8');
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    const length = Buffer.alloc(4);
    length.writeUInt32BE(aad.length);
    return Buffer.concat([MAGIC, length, aad, tag, body]);
  }

  function readContainer(buffer) {
    if (buffer.length < MAGIC.length + 4 || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    const headerLength = buffer.readUInt32BE(MAGIC.length);
    const start = MAGIC.length + 4;
    if (headerLength > 16 * 1024 || start + headerLength + 16 > buffer.length) return null;
    const aad = buffer.subarray(start, start + headerLength);
    let header;
    try {
      header = JSON.parse(aad.toString('utf8'));
    } catch {
      return null;
    }
    const tag = buffer.subarray(start + headerLength, start + headerLength + 16);
    const body = buffer.subarray(start + headerLength + 16);
    return { header, aad, tag, body };
  }

  function mayUnprotect(header, user) {
    return header.allowedUsers === '*' || (Array.isArray(header.allowedUsers) && header.allowedUsers.includes(user.email));
  }

  async function inspect({ buffer, fileName, user }) {
    const container = readContainer(buffer);
    if (container) {
      const { header } = container;
      const label = LABELS[header.labelId] ?? LABELS.confidential;
      const allowed = mayUnprotect(header, user);
      return {
        protected: true,
        supported: true,
        format: 'mock',
        labelId: label.id,
        owner: header.owner,
        protectedAt: header.protectedAt,
        originalName: header.originalName,
        mime: header.mime,
        size: header.size,
        canUnprotect: allowed,
        denyReason: allowed ? null : '이 문서의 사용 권한에 내 계정이 없습니다.',
      };
    }
    // 실제 MIP(RMS) 보호 파일의 겉모습만 알아보고, 해제는 SDK 어댑터에 맡긴다.
    const looksEncryptedOffice = OOXML_EXT.test(fileName) && buffer.subarray(0, 8).equals(OLE_MAGIC);
    if (looksEncryptedOffice || /\.p(file|pdf|txt|xml|jpg|png)$/i.test(fileName)) {
      return { protected: true, supported: false, format: 'msip' };
    }
    return { protected: false };
  }

  async function unprotect({ buffer, user }) {
    const container = readContainer(buffer);
    if (!container) throw new Error('모의 보호 컨테이너가 아닙니다.');
    if (!mayUnprotect(container.header, user)) throw new Error('사용 권한이 없습니다.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(container.header.iv, 'base64'));
    decipher.setAAD(container.aad);
    decipher.setAuthTag(container.tag);
    const plain = Buffer.concat([decipher.update(container.body), decipher.final()]);
    return { buffer: plain, fileName: container.header.originalName, mime: container.header.mime };
  }

  return { name: 'mock', protect, inspect, unprotect };
}
