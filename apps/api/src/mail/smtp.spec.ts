// SMTP 제출 시험(계약 5.5절 발송 결과표, TD-08). 루프백 주소의 가짜 SMTP 서버로 단계마다 응답을 바꿔 사유 코드를 확인한다.
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { FakeSmtp, makeTestCert } from '../test-support/fake-smtp.js';
import { buildMessage, encodeHeader, newMessageId } from './message.js';
import { problemOf, sendMail, type SmtpOptions } from './smtp.js';

const FROM = 'logdock@example.test';

function message(to = 'ops@example.test', subject = '[LogDock] 테스트 메일', text = '본문 첫 줄\n.점으로 시작하는 줄') {
  return { from: FROM, to, data: buildMessage({ from: FROM, to, subject, text, messageId: newMessageId(FROM), date: new Date('2026-11-07T05:00:00Z') }) };
}

/** encoded-word를 풀어 사람이 읽는 값으로 되돌린다(시험 확인용). */
function decodeWords(v: string): string {
  return v.replace(/\r\n /g, '').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b64) => Buffer.from(b64, 'base64').toString('utf8'));
}

function headerOf(data: string, name: string): string {
  const head = data.split('\r\n\r\n')[0];
  const m = new RegExp(`^${name}: (.*(?:\\r\\n .*)*)`, 'm').exec(head);
  return m ? m[1] : '';
}

describe('SMTP 제출', () => {
  let fake: FakeSmtp;
  const opts = (over: Partial<SmtpOptions> = {}): SmtpOptions => ({
    host: '127.0.0.1',
    port: fake.port,
    security: 'plain_relay',
    user: null,
    password: null,
    ca: null,
    timeoutMs: 2000,
    ...over,
  });

  before(async () => {
    fake = await new FakeSmtp().start();
  });
  after(async () => {
    await fake.close();
  });
  beforeEach(() => {
    fake.script = {};
    fake.received = [];
  });

  it('평문 사내 릴레이로 보내면 머리와 본문이 정한 형식대로 간다', async () => {
    assert.deepEqual(await sendMail(opts(), message()), { ok: true });
    const got = fake.received[0];
    assert.equal(got.from, FROM);
    assert.equal(got.to, 'ops@example.test');
    assert.equal(got.tls, false);
    assert.equal(decodeWords(headerOf(got.data, 'Subject')), '[LogDock] 테스트 메일');
    assert.equal(headerOf(got.data, 'Auto-Submitted'), 'auto-generated');
    assert.equal(headerOf(got.data, 'Content-Type'), 'text/plain; charset=UTF-8');
    assert.equal(headerOf(got.data, 'To'), 'ops@example.test');
    assert.match(headerOf(got.data, 'Message-ID'), /^<[0-9a-f-]+@example\.test>$/);
    assert.equal(headerOf(got.data, 'Reply-To'), '');
    const body = Buffer.from(got.data.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
    assert.equal(body, '본문 첫 줄\r\n.점으로 시작하는 줄');
    // 줄 맨 앞의 점은 두 번 써서 보내고 서버가 되돌린다.
    assert.deepEqual(await sendMail(opts(), { from: FROM, to: 'ops@example.test', data: 'Subject: x\r\n\r\n.\r\n..둘' }), { ok: true });
    assert.equal(fake.received[1].data, 'Subject: x\r\n\r\n.\r\n..둘');
  });

  it('계정이 있으면 서버가 내놓은 AUTH PLAIN으로 인증하고, AUTH가 없으면 인증 실패다', async () => {
    fake.script.ehlo = ['AUTH PLAIN LOGIN'];
    assert.deepEqual(await sendMail(opts({ user: 'mailer', password: 'pw' }), message()), { ok: true });
    assert.equal(fake.received[0].auth, `AUTH PLAIN ${Buffer.from('\0mailer\0pw').toString('base64')}`);
    fake.script.ehlo = [];
    const r = await sendMail(opts({ user: 'mailer', password: 'pw' }), message());
    assert.equal(r.ok === false && r.reason, 'mail_auth_failed');
  });

  it('어느 단계에서 무엇이 왔는지로 사유 코드와 다시 보낼지를 정한다', async () => {
    const cases: [object, string, boolean, boolean][] = [
      [{ greeting: '421 4.3.2 busy' }, 'mail_temporary_failure', false, false],
      [{ ehlo: ['AUTH PLAIN'], auth: '535 5.7.8 bad credentials' }, 'mail_auth_failed', false, false],
      [{ mail: '550 5.7.1 sender denied' }, 'mail_sender_rejected', false, false],
      [{ rcpt: '451 4.3.0 try later' }, 'mail_temporary_failure', false, false],
      [{ rcpt: '550 5.1.1 no such user' }, 'mail_recipient_rejected', true, false],
      [{ end: '554 5.6.0 message rejected' }, 'mail_rejected_after_data', true, false],
      [{ end: null }, 'mail_no_response_after_data', false, true],
    ];
    for (const [script, reason, permanent, unknown] of cases) {
      fake.script = script;
      // 계정은 AUTH를 시험하는 경우에만 준다. 계정이 있는데 서버가 AUTH를 내놓지 않으면 그 단계에서 멈추기 때문이다.
      const account = 'auth' in script ? { user: 'mailer', password: 'pw' } : {};
      const r = await sendMail(opts({ ...account, timeoutMs: 300 }), message());
      assert.deepEqual(r, { ok: false, reason, permanent, unknown }, JSON.stringify(script));
    }
    assert.equal(problemOf('mail_recipient_rejected'), 'address');
    assert.equal(problemOf('mail_no_response_after_data'), 'unknown');
    assert.equal(problemOf('mail_tls_failed'), 'connection');
  });

  it('연결이 안 되면 연결 실패이고, 이름을 풀지 못하면 DNS 실패다', async () => {
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const refused = await sendMail(opts({ port }), message());
    assert.equal(refused.ok === false && refused.reason, 'mail_connect_timeout');
    const dns = await sendMail(opts({ host: 'nonexistent.invalid' }), message());
    assert.equal(dns.ok === false && dns.reason, 'mail_dns_error');
  });

  it('바로 TLS는 인증서를 검증하고, 사설 인증서는 설정한 CA로만 믿는다', async (t) => {
    const cert = makeTestCert();
    if (!cert) return t.skip('openssl이 없어 인증서를 만들지 못했다');
    const tlsFake = await new FakeSmtp({ implicitTls: cert }).start();
    try {
      const ok = await sendMail(opts({ host: 'localhost', port: tlsFake.port, security: 'tls', ca: cert.cert }), message());
      assert.deepEqual(ok, { ok: true });
      assert.equal(tlsFake.received[0].tls, true);
      const untrusted = await sendMail(opts({ host: 'localhost', port: tlsFake.port, security: 'tls' }), message());
      assert.equal(untrusted.ok === false && untrusted.reason, 'mail_tls_failed');
    } finally {
      await tlsFake.close();
    }
  });

  it('STARTTLS는 서버가 내놓지 않으면 평문으로 내려가지 않고 실패한다', async (t) => {
    const cert = makeTestCert();
    if (!cert) return t.skip('openssl이 없어 인증서를 만들지 못했다');
    const starttls = await new FakeSmtp({ starttls: cert }).start();
    try {
      const ok = await sendMail(opts({ host: 'localhost', port: starttls.port, security: 'starttls', ca: cert.cert }), message());
      assert.deepEqual(ok, { ok: true });
      assert.equal(starttls.received[0].tls, true);
    } finally {
      await starttls.close();
    }
    const plainOnly = await sendMail(opts({ security: 'starttls' }), message());
    assert.equal(plainOnly.ok === false && plainOnly.reason, 'mail_tls_failed');
    assert.equal(fake.received.length, 0);
  });

  it('머리 값의 줄바꿈은 빼서 머리를 끼워 넣지 못하고, 긴 한글 제목은 75자 이하 조각으로 나눈다', () => {
    assert.equal(encodeHeader('제목\r\nBcc: victim@example.test').includes('\r\nBcc'), false);
    const data = buildMessage({ from: FROM, to: 'ops@example.test', subject: 'x\r\nBcc: victim@example.test', text: 'b', messageId: '<a@b>', date: new Date() });
    assert.equal(/^Bcc:/m.test(data.split('\r\n\r\n')[0]), false);
    const long = encodeHeader('결제 서비스 오류 급증 알림 규칙 '.repeat(4));
    assert.ok(long.split('\r\n ').every((w) => w.length <= 75));
    assert.equal(decodeWords(long), '결제 서비스 오류 급증 알림 규칙 '.repeat(4).trim());
  });
});
