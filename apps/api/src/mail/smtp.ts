// 표준 SMTP 제출(TD-08). 계약 5.5절 발송 결과표대로, 어느 단계에서 무엇이 왔는지로 사유 코드를 정한다. 특히 본문을 다 보낸 뒤
// 응답을 받지 못한 경우(전송 여부 불명, 같은 Message-ID로 다시 보냄, Q12-10)를 다른 실패와 가르려면 단계를 직접 알아야 해서
// 라이브러리 대신 필요한 명령만 쓴다: EHLO, STARTTLS, AUTH PLAIN·LOGIN, MAIL, RCPT, DATA, QUIT.
// TLS가 기본이고 인증서 검증은 끄지 않는다. 평문은 설정에서 `plain_relay`를 고른 경우뿐이다.
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';

import type { MailConfig } from '../config.js';

/** 5.5절 발송 결과의 사유 코드. `mail_retry_exhausted`는 메일 작업이 정하므로 여기에 없다. */
export type MailReason =
  | 'mail_connect_timeout'
  | 'mail_dns_error'
  | 'mail_tls_failed'
  | 'mail_auth_failed'
  | 'mail_sender_rejected'
  | 'mail_temporary_failure'
  | 'mail_recipient_rejected'
  | 'mail_rejected_after_data'
  | 'mail_no_response_after_data';

export type SendOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: MailReason;
      /** 그 수신자만 바로 최종 실패(수신자 거부, 본문 뒤 5yz). 나머지는 다시 보낼 수 있다. */
      permanent: boolean;
      /** 본문을 다 보낸 뒤 응답을 받지 못했다. 서버가 받았는지 모른다. */
      unknown: boolean;
    };

/** 연결 문제(서버·설정)인지, 그 주소의 문제인지, 모르는지. 테스트 메일 결과가 둘을 가른다(4.5절). */
export function problemOf(reason: MailReason): 'connection' | 'address' | 'unknown' {
  if (reason === 'mail_recipient_rejected' || reason === 'mail_rejected_after_data') return 'address';
  if (reason === 'mail_no_response_after_data') return 'unknown';
  return 'connection';
}

export interface SmtpOptions extends Pick<MailConfig, 'host' | 'port' | 'security' | 'user' | 'password' | 'ca'> {
  timeoutMs: number;
}

interface Reply {
  code: number;
  text: string;
}

class Timeout extends Error {}

/** 응답 줄을 모아 한 응답(여러 줄이면 `250-`가 이어지다 `250 `로 끝남)씩 꺼낸다. STARTTLS 뒤에는 소켓을 바꿔 끼운다. */
class Session {
  private socket: net.Socket | null = null;
  private buf = '';
  private failure: Error | null = null;
  private waiter: ((r: Reply | Error) => void) | null = null;
  private readonly onData = (d: Buffer) => {
    this.buf += d.toString('latin1');
    this.flush();
  };
  private readonly onError = (e: Error) => {
    this.failure ??= e;
    this.flush();
  };
  private readonly onClose = () => {
    this.failure ??= new Error('connection closed');
    this.flush();
  };

  use(socket: net.Socket): void {
    this.socket?.off('data', this.onData).off('error', this.onError).off('close', this.onClose);
    this.socket = socket;
    this.failure = null;
    socket.on('data', this.onData).on('error', this.onError).on('close', this.onClose);
  }

  /** 지금 소켓을 떼어 낸다(STARTTLS로 감싸기 전). */
  detach(): net.Socket {
    const s = this.socket!;
    s.off('data', this.onData).off('error', this.onError).off('close', this.onClose);
    this.socket = null;
    return s;
  }

  private take(): Reply | null {
    let pos = 0;
    const lines: string[] = [];
    for (;;) {
      const end = this.buf.indexOf('\r\n', pos);
      if (end < 0) return null;
      const line = this.buf.slice(pos, end);
      pos = end + 2;
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        this.buf = this.buf.slice(pos);
        return { code: Number(line.slice(0, 3)), text: lines.join('\n') };
      }
    }
  }

  private flush(): void {
    if (!this.waiter) return;
    const r = this.take();
    if (r || this.failure) {
      const w = this.waiter;
      this.waiter = null;
      w(r ?? this.failure!);
    }
  }

  reply(timeoutMs: number): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Timeout('no reply'));
      }, timeoutMs);
      this.waiter = (r) => {
        clearTimeout(timer);
        if (r instanceof Error) reject(r);
        else resolve(r);
      };
      this.flush();
    });
  }

  write(data: string): void {
    this.socket!.write(data, 'utf8');
  }

  command(line: string, timeoutMs: number): Promise<Reply> {
    this.write(line + '\r\n');
    return this.reply(timeoutMs);
  }

  close(): void {
    this.socket?.destroy();
  }
}

function connectPlain(o: SmtpOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: o.host, port: o.port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Timeout('connect'));
    }, o.timeoutMs);
    s.once('connect', () => {
      clearTimeout(timer);
      s.removeAllListeners('error');
      resolve(s);
    });
    s.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** TLS로 연결하거나(465) 연결된 소켓을 감싼다(STARTTLS). 시스템 신뢰 목록에 설정의 CA를 더하고 검증은 끄지 않는다. */
function connectTls(o: SmtpOptions, socket?: net.Socket): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({
      host: o.host,
      port: socket ? undefined : o.port,
      socket,
      servername: net.isIP(o.host) ? undefined : o.host,
      ca: o.ca ? [...tls.rootCertificates, o.ca] : undefined,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
    });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Timeout('tls'));
    }, o.timeoutMs);
    s.once('secureConnect', () => {
      clearTimeout(timer);
      s.removeAllListeners('error');
      resolve(s);
    });
    s.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** 연결 단계의 오류. 이름 풀이 실패, 인증서·TLS 실패, 그 밖의 연결 실패(시간 초과·거부)로 나눈다. */
function connectReason(e: unknown): MailReason {
  const code = String((e as NodeJS.ErrnoException)?.code ?? '');
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL'].includes(code)) return 'mail_dns_error';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO|HOSTNAME|EPROTO/.test(code)) return 'mail_tls_failed';
  return 'mail_connect_timeout';
}

const temporary = (r: Reply) => r.code >= 400 && r.code < 500;
const fail = (reason: MailReason, permanent = false, unknown = false): SendOutcome => ({ ok: false, reason, permanent, unknown });

/** 줄 맨 앞의 점을 두 번 써 본문 끝 표시(`.` 한 줄)와 헷갈리지 않게 한다(RFC 5321 4.5.2). */
function dotStuff(data: string): string {
  return data.replace(/(^|\r\n)\./g, '$1..');
}

/**
 * 메일 한 통을 한 수신자에게 보낸다. 실패해도 던지지 않고 사유 코드를 돌려준다. `data`는 머리와 본문을 CRLF로 이은 전체 메시지다.
 * 주소에 ASCII 밖 글자가 있으면 서버가 SMTPUTF8을 지원해야 하고, 아니면 그 주소의 문제로 본다.
 */
export async function sendMail(o: SmtpOptions, msg: { from: string; to: string; data: string }): Promise<SendOutcome> {
  const s = new Session();
  const t = o.timeoutMs;
  const helo = os.hostname() || 'localhost';
  let afterData = false;
  try {
    let socket: net.Socket;
    try {
      socket = o.security === 'tls' ? await connectTls(o) : await connectPlain(o);
    } catch (e) {
      return fail(connectReason(e));
    }
    s.use(socket);
    const greeting = await s.reply(t);
    if (greeting.code !== 220) return fail(temporary(greeting) ? 'mail_temporary_failure' : 'mail_connect_timeout');
    let ehlo = await s.command(`EHLO ${helo}`, t);
    if (ehlo.code !== 250) return fail(temporary(ehlo) ? 'mail_temporary_failure' : 'mail_connect_timeout');

    if (o.security === 'starttls') {
      // TLS는 필수다. 서버가 STARTTLS를 내놓지 않으면 평문으로 내려가지 않고 실패한다(TD-08).
      if (!/^250[ -]STARTTLS\b/im.test(ehlo.text)) return fail('mail_tls_failed');
      const r = await s.command('STARTTLS', t);
      if (r.code !== 220) return fail('mail_tls_failed');
      try {
        socket = await connectTls(o, s.detach());
      } catch {
        return fail('mail_tls_failed');
      }
      s.use(socket);
      ehlo = await s.command(`EHLO ${helo}`, t);
      if (ehlo.code !== 250) return fail(temporary(ehlo) ? 'mail_temporary_failure' : 'mail_connect_timeout');
    }

    if (o.user) {
      const authFail = (r: Reply) => fail(temporary(r) ? 'mail_temporary_failure' : 'mail_auth_failed');
      if (/^250[ -]AUTH\b.*\bPLAIN\b/im.test(ehlo.text)) {
        const token = Buffer.from(`\0${o.user}\0${o.password ?? ''}`, 'utf8').toString('base64');
        const r = await s.command(`AUTH PLAIN ${token}`, t);
        if (r.code !== 235) return authFail(r);
      } else if (/^250[ -]AUTH\b.*\bLOGIN\b/im.test(ehlo.text)) {
        let r = await s.command('AUTH LOGIN', t);
        if (r.code !== 334) return authFail(r);
        r = await s.command(Buffer.from(o.user, 'utf8').toString('base64'), t);
        if (r.code !== 334) return authFail(r);
        r = await s.command(Buffer.from(o.password ?? '', 'utf8').toString('base64'), t);
        if (r.code !== 235) return authFail(r);
      } else {
        return fail('mail_auth_failed');
      }
    }

    const utf8 = /[^\x20-\x7e]/.test(msg.from + msg.to);
    if (utf8 && !/^250[ -]SMTPUTF8\b/im.test(ehlo.text)) return fail('mail_recipient_rejected', true);
    let r = await s.command(`MAIL FROM:<${msg.from}>${utf8 ? ' SMTPUTF8' : ''}`, t);
    if (r.code !== 250) return fail(temporary(r) ? 'mail_temporary_failure' : 'mail_sender_rejected');
    r = await s.command(`RCPT TO:<${msg.to}>`, t);
    if (r.code !== 250 && r.code !== 251) return temporary(r) ? fail('mail_temporary_failure') : fail('mail_recipient_rejected', true);
    r = await s.command('DATA', t);
    if (r.code !== 354) return temporary(r) ? fail('mail_temporary_failure') : fail('mail_rejected_after_data', true);
    s.write(dotStuff(msg.data) + '\r\n.\r\n');
    afterData = true;
    r = await s.reply(t * 2);
    if (r.code !== 250) return temporary(r) ? fail('mail_temporary_failure') : fail('mail_rejected_after_data', true);
    await s.command('QUIT', Math.min(t, 2000)).catch(() => undefined);
    return { ok: true };
  } catch {
    // 응답이 끊기거나 늦었다. 본문을 보낸 뒤라면 서버가 받았는지 모른다.
    return afterData ? fail('mail_no_response_after_data', false, true) : fail('mail_connect_timeout');
  } finally {
    s.close();
  }
}
