// 인증·세션 시험. 임시 PostgreSQL에 마이그레이션을 적용하고 앱을 루프백 주소에 띄워 HTTP로 확인한다.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type Api, Client, type EphemeralPostgres, startApi, startPostgres } from '../test-support/harness.js';
import { hashPassword } from './password.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';

describe('인증과 세션', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  const client = () => new Client(api.base);
  const one = async <T = any>(sql: string, values: unknown[] = []): Promise<T> =>
    (await api.db.query(sql, values)).rows[0] as T;

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
    await api.db.query('INSERT INTO accounts (name, password_hash) VALUES ($1, $2)', [NAME, await hashPassword(PASSWORD)]);
  });

  after(async () => {
    await api?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    await api.db.query('TRUNCATE login_throttle, sessions, audit_log, audit_gaps, notices');
  });

  it('로그인하면 Strict 세션 쿠키와 CSRF 토큰을 주고, 세션 확인이 같은 토큰을 돌려준다', async () => {
    const c = client();
    const r = await c.login('Admin', PASSWORD); // 이름은 대소문자를 가리지 않는다
    assert.equal(r.status, 200);
    assert.equal(r.body.account.name, NAME);
    assert.match(r.body.csrf_token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(r.body.expires_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    assert.equal(r.setCookies.length, 1);
    assert.match(r.setCookies[0], /^__Host-logdock_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=86400$/);
    assert.equal(r.headers.get('cache-control'), 'no-store');

    const s = await c.call('GET', '/api/v1/auth/session');
    assert.equal(s.status, 200);
    assert.equal(s.body.authenticated, true);
    assert.equal(s.body.csrf_token, r.body.csrf_token);
    assert.equal(s.body.reauth_valid_until, null);

    // DB에는 세션 ID 원문이 없다
    const token = c.cookies.get('__Host-logdock_session')!;
    const row = await one<{ n: string }>(
      `SELECT count(*) AS n FROM sessions WHERE id_hash = decode($1, 'base64') OR encode(id_hash, 'base64') = $1`,
      [Buffer.from(token, 'base64url').toString('base64')],
    );
    assert.equal(row.n, '0');
    const audit = await one<{ action: string; result: string }>('SELECT action, result FROM audit_log');
    assert.deepEqual(audit, { action: 'auth.login', result: 'success' });
  });

  it('틀린 비밀번호와 없는 계정은 같은 401이고, 몰린 실패는 감사 한 행으로 묶인다', async () => {
    const a = await client().login(NAME, 'wrong password');
    const b = await client().login('nobody', PASSWORD);
    for (const r of [a, b]) {
      assert.equal(r.status, 401);
      assert.equal(r.setCookies.length, 0);
    }
    const strip = (x: any) => ({ ...x, request_id: undefined });
    assert.deepEqual(strip(a.body), strip(b.body));
    assert.equal(a.body.code, 'login_failed');
    const audit = await one<{ n: string; count: number }>(
      `SELECT count(*) AS n, max(event_count) AS count FROM audit_log WHERE action = 'auth.login_failed'`,
    );
    assert.deepEqual(audit, { n: '1', count: 2 });
  });

  it('같은 주소에서 연속으로 틀리면 막고, 막힌 동안에는 맞는 비밀번호도 받지 않는다', async () => {
    const c = client();
    assert.equal((await c.login(NAME, 'x1')).status, 401);
    assert.equal((await c.login(NAME, 'x2')).status, 401);
    const third = await c.login(NAME, 'x3');
    assert.equal(third.status, 429);
    assert.equal(third.body.code, 'login_throttled');
    assert.ok(third.body.params.retry_after_seconds > 0 && third.body.params.retry_after_seconds <= 900);
    assert.equal(third.headers.get('retry-after'), String(third.body.params.retry_after_seconds));
    const right = await c.login(NAME, PASSWORD);
    assert.equal(right.status, 429);
    // 막힘이 풀리면 다시 받는다
    await api.db.query(`UPDATE login_throttle SET blocked_until = now() - interval '1 second'`);
    assert.equal((await c.login(NAME, PASSWORD)).status, 200);
  });

  it('상태를 바꾸는 요청은 CSRF 토큰이 맞아야 하고, 로그아웃하면 세션이 끝난다', async () => {
    const c = client();
    await c.login(NAME, PASSWORD);
    const none = await c.call('POST', '/api/v1/auth/logout', { csrf: false });
    assert.equal(none.status, 403);
    assert.equal(none.body.code, 'csrf_invalid');
    const wrong = await c.call('POST', '/api/v1/auth/logout', { csrf: 'A'.repeat(43) });
    assert.equal(wrong.body.code, 'csrf_invalid');
    const ok = await c.call('POST', '/api/v1/auth/logout');
    assert.equal(ok.status, 204);
    assert.equal(c.cookies.size, 0, 'logout clears the cookie');
    const reason = await one<{ revoke_reason: string }>('SELECT revoke_reason FROM sessions');
    assert.equal(reason.revoke_reason, 'logout');
    const actions = (await api.db.query('SELECT action FROM audit_log ORDER BY id')).rows.map((r) => r.action);
    assert.deepEqual(actions, ['auth.login', 'auth.logout']);
  });

  it('끝난 세션 쿠키로 부르면 401 session_expired이고 쿠키를 지운다', async () => {
    const c = client();
    await c.login(NAME, PASSWORD);
    const token = c.cookies.get('__Host-logdock_session')!;
    await c.call('POST', '/api/v1/auth/logout');
    c.cookies.set('__Host-logdock_session', token); // 지운 쿠키를 다시 보낸다
    const r = await c.call('POST', '/api/v1/auth/reauth', { body: { password: PASSWORD } });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'session_expired');
    assert.match(r.setCookies[0] ?? '', /Max-Age=0/);
    assert.equal((await c.call('GET', '/api/v1/auth/session')).body.authenticated, false);
    assert.equal((await client().call('POST', '/api/v1/auth/logout')).body.code, 'session_expired');
  });

  it('비활동 1시간이나 로그인 후 24시간이 지나면 세션이 끝난다', async () => {
    for (const set of [
      `last_active_at = now() - interval '61 minutes'`,
      `created_at = now() - interval '25 hours', last_active_at = now()`,
    ]) {
      await api.db.query('TRUNCATE sessions');
      const c = client();
      await c.login(NAME, PASSWORD);
      await api.db.query(`UPDATE sessions SET ${set}`);
      const r = await c.call('POST', '/api/v1/auth/reauth', { body: { password: PASSWORD } });
      assert.equal(r.body.code, 'session_expired', set);
    }
  });

  it('화면이 스스로 보내는 요청은 비활동 시간을 늘리지 않는다', async () => {
    const c = client();
    await c.login(NAME, PASSWORD);
    await api.db.query(`UPDATE sessions SET last_active_at = now() - interval '30 minutes'`);
    const idle = () => one<{ m: number }>(`SELECT round(extract(epoch FROM now() - last_active_at) / 60) AS m FROM sessions`);
    const bg = await c.call('GET', '/api/v1/auth/session', { headers: { 'x-logdock-background': '1' } });
    assert.equal(bg.body.authenticated, true);
    assert.equal(Number((await idle()).m), 30);
    await c.call('GET', '/api/v1/auth/session');
    assert.equal(Number((await idle()).m), 0);
  });

  it('재확인: 틀리면 422 current_password_wrong이고 시도 제한에 센다. 맞으면 유효 시각을 준다', async () => {
    const c = client();
    await c.login(NAME, PASSWORD);
    const wrong = await c.call('POST', '/api/v1/auth/reauth', { body: { password: 'nope' } });
    assert.equal(wrong.status, 422);
    assert.deepEqual(wrong.body.params.fields, [{ path: 'password', reason: 'current_password_wrong' }]);
    assert.equal((await one<{ failures: number }>('SELECT max(failures) AS failures FROM login_throttle')).failures, 1);
    const right = await c.call('POST', '/api/v1/auth/reauth', { body: { password: PASSWORD } });
    assert.equal(right.status, 200);
    assert.match(right.body.reauth_valid_until, /Z$/);
    assert.equal((await c.call('GET', '/api/v1/auth/session')).body.reauth_valid_until, right.body.reauth_valid_until);
    assert.equal((await one<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE action = 'auth.reauth_failed'`)).n, '1');
  });

  it('돌아갈 곳은 이 웹의 내부 경로만 받는다', async () => {
    const cases: [string, string | null][] = [
      ['/alerts/incidents/inc_8f3k2', '/alerts/incidents/inc_8f3k2'],
      ['//evil.example/x', null],
      ['https://evil.example/', null],
      ['/\\evil.example', null],
    ];
    for (const [given, want] of cases) {
      await api.db.query('TRUNCATE login_throttle');
      const r = await client().call('POST', '/api/v1/auth/login', { body: { name: NAME, password: PASSWORD, return_to: given } });
      assert.equal(r.body.return_to, want, given);
    }
  });

  it('감사를 쓸 수 없어도 로그인은 진행하고 감사 공백과 배너를 남긴다', async () => {
    await api.db.query(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit storage failure'; END $$`);
    await api.db.query('CREATE TRIGGER fail_audit BEFORE INSERT OR UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()');
    try {
      const c = client();
      assert.equal((await c.login(NAME, PASSWORD)).status, 200);
      assert.equal((await one<{ n: string }>('SELECT count(*) AS n FROM audit_gaps WHERE ended_at IS NULL')).n, '1');
      const t = await c.call('POST', '/api/v1/account/sessions/terminate-all');
      assert.deepEqual(t.body, { terminated: 1, audit_gap: true });
      // 공백은 이어지는 동안 하나이고, 배너도 하나다
      assert.equal((await one<{ n: string }>('SELECT count(*) AS n FROM audit_gaps')).n, '1');
      assert.deepEqual(await one(`SELECT kind, item_count FROM notices WHERE cleared_at IS NULL`), {
        kind: 'audit_gap',
        item_count: 1,
      });
    } finally {
      await api.db.query('DROP TRIGGER fail_audit ON audit_log');
      await api.db.query('DROP FUNCTION fail_audit()');
    }
  });

  it('전체 세션 종료는 지금 세션을 포함해 모든 세션을 끝낸다', async () => {
    const a = client();
    const b = client();
    await a.login(NAME, PASSWORD);
    await b.login(NAME, PASSWORD);
    const r = await a.call('POST', '/api/v1/account/sessions/terminate-all');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { terminated: 2, audit_gap: false });
    for (const c of [a, b]) assert.equal((await c.call('GET', '/api/v1/auth/session')).body.authenticated, false);
  });

  it('오류 본문은 code·retryable·params·message·request_id이고 요청 참조가 헤더와 같다', async () => {
    const r = await client().call('POST', '/api/v1/auth/login', { body: { name: NAME } });
    assert.equal(r.status, 422);
    assert.deepEqual(Object.keys(r.body).sort(), ['code', 'message', 'params', 'request_id', 'retryable']);
    assert.equal(r.body.code, 'validation_failed');
    assert.deepEqual(r.body.params.fields.map((f: any) => f.path), ['password']);
    assert.equal(r.body.request_id, r.headers.get('x-request-id'));
    const bad = await client().call('POST', '/api/v1/auth/login', { raw: '{"name":' });
    assert.equal(bad.status, 422);
    assert.deepEqual(bad.body.params.fields, [{ path: '', reason: 'invalid_json' }]);
    const missing = await client().call('GET', '/api/v1/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'not_found');
  });
});
