// 비밀번호 변경 시험(계약 4.3·4.5절). 임시 PostgreSQL에 마이그레이션을 적용하고 앱을 루프백 주소에 띄워 HTTP로 확인한다.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { type Api, Client, type EphemeralPostgres, startApi, startPostgres } from '../test-support/harness.js';
import { hashPassword } from './password.js';

const NAME = 'admin';
const OLD = 'correct horse battery staple';
const NEW = 'violet tram under the quiet harbor';
const WRONG = 'not the current password';

describe('비밀번호 변경', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let oldHash: string;
  const client = () => new Client(api.base);
  const one = async <T = any>(sql: string, values: unknown[] = []): Promise<T> =>
    (await api.db.query(sql, values)).rows[0] as T;
  const change = (c: Client, body: unknown, opts: { csrf?: string | false } = {}) =>
    c.call('POST', '/api/v1/account/password', { body, ...opts });

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
    oldHash = await hashPassword(OLD);
    await api.db.query('INSERT INTO accounts (name, password_hash) VALUES ($1, $2)', [NAME, oldHash]);
  });

  after(async () => {
    await api?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    await api.db.query('TRUNCATE login_throttle, sessions, audit_log, audit_gaps, notices');
    await api.db.query('UPDATE accounts SET password_hash = $1', [oldHash]);
  });

  it('바꾸면 지금 세션을 포함해 모든 세션이 끝나고 새 비밀번호로만 로그인된다. 재확인은 따로 요구하지 않는다', async () => {
    const a = client();
    const b = client();
    await a.login(NAME, OLD);
    await b.login(NAME, OLD);
    const r = await change(a, { current_password: OLD, new_password: NEW });
    assert.equal(r.status, 200);
    assert.equal(r.body.terminated, 2);
    assert.match(r.body.password_changed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    assert.ok(r.setCookies.some((c) => /Max-Age=0/.test(c)));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    for (const c of [a, b]) assert.equal((await c.call('GET', '/api/v1/auth/session')).body.authenticated, false);
    assert.deepEqual(
      await one(`SELECT revoke_reason, count(*)::int AS n FROM sessions WHERE revoked_at IS NOT NULL GROUP BY 1`),
      { revoke_reason: 'password_change', n: 2 },
    );
    assert.equal((await client().login(NAME, OLD)).status, 401);
    assert.equal((await client().login(NAME, NEW)).status, 200);
    assert.deepEqual(await one(`SELECT actor_type, result FROM audit_log WHERE action = 'auth.password_change'`), {
      actor_type: 'shared_account',
      result: 'success',
    });
  });

  it('현재 비밀번호가 틀리면 422 current_password_wrong이고 재확인과 같은 시도 제한에 센다', async () => {
    const c = client();
    await c.login(NAME, OLD);
    const r = await change(c, { current_password: WRONG, new_password: NEW });
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.params.fields, [{ path: 'current_password', reason: 'current_password_wrong' }]);
    assert.equal((await one<{ failures: number }>('SELECT max(failures) AS failures FROM login_throttle')).failures, 1);
    await change(c, { current_password: WRONG, new_password: NEW });
    const third = await change(c, { current_password: WRONG, new_password: NEW });
    assert.equal(third.status, 429);
    assert.equal(third.body.code, 'login_throttled');
    // 막힌 동안에는 맞는 현재 비밀번호도 받지 않는다
    assert.equal((await change(c, { current_password: OLD, new_password: NEW })).status, 429);
    assert.deepEqual(
      await one(`SELECT result, reason_code, event_count FROM audit_log WHERE action = 'auth.password_change'`),
      { result: 'failure', reason_code: 'current_password_wrong', event_count: 3 },
    );
    assert.equal((await c.call('GET', '/api/v1/auth/session')).body.authenticated, true);
    assert.equal((await one<{ password_hash: string }>('SELECT password_hash FROM accounts')).password_hash, oldHash);
  });

  it('새 비밀번호 규칙을 어기면 사유를 주고, 현재 비밀번호를 맞혀 보기 전이라 시도 제한에 세지 않는다', async () => {
    const c = client();
    await c.login(NAME, OLD);
    const cases: [string, string][] = [
      ['short pass 14!', 'password_too_short'],
      ['1Q2W 3E4R 5T6Y 7U8I', 'password_common'],
      ['Admin-LogDock-2026', 'password_common'],
      ['passwordpassword', 'password_common'],
    ];
    for (const [p, reason] of cases) {
      const r = await change(c, { current_password: OLD, new_password: p });
      assert.equal(r.status, 422, p);
      assert.deepEqual(r.body.params.fields, [{ path: 'new_password', reason }], p);
    }
    const r = await change(c, { current_password: WRONG, new_password: 'too short' });
    assert.deepEqual(r.body.params.fields, [{ path: 'new_password', reason: 'password_too_short' }]);
    assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM login_throttle')).n, 0);
    assert.equal((await c.call('GET', '/api/v1/auth/session')).body.authenticated, true);
  });

  it('감사를 남길 수 없으면 바꾸지 않고 409 held_audit_unavailable로 보류한다', async () => {
    const c = client();
    await c.login(NAME, OLD);
    await api.db.query(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit storage failure'; END $$`);
    await api.db.query('CREATE TRIGGER fail_audit BEFORE INSERT OR UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()');
    try {
      const r = await change(c, { current_password: OLD, new_password: NEW });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'held_audit_unavailable');
      assert.equal((await c.call('GET', '/api/v1/auth/session')).body.authenticated, true);
    } finally {
      await api.db.query('DROP TRIGGER fail_audit ON audit_log');
      await api.db.query('DROP FUNCTION fail_audit()');
    }
    assert.equal((await client().login(NAME, OLD)).status, 200);
    // 보류는 바뀐 것이 없으므로 감사 공백이 아니다
    assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM audit_gaps')).n, 0);
  });

  it('CSRF 토큰이 없으면 403 csrf_invalid다', async () => {
    const c = client();
    await c.login(NAME, OLD);
    const r = await change(c, { current_password: OLD, new_password: NEW }, { csrf: false });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'csrf_invalid');
  });

  it('바뀌는 중에 들어온 로그인은 변경이 끝날 때까지 기다렸다가 바뀐 해시로 비교한다', async () => {
    const lock = await api.db.connect();
    let pending: Promise<{ status: number }> | undefined;
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT 1 FROM accounts WHERE name = $1 FOR UPDATE', [NAME]);
      pending = client().login(NAME, OLD);
      // 로그인이 계정 행 잠금을 기다리기 시작할 때까지 본다. 잠금 없이 읽으면 여기서 기다리지 않고 200으로 끝난다.
      for (let i = 0; ; i++) {
        const w = await one<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%FROM accounts%'`,
        );
        if (w.n > 0) break;
        assert.ok(i < 100, 'login did not wait for the account row lock');
        await sleep(20);
      }
      await lock.query('UPDATE accounts SET password_hash = $1 WHERE name = $2', [await hashPassword(NEW), NAME]);
      await lock.query('COMMIT');
    } finally {
      lock.release();
    }
    assert.equal((await pending!).status, 401);
  });
});
