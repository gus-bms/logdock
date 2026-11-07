// 메일 형식(계약 5.5절, TD-15·16, PT12-09): 일반 텍스트 한 부분, UTF-8, `Auto-Submitted: auto-generated`, 고유 Message-ID,
// 서버 설정의 고정 발신 주소. Reply-To와 HTML은 없고 To에는 받는 사람 하나만 넣는다(TD-09). 사람이 넣은 값은 제어 문자를 빼서
// 머리에 줄바꿈이 끼지 못하게 한다.
import { randomUUID } from 'node:crypto';

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  date: Date;
}

/** `<무작위@발신 도메인>`. 도메인이 ASCII가 아니면 예약 도메인을 쓴다. */
export function newMessageId(from: string): string {
  const domain = from.slice(from.lastIndexOf('@') + 1);
  return `<${randomUUID()}@${/^[A-Za-z0-9.-]+$/.test(domain) ? domain : 'logdock.invalid'}>`;
}

/** 머리 값에서 제어 문자(줄바꿈 포함)를 빼고, ASCII 밖 글자가 있으면 RFC 2047 encoded-word(UTF-8, B)로 나눠 쓴다. */
export function encodeHeader(raw: string): string {
  const v = raw.replace(/\p{Cc}+/gu, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const words: string[] = [];
  let chunk = '';
  for (const ch of v) {
    // encoded-word 하나는 75자 이하여야 한다. UTF-8 45바이트면 base64 60자로 들어간다.
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** RFC 5322 날짜(`Sat, 07 Nov 2026 05:00:00 +0000`). */
function mailDate(d: Date): string {
  return d.toUTCString().replace(/GMT$/, '+0000');
}

/** 머리와 본문을 CRLF로 이은 전체 메시지. 본문은 base64로 실어 7비트 경로에서도 깨지지 않게 한다. */
export function buildMessage(m: OutgoingMail): string {
  const headers = [
    `Date: ${mailDate(m.date)}`,
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Message-ID: ${m.messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ];
  const text = m.text.replace(/\r\n|\r|\n/g, '\r\n');
  const body = (Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}
