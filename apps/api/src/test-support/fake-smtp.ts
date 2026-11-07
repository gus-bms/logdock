// 시험용 가짜 SMTP 서버. 루프백 주소에만 열고, 단계마다 돌려줄 응답을 시험이 정한다. 받은 메일은 메모리에만 둔다.
// 바로 TLS(465 방식)와 STARTTLS(587 방식)를 흉내 낼 수 있게 인증서를 받는다. 인증서는 시험이 만들고 지운다(makeTestCert).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

export interface FakeSmtpScript {
  greeting?: string;
  /** EHLO 응답에 더할 기능 줄(예: `AUTH PLAIN LOGIN`, `SMTPUTF8`). STARTTLS는 서버 설정으로 붙는다. */
  ehlo?: string[];
  auth?: string;
  mail?: string;
  rcpt?: string;
  data?: string;
  /** 본문을 받은 뒤의 응답. `null`이면 아무것도 답하지 않는다(전송 여부 불명 흉내). */
  end?: string | null;
}

export interface ReceivedMail {
  from: string;
  to: string;
  data: string;
  auth: string | null;
  tls: boolean;
}

export interface TestCert {
  key: string;
  cert: string;
}

/** localhost·127.0.0.1용 자체 서명 인증서. openssl이 없으면 null이고 TLS 시험은 건너뛴다. */
export function makeTestCert(): TestCert | null {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ldsmtp-'));
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '1', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
      { cwd: dir, stdio: 'ignore' },
    );
    return { key: readFileSync(path.join(dir, 'key.pem'), 'utf8'), cert: readFileSync(path.join(dir, 'cert.pem'), 'utf8') };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export class FakeSmtp {
  script: FakeSmtpScript = {};
  received: ReceivedMail[] = [];
  port = 0;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly opts: { implicitTls?: TestCert; starttls?: TestCert } = {}) {}

  async start(): Promise<this> {
    const onConnection = (secure: boolean) => (s: net.Socket) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
      s.on('error', () => undefined);
      this.handle(s, secure);
    };
    this.server = this.opts.implicitTls
      ? tls.createServer({ key: this.opts.implicitTls.key, cert: this.opts.implicitTls.cert }, onConnection(true))
      : net.createServer(onConnection(false));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private handle(socket: net.Socket, secure: boolean): void {
    let current: net.Socket = socket;
    let tlsOn = secure;
    let buf = '';
    let mode: 'cmd' | 'data' = 'cmd';
    let from = '';
    let to = '';
    let auth: string | null = null;
    const send = (line: string) => current.write(line + '\r\n');
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      for (;;) {
        if (mode === 'data') {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const data = buf.slice(0, end).replace(/(^|\r\n)\.\./g, '$1.');
          buf = buf.slice(end + 5);
          mode = 'cmd';
          this.received.push({ from, to, data, auth, tls: tlsOn });
          const reply = this.script.end === undefined ? '250 2.0.0 queued' : this.script.end;
          if (reply !== null) send(reply);
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') {
          const caps = [...(this.script.ehlo ?? [])];
          if (this.opts.starttls && !tlsOn) caps.push('STARTTLS');
          const lines = ['fake.example.test', ...caps];
          lines.forEach((l, k) => send(`250${k === lines.length - 1 ? ' ' : '-'}${l}`));
        } else if (verb === 'STARTTLS' && this.opts.starttls && !tlsOn) {
          send('220 2.0.0 ready for TLS');
          current.off('data', onData);
          const secured = new tls.TLSSocket(current, {
            isServer: true,
            secureContext: tls.createSecureContext({ key: this.opts.starttls.key, cert: this.opts.starttls.cert }),
          });
          secured.on('error', () => undefined);
          secured.on('data', onData);
          current = secured;
          tlsOn = true;
          return;
        } else if (verb === 'AUTH') {
          auth = line;
          send(this.script.auth ?? '235 2.7.0 authenticated');
        } else if (verb === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          send(this.script.mail ?? '250 2.1.0 ok');
        } else if (verb === 'RCPT') {
          to = /<([^>]*)>/.exec(line)?.[1] ?? '';
          send(this.script.rcpt ?? '250 2.1.5 ok');
        } else if (verb === 'DATA') {
          const reply = this.script.data ?? '354 go ahead';
          send(reply);
          if (reply.startsWith('354')) mode = 'data';
        } else if (verb === 'QUIT') {
          send('221 2.0.0 bye');
          current.end();
          return;
        } else {
          send('502 5.5.2 not implemented');
        }
      }
    };
    socket.on('data', onData);
    send(this.script.greeting ?? '220 fake.example.test ESMTP');
  }
}
