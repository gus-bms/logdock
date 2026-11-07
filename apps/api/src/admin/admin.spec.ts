// 중앙 로컬 명령 시험(계약 8.2절). 임시 PostgreSQL을 쓰고, 명령은 실행 파일의 main()과 컴파일한 cli.js로 부른다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PassThrough, Readable } from 'node:stream';

import { hashPassword } from '../auth/password.js';
import { main } from '../cli.js';
import { type Api, Client, type EphemeralPostgres, startApi, startPostgres } from '../test-support/harness.js';

const NAME = 'admin';
const FIRST = 'violet tram under the quiet harbor';
const OLD = 'correct horse battery staple';
const NEW = 'seven lanterns over a frozen canal';

describe('로컬 명령: set-password·reset-password', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let env: NodeJS.ProcessEnv;
  const client = () => new Client(api.base);
  const one = async <T = any>(sql: string, values: unknown[] = []): Promise<T> =>
    (await api.db.query(sql, values)).rows[0] as T;

  /** 명령을 부르고 종료 코드와 출력을 돌려준다. 비밀번호는 표준 입력의 첫 줄로 넘긴다. */
  async function run(args: string[], stdin: string) {
    const out = new PassThrough();
    const err = new PassThrough();
    let stdout = '';
    let stderr = '';
    out.on('data', (d) => (stdout += d));
    err.on('data', (d) => (stderr += d));
    const input = Readable.from([stdin]) as unknown as NodeJS.ReadStream;
    const code = await main(args, env, { input, out, err });
    return { code, stdout, stderr };
  }

  before(async () => {
    pg = await startPostgres();
    api = await startApi(pg, {
      throttle: {
        windowSeconds: 900,
        blockSeconds: 900,
        perSourceFailures: 3,
        perAccountFailures: 10,
        lockAfterConsecutiveFailures: 100,
      },
    });
    env = {
      LOGDOCK_DB_HOST: pg.host,
      LOGDOCK_DB_PORT: String(pg.port),
      LOGDOCK_DB_USER: pg.user,
      LOGDOCK_DB_NAME: pg.database,
    };
  });

  after(async () => {
    await api?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    await api.db.query('TRUNCATE login_throttle, sessions, audit_log, audit_gaps, notices');
  });

  it('set-password는 계정이 없을 때만 공용 계정과 초기 비밀번호를 만든다', async () => {
    const r = await run(['admin', 'set-password', '--name', ` ${NAME} `], `${FIRST}\n`);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /계정 'admin'을 만들고/);
    assert.equal((await client().login(NAME, FIRST)).status, 200);
    assert.deepEqual(await one(`SELECT actor_type, result FROM audit_log WHERE action = 'auth.password_set_local'`), {
      actor_type: 'local_operator',
      result: 'success',
    });
    const again = await run(['admin', 'set-password', '--name', 'other'], `${NEW}\n`);
    assert.equal(again.code, 2);
    assert.match(again.stderr, /이미 있어/);
    assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM accounts')).n, 1);
    assert.equal((await client().login(NAME, FIRST)).status, 200);
  });

  it('reset-password는 비밀번호를 바꾸고 모든 웹 세션을 끝내며 로그인 시도 제한을 푼다', async () => {
    await api.db.query('UPDATE accounts SET password_hash = $1', [await hashPassword(OLD)]);
    const a = client();
    const b = client();
    await a.login(NAME, OLD);
    await b.login(NAME, OLD);
    for (let i = 0; i < 3; i++) await client().login(NAME, 'wrong password attempt');
    assert.equal((await client().login(NAME, OLD)).status, 429);

    const r = await run(['admin', 'reset-password'], `${NEW}\n`);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /웹 세션 2개를 끝내고 로그인 시도 제한과 잠금을 풀었습니다/);
    for (const c of [a, b]) assert.equal((await c.call('GET', '/api/v1/auth/session')).body.authenticated, false);
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE revoke_reason = 'password_reset_local'`)).n, 2);
    assert.equal((await client().login(NAME, OLD)).status, 401);
    assert.equal((await client().login(NAME, NEW)).status, 200);
    assert.deepEqual(await one(`SELECT actor_type, result FROM audit_log WHERE action = 'auth.password_reset_local'`), {
      actor_type: 'local_operator',
      result: 'success',
    });
  });

  it('규칙을 어긴 비밀번호, 인자로 넘긴 비밀번호, 이름 없는 set-password는 받지 않는다', async () => {
    const unchanged = await one<{ password_hash: string }>('SELECT password_hash FROM accounts');
    const weak = await run(['admin', 'reset-password', '--name', 'ADMIN'], 'admin admin 2026 logdock\n');
    assert.equal(weak.code, 2);
    assert.match(weak.stderr, /흔하거나 예측하기 쉬운/);
    const short = await run(['admin', 'reset-password'], 'short one\n');
    assert.equal(short.code, 2);
    assert.match(short.stderr, /15자 이상/);
    const argv = await run(['admin', 'reset-password', '--password', NEW], '');
    assert.equal(argv.code, 2);
    assert.match(argv.stderr, /사용법/);
    const noName = await run(['admin', 'set-password'], `${NEW}\n`);
    assert.equal(noName.code, 2);
    const missing = await run(['admin', 'reset-password', '--name', 'nobody'], `${NEW}\n`);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /계정 'nobody'이 없습니다/);
    assert.deepEqual(await one('SELECT password_hash FROM accounts'), unchanged);
  });

  it('감사를 쓸 수 없어도 재설정은 진행하고 감사 공백과 배너를 남긴다', async () => {
    await api.db.query(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit storage failure'; END $$`);
    await api.db.query('CREATE TRIGGER fail_audit BEFORE INSERT OR UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()');
    try {
      const r = await run(['admin', 'reset-password'], `${OLD}\n`);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /감사 공백/);
    } finally {
      await api.db.query('DROP TRIGGER fail_audit ON audit_log');
      await api.db.query('DROP FUNCTION fail_audit()');
    }
    assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM audit_gaps WHERE ended_at IS NULL')).n, 1);
    assert.deepEqual(await one(`SELECT kind FROM notices WHERE cleared_at IS NULL`), { kind: 'audit_gap' });
    assert.equal((await client().login(NAME, OLD)).status, 200);
  });

  it('실행 파일로 부르면 표준 입력의 첫 줄을 비밀번호로 쓰고 출력에 비밀번호를 남기지 않는다', async () => {
    const child = spawn(process.execPath, [join(__dirname, '..', 'cli.js'), 'admin', 'reset-password', '--name', NAME], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(`${NEW}\r\n`);
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    assert.match(stdout, /비밀번호를 바꿨습니다/);
    assert.ok(!stdout.includes(NEW) && !stderr.includes(NEW));
    assert.equal((await client().login(NAME, NEW)).status, 200);
  });
});
