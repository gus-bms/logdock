// 수집 연결·서비스 보관과 재활성 시험(계약 5.1·5.3절, WQ-53~56). 임시 PostgreSQL에 마이그레이션을 적용하고 앱을 루프백 주소에
// 띄워 HTTP로 확인한다. 합성 이름·경로만 쓴다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { hashPassword } from '../auth/password.js';
import { type Api, Client, type EphemeralPostgres, startApi, startPostgres } from '../test-support/harness.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';

describe('수집 연결·서비스 보관과 재활성', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let c: Client;
  const post = (path: string, client = c) => client.call('POST', path, { headers: { 'idempotency-key': randomUUID() } });
  const one = async <T = any>(sql: string, values: unknown[] = []): Promise<T> => (await api.db.query(sql, values)).rows[0] as T;
  /** 연결을 등록하고 외부 ID와 키 ID를 돌려준다. 첫 연결은 새 서비스 order-api를 만들고 나머지는 서비스 1에 붙인다. */
  async function register(path: string, service: object = { id: 1, version: 1 }) {
    const r = await c.call('POST', '/api/v1/connections', {
      headers: { 'idempotency-key': randomUUID() },
      body: { service, server_display_name: 'app-01', target: { type: 'file', path }, format: { type: 'text' } },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { id: r.body.connection.id as string, keyId: r.body.key.key_id as string };
  }

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
      `TRUNCATE services, servers, connections, connection_configs, ingest_keys, connection_status, idempotency_keys,
                saved_searches, alert_rules, audit_log, audit_gaps, notices RESTART IDENTITY CASCADE`,
    );
    assert.equal((await c.call('POST', '/api/v1/auth/reauth', { body: { password: PASSWORD } })).status, 200);
  });

  it('연결을 보관하면 유효 키를 모두 무효로 하고, 설정 내려받기만 남는다', async () => {
    const a = await register('/var/app/order/app.log', { name: 'order-api' });
    const r = await post(`/api/v1/connections/${a.id}/archive`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.connection.management_state, 'archived');
    assert.equal(r.body.invalidated_keys, 1);
    assert.equal(r.body.stages.requested, r.body.connection.archived_at);
    assert.equal(r.body.stages.confirmed, r.body.connection.archived_at);
    assert.equal(r.body.stages.agent_observed, null);
    assert.deepEqual(await one('SELECT state, slot FROM ingest_keys'), { state: 'invalidated', slot: null });
    assert.deepEqual(await one(`SELECT action, target_ref, stage FROM audit_log WHERE action = 'connection.archive'`), {
      action: 'connection.archive',
      target_ref: a.id,
      stage: 'confirmed',
    });
    assert.equal((await post(`/api/v1/connections/${a.id}/archive`)).body.code, 'target_archived');
    assert.equal((await c.call('GET', `/api/v1/connections/${a.id}/config`)).status, 200);
    assert.equal((await post(`/api/v1/connections/${a.id}/keys`)).body.code, 'target_archived');
  });

  it('재활성하면 등록·연결 대기로 돌아가고 옛 키는 살아나지 않아 새 키를 받는다', async () => {
    const a = await register('/var/app/order/app.log', { name: 'order-api' });
    await post(`/api/v1/connections/${a.id}/archive`);
    const r = await post(`/api/v1/connections/${a.id}/reactivate`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.connection.management_state, 'pending');
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM ingest_keys WHERE state = 'valid'`)).n, 0);
    const issued = await post(`/api/v1/connections/${a.id}/keys`);
    assert.equal(issued.status, 201);
    assert.equal(issued.body.key.issued_as, 'issue');
    const again = await post(`/api/v1/connections/${a.id}/reactivate`);
    assert.equal(again.body.code, 'invalid_state');
    assert.deepEqual(again.body.params.current, { management_state: 'pending' });
  });

  it('보관한 사이 같은 서버·같은 대상이 다시 등록됐으면 재활성은 409 duplicate_connection이다', async () => {
    const a = await register('/var/app/order/app.log', { name: 'order-api' });
    await post(`/api/v1/connections/${a.id}/archive`);
    const b = await register('/var/app/order/app.log');
    const r = await post(`/api/v1/connections/${a.id}/reactivate`);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'duplicate_connection');
    assert.deepEqual(r.body.params, { connection_id: b.id });
  });

  it('서비스 보관 전 영향은 하위 연결과 대기, 이 서비스·연결을 쓰는 저장 검색과 알림 규칙이다', async () => {
    const a = await register('/var/app/order/app.log', { name: 'order-api' });
    const b = await register('/var/app/order/error.log');
    await api.db.query(
      `INSERT INTO connection_status (connection_id, last_report_at, report, agent_instance_id, agent_version, key_id)
       VALUES (1, now(), '{"queue": {"records": 3, "bytes": 512, "oldest_observed_at": "2026-11-07T00:00:00.000000Z"}}', 'a_test', '0.1.0', $1)`,
      [a.keyId],
    );
    const saved = (name: string, condition: object) =>
      api.db.query(
        `INSERT INTO saved_searches (owner_account_id, name, condition, time_mode, time_range, time_basis)
         VALUES (1, $1, $2, 'relative', '{"last": "1h"}', 'occurred')`,
        [name, condition],
      );
    await saved('order errors', { sources: { service_ids: [1] } });
    await saved('other', { sources: { service_ids: [99] } });
    await api.db.query(
      `INSERT INTO alert_rules (owner_account_id, name, enabled, condition, window_minutes, threshold)
       VALUES (1, 'error log spike', true, $1, 5, 10)`,
      [{ sources: { connection_ids: [b.id] } }],
    );
    const r = await c.call('GET', '/api/v1/services/1/archive-impact');
    assert.equal(r.status, 200);
    assert.equal(r.body.service.name, 'order-api');
    assert.deepEqual(
      r.body.connections.map((x: any) => [x.id, x.queue]),
      [
        [a.id, { records: 3, bytes: 512, oldest_observed_at: '2026-11-07T00:00:00.000000Z' }],
        [b.id, null],
      ],
    );
    assert.deepEqual(r.body.saved_searches, [{ id: 1, name: 'order errors' }]);
    assert.deepEqual(r.body.alert_rules, [{ id: 1, name: 'error log spike', enabled: true }]);
    assert.equal((await c.call('GET', '/api/v1/services/99/archive-impact')).status, 404);
  });

  it('서비스를 보관하면 하위 연결을 함께 보관하고, 재활성하면 함께 보관된 연결만 되살린다', async () => {
    const a = await register('/var/app/order/app.log', { name: 'order-api' });
    const b = await register('/var/app/order/error.log');
    await post(`/api/v1/connections/${b.id}/archive`); // 서비스 보관 전에 따로 보관
    const r = await post('/api/v1/services/1/archive');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.service.state, 'archived');
    assert.deepEqual(r.body.archived_connections, [a.id]);
    assert.equal(r.body.invalidated_keys, 1);
    assert.deepEqual(
      (await api.db.query('SELECT id, management_state, archived_with_service FROM connections ORDER BY id')).rows,
      [
        { id: 1, management_state: 'archived', archived_with_service: true },
        { id: 2, management_state: 'archived', archived_with_service: false },
      ],
    );
    // 서비스가 보관된 동안 연결만 따로 되살릴 수 없다
    assert.equal((await post(`/api/v1/connections/${a.id}/reactivate`)).body.code, 'target_archived');
    assert.equal((await post('/api/v1/services/1/archive')).body.code, 'target_archived');
    const back = await post('/api/v1/services/1/reactivate');
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.service.state, 'active');
    assert.deepEqual(back.body.reactivated_connections, [a.id]);
    assert.deepEqual(
      (await api.db.query('SELECT id, management_state, archived_with_service FROM connections ORDER BY id')).rows,
      [
        { id: 1, management_state: 'pending', archived_with_service: false },
        { id: 2, management_state: 'archived', archived_with_service: false },
      ],
    );
    assert.deepEqual(
      (await api.db.query(`SELECT action, target_ref, reason_code FROM audit_log WHERE action LIKE 'service.%' OR reason_code = 'with_service' ORDER BY id`)).rows,
      [
        { action: 'service.archive', target_ref: '1', reason_code: null },
        { action: 'connection.archive', target_ref: a.id, reason_code: 'with_service' },
        { action: 'service.reactivate', target_ref: '1', reason_code: null },
        { action: 'connection.reactivate', target_ref: a.id, reason_code: 'with_service' },
      ],
    );
    assert.equal((await post('/api/v1/services/1/reactivate')).body.code, 'invalid_state');
  });

  it('감사를 쓸 수 없으면 보관하지 않고 409 held_audit_unavailable이다', async () => {
    const a = await register('/var/app/order/app.log', { name: 'order-api' });
    await api.db.query(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit storage failure'; END $$`);
    await api.db.query('CREATE TRIGGER fail_audit BEFORE INSERT OR UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()');
    try {
      assert.equal((await post(`/api/v1/connections/${a.id}/archive`)).body.code, 'held_audit_unavailable');
      assert.equal((await post('/api/v1/services/1/archive')).body.code, 'held_audit_unavailable');
    } finally {
      await api.db.query('DROP TRIGGER fail_audit ON audit_log');
      await api.db.query('DROP FUNCTION fail_audit()');
    }
    assert.deepEqual(await one('SELECT management_state FROM connections'), { management_state: 'pending' });
    assert.deepEqual(await one('SELECT state FROM services'), { state: 'active' });
    assert.deepEqual(await one('SELECT state FROM ingest_keys'), { state: 'valid' });
  });

  it('최근 재확인이 없으면 403이고, 없는 연결·서비스는 404다', async () => {
    const a = await register('/var/app/order/app.log', { name: 'order-api' });
    const fresh = new Client(api.base);
    await fresh.login(NAME, PASSWORD);
    assert.equal((await post(`/api/v1/connections/${a.id}/archive`, fresh)).body.code, 'reauth_required');
    assert.equal((await post('/api/v1/services/1/archive', fresh)).body.code, 'reauth_required');
    assert.equal((await post('/api/v1/connections/c_zzzzzz/archive')).status, 404);
    assert.equal((await post('/api/v1/services/99/archive')).status, 404);
    assert.equal((await post('/api/v1/services/99/reactivate')).status, 404);
  });
});
