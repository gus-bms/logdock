// 수집 키 발급·교체·폐기 시험(계약 5.1·5.2절, Q10-07~11·14). 임시 PostgreSQL에 마이그레이션을 적용하고 앱을 루프백 주소에
// 띄워 HTTP로 확인한다. 상태는 시험이 DB로 바꿔 수신 서버가 기록할 확정·관측을 흉내 낸다. 합성 이름·경로만 쓴다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { hashPassword } from '../auth/password.js';
import { type Api, Client, type EphemeralPostgres, startApi, startPostgres } from '../test-support/harness.js';
import { parseIngestKey } from './keys.js';
import { encodeConnectionId } from './public-id.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';

describe('수집 키 발급·교체·폐기', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let c: Client;
  let connectionId: string;
  let firstKey: string;
  const issue = (id = connectionId, key: string = randomUUID(), client = c) =>
    client.call('POST', `/api/v1/connections/${id}/keys`, { headers: { 'idempotency-key': key } });
  const revoke = (keyId: string, client = c) => client.call('POST', `/api/v1/keys/${keyId}/revoke`);
  const one = async <T = any>(sql: string, values: unknown[] = []): Promise<T> => (await api.db.query(sql, values)).rows[0] as T;
  const validKeys = async () => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ingest_keys WHERE state = 'valid'`)).n;

  before(async () => {
    pg = await startPostgres();
    api = await startApi(pg);
    await api.db.query('INSERT INTO accounts (name, password_hash) VALUES ($1, $2)', [NAME, await hashPassword(PASSWORD)]);
    c = new Client(api.base);
    assert.equal((await c.login(NAME, PASSWORD)).status, 200);
  });

  after(async () => {
    await api?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    await api.db.query(
      'TRUNCATE services, servers, connections, connection_configs, ingest_keys, idempotency_keys, audit_log, audit_gaps, notices RESTART IDENTITY CASCADE',
    );
    assert.equal((await c.call('POST', '/api/v1/auth/reauth', { body: { password: PASSWORD } })).status, 200);
    const r = await c.call('POST', '/api/v1/connections', {
      headers: { 'idempotency-key': randomUUID() },
      body: { service: { name: 'order-api' }, target: { type: 'file', path: '/var/app/order/app.log' }, format: { type: 'text' } },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    connectionId = r.body.connection.id;
    firstKey = r.body.key.key_id;
    await api.db.query('TRUNCATE audit_log');
  });

  it('최근 재확인이 없으면 발급·폐기 모두 403 reauth_required다', async () => {
    const fresh = new Client(api.base);
    await fresh.login(NAME, PASSWORD);
    assert.equal((await issue(connectionId, randomUUID(), fresh)).body.code, 'reauth_required');
    assert.equal((await revoke(firstKey, fresh)).body.code, 'reauth_required');
  });

  it('유효 키가 1개면 교체해 자리 2에 넣고, 2개면 409 key_limit_reached다', async () => {
    const r = await issue();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.key.issued_as, 'rotate');
    assert.equal(r.body.key.slot, 2);
    assert.equal(parseIngestKey(r.body.key.key)?.keyId, r.body.key.key_id);
    assert.deepEqual(r.body.connection, { id: connectionId, management_state: 'pending' });
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await one('SELECT action, target_ref FROM audit_log'), { action: 'key.rotate', target_ref: r.body.key.key_id });
    const third = await issue();
    assert.equal(third.status, 409);
    assert.equal(third.body.code, 'key_limit_reached');
    assert.equal(await validKeys(), 2);
  });

  it('폐기하면 폐기 요청 상태로 자리를 비우고, 다시 폐기해도 오류 없이 지금 상태를 준다', async () => {
    await issue();
    const r = await revoke(firstKey);
    assert.equal(r.status, 200);
    assert.equal(r.body.key.state, 'revoke_requested');
    assert.equal(r.body.key.connection_id, connectionId);
    assert.match(r.body.stages.requested, /Z$/);
    assert.deepEqual([r.body.stages.confirmed, r.body.stages.agent_observed, r.body.audit_gap], [null, null, false]);
    const revokeRows = `SELECT action, target_ref, stage FROM audit_log WHERE action = 'key.revoke'`;
    assert.deepEqual((await api.db.query(revokeRows)).rows, [{ action: 'key.revoke', target_ref: firstKey, stage: 'requested' }]);
    const again = await revoke(firstKey);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.key, r.body.key);
    assert.equal((await api.db.query(revokeRows)).rows.length, 1);
    // 비운 자리 1에 다시 교체할 수 있다
    const next = await issue();
    assert.deepEqual([next.body.key.issued_as, next.body.key.slot], ['rotate', 1]);
  });

  it('유효 키가 없는 전송 차단 연결에 발급하면 등록·연결 대기로 돌아간다', async () => {
    await api.db.query(`UPDATE ingest_keys SET state = 'revoked', slot = NULL, revoke_requested_at = now(), revoked_at = now()`);
    await api.db.query(`UPDATE connections SET management_state = 'blocked'`);
    const r = await issue();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.key.issued_as, r.body.key.slot], ['issue', 1]);
    assert.equal(r.body.connection.management_state, 'pending');
    assert.equal((await one('SELECT action FROM audit_log')).action, 'key.issue');
  });

  it('사용 중인데 폐기 확정 전이라 유효 키가 없으면 발급은 409 invalid_state다', async () => {
    await api.db.query(`UPDATE ingest_keys SET state = 'revoke_requested', slot = NULL, revoke_requested_at = now()`);
    await api.db.query(`UPDATE connections SET management_state = 'active'`);
    const r = await issue();
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'invalid_state');
    assert.deepEqual(r.body.params.current, { management_state: 'active' });
  });

  it('보관된 연결의 키에는 발급·폐기 모두 409 target_archived다', async () => {
    await api.db.query(`UPDATE ingest_keys SET state = 'invalidated', slot = NULL, invalidated_at = now()`);
    await api.db.query(`UPDATE connections SET management_state = 'archived', archived_at = now()`);
    assert.equal((await issue()).body.code, 'target_archived');
    assert.equal((await revoke(firstKey)).body.code, 'target_archived');
  });

  it('같은 Idempotency-Key로 다시 보내면 새 키를 만들지 않고 원문 없이 준다', async () => {
    const key = randomUUID();
    const first = await issue(connectionId, key);
    const again = await issue(connectionId, key);
    assert.equal(again.status, 201);
    assert.equal(again.body.key.key_id, first.body.key.key_id);
    assert.equal(again.body.key.key, null);
    assert.equal(again.body.secret_unavailable, true);
    assert.equal(await validKeys(), 2);
    // 같은 키를 다른 연결에 쓰면 다른 요청이다
    assert.equal((await issue(encodeConnectionId(2), key)).body.code, 'idempotency_key_reused');
  });

  it('동시에 두 번 눌러도 유효 키는 둘을 넘지 않는다', async () => {
    const results = await Promise.all([issue(), issue()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(results.find((r) => r.status === 409)!.body.code, 'key_limit_reached');
    assert.equal(await validKeys(), 2);
  });

  it('감사를 쓸 수 없으면 발급·교체는 보류하고, 폐기는 차단 상태를 확정해 진행하며 감사 공백을 남긴다', async () => {
    await api.db.query(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit storage failure'; END $$`);
    await api.db.query('CREATE TRIGGER fail_audit BEFORE INSERT OR UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()');
    try {
      const held = await issue();
      assert.equal(held.status, 409);
      assert.equal(held.body.code, 'held_audit_unavailable');
      assert.equal(await validKeys(), 1);
      const r = await revoke(firstKey);
      assert.equal(r.status, 200);
      assert.equal(r.body.audit_gap, true);
      assert.equal(r.body.key.state, 'revoke_requested');
    } finally {
      await api.db.query('DROP TRIGGER fail_audit ON audit_log');
      await api.db.query('DROP FUNCTION fail_audit()');
    }
    assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM audit_gaps')).n, 1);
  });

  it('없는 연결과 키는 404다', async () => {
    assert.equal((await issue(encodeConnectionId(99))).status, 404);
    assert.equal((await issue('c_bad!')).status, 404);
    assert.equal((await revoke('0123456789abcdef')).status, 404);
    assert.equal((await revoke('BAD-KEY')).status, 404);
  });
});
