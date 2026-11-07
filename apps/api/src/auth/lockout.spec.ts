// 연속 실패 잠금 시험(2026-11-07 사용자 합의, 계약 4.3절). 잠금 한도를 5로 낮추고 창 안 시도 제한은 크게 둬
// 잠금만 따로 본다. 임시 PostgreSQL에 마이그레이션을 적용하고 앱을 루프백 주소에 띄워 HTTP로 확인한다.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { AdminCommands } from '../admin/admin.js';
import { Database } from '../db/database.js';
import { type Api, Client, type EphemeralPostgres, startApi, startPostgres } from '../test-support/harness.js';
import { hashPassword } from './password.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';
const NEW = 'seven lanterns over a frozen canal';
const WRONG = 'not the right password';
const LIMIT = 5;

describe('연속 실패 잠금', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let hash: string;
  const client = () => new Client(api.base);
  const one = async <T = any>(sql: string, values: unknown[] = []): Promise<T> =>
    (await api.db.query(sql, values)).rows[0] as T;
  const count = async (sql: string) => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`)).n;

  before(async () => {
    pg = await startPostgres();
    api = await startApi(pg, {
      throttle: {
        windowSeconds: 900,
        blockSeconds: 900,
        perSourceFailures: 1000,
        perAccountFailures: 1000,
        lockAfterConsecutiveFailures: LIMIT,
      },
    });
    hash = await hashPassword(PASSWORD);
    await api.db.query('INSERT INTO accounts (name, password_hash) VALUES ($1, $2)', [NAME, hash]);
  });

  after(async () => {
    await api?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    await api.db.query('TRUNCATE login_throttle, sessions, audit_log, audit_gaps, notices');
    await api.db.query('UPDATE accounts SET password_hash = $1', [hash]);
  });

  it('연속으로 한도만큼 틀리면 잠기고, 기다려도 맞는 비밀번호를 받지 않는다', async () => {
    for (let i = 1; i < LIMIT; i++) assert.equal((await client().login(NAME, WRONG)).status, 401, `attempt ${i}`);
    const last = await client().login(NAME, WRONG);
    assert.equal(last.status, 423);
    assert.equal(last.body.code, 'login_locked');
    assert.equal(last.body.retryable, false);
    assert.equal(last.headers.get('retry-after'), null);
    assert.equal((await client().login(NAME, PASSWORD)).status, 423);
    // 창이 지나고 잠시 막힘이 끝나도 잠금은 그대로다
    await api.db.query(`UPDATE login_throttle SET blocked_until = NULL, window_started_at = now() - interval '1 day'`);
    assert.equal((await client().login(NAME, PASSWORD)).status, 423);
    assert.deepEqual(await one(`SELECT actor_type, reason_code FROM audit_log WHERE action = 'auth.login_locked'`), {
      actor_type: 'system',
      reason_code: 'consecutive_failures',
    });
    assert.equal(await count(`audit_log WHERE action = 'auth.login_locked'`), 1);
  });

  it('없는 계정 이름도 똑같이 잠겨 잠금으로 계정이 있는지 드러나지 않는다', async () => {
    const codes: number[] = [];
    for (let i = 0; i < LIMIT; i++) codes.push((await client().login('nobody', WRONG)).status);
    assert.deepEqual(codes, [401, 401, 401, 401, 423]);
    assert.equal(await count(`audit_log WHERE action = 'auth.login_locked'`), 0);
    // 다른 계정 이름의 잠금은 이 계정에 닿지 않는다
    assert.equal((await client().login(NAME, PASSWORD)).status, 200);
  });

  it('성공하면 연속 실패 수가 0으로 돌아간다', async () => {
    for (let i = 1; i < LIMIT; i++) await client().login(NAME, WRONG);
    assert.equal((await client().login(NAME, PASSWORD)).status, 200);
    for (let i = 1; i < LIMIT; i++) assert.equal((await client().login(NAME, WRONG)).status, 401);
    assert.equal((await client().login(NAME, PASSWORD)).status, 200);
  });

  it('재확인과 비밀번호 변경의 실패도 같은 잠금에 세고, 잠겨도 이미 있는 세션은 그대로다', async () => {
    const c = client();
    assert.equal((await c.login(NAME, PASSWORD)).status, 200);
    for (let i = 0; i < 3; i++) assert.equal((await c.call('POST', '/api/v1/auth/reauth', { body: { password: WRONG } })).status, 422);
    const change = (current: string) =>
      c.call('POST', '/api/v1/account/password', { body: { current_password: current, new_password: NEW } });
    assert.equal((await change(WRONG)).status, 422);
    const locked = await change(WRONG);
    assert.equal(locked.status, 423);
    assert.equal(locked.body.code, 'login_locked');
    assert.equal((await change(PASSWORD)).status, 423);
    assert.equal((await c.call('POST', '/api/v1/auth/reauth', { body: { password: PASSWORD } })).status, 423);
    assert.equal((await client().login(NAME, PASSWORD)).status, 423);
    assert.equal((await c.call('GET', '/api/v1/auth/session')).body.authenticated, true);
  });

  it('서버 운영자의 로컬 재설정으로만 풀린다', async () => {
    for (let i = 0; i < LIMIT; i++) await client().login(NAME, WRONG);
    assert.equal((await client().login(NAME, PASSWORD)).status, 423);
    const db = new Database(api.config);
    try {
      const r = await new AdminCommands(db, api.config).resetPassword(undefined, NEW);
      assert.equal(r.kind, 'ok');
    } finally {
      await db.pool.end();
    }
    assert.equal(await count('login_throttle'), 0);
    assert.equal((await client().login(NAME, NEW)).status, 200);
  });
});
