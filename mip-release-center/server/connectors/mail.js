import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 메일 커넥터(모의).
// G/W 메일과 개인메일 송부를 실제로 내보내는 대신, 보낼 메시지를 .eml 파일로 outbox 에 남긴다.
// 운영에서는 이 함수 하나를 그룹웨어 메일 API 나 SMTP 릴레이 호출로 바꾸면 된다.

const encodeWord = (text) => `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
const wrap76 = (base64) => base64.replace(/.{1,76}/g, '$&\r\n').trimEnd();

export function createMailConnector({ dataDir }) {
  const outbox = path.join(dataDir, 'outbox');
  fs.mkdirSync(outbox, { recursive: true });

  function send({ from, to, subject, text, attachment, at = new Date() }) {
    const id = crypto.randomUUID();
    const boundary = `mrc-${id}`;
    const eml = [
      `Message-ID: <${id}@release-center>`,
      `Date: ${at.toUTCString()}`,
      `From: ${encodeWord(from.name)} <${from.email}>`,
      `To: ${to.join(', ')}`,
      `Subject: ${encodeWord(subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(Buffer.from(text || '', 'utf8').toString('base64')),
      `--${boundary}`,
      `Content-Type: ${attachment.mime}; name="${encodeWord(attachment.name)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${encodeWord(attachment.name)}"`,
      '',
      wrap76(attachment.buffer.toString('base64')),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const file = path.join(outbox, `${id}.eml`);
    fs.writeFileSync(file, eml);
    return { messageId: id, outboxFile: path.relative(dataDir, file) };
  }

  return { name: 'outbox', send };
}
