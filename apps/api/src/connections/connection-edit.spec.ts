// 수집 연결 설정 수정과 환경 태그·서버 바꾸기 시험(계약 5.1절 WQ-62·63). 임시 PostgreSQL에 마이그레이션을 적용하고 앱을
// 루프백 주소에 띄워 HTTP로 확인한다. 합성 이름·경로만 쓴다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { hashPassword } from '../auth/password.js';
import { type Api, Client, type EphemeralPostgres, startApi, startPostgres } from '../test-support/harness.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';

describe('수집 연결 설정 수정과 서버 바꾸기', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let c: Client;
  const one = async <T = any>(sql: string, values: unknown[] = []): Promise<T> => (await api.db.query(sql, values)).rows[0] as T;
  const patch = (id: string, body: unknown, client = c) => client.call('PATCH', `/api/v1/connections/${id}`, { body });
  const place = (id: string, body: unknown, client = c) => client.call('PATCH', `/api/v1/connections/${id}/placement`, { body });
  async function register(target: object, server: string | null = 'app-01', service: object = { id: 1, version: 1 }) {
    const r = await c.call('POST', '/api/v1/connections', {
      headers: { 'idempotency-key': randomUUID() },
      body: { service, server_display_name: server, target, format: { type: 'text' } },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.connection.id as string;
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
      `TRUNCATE services, servers, connections, connection_configs, ingest_keys, idempotency_keys, audit_log, audit_gaps, notices
       RESTART IDENTITY CASCADE`,
    );
    assert.equal((await c.call('POST', '/api/v1/auth/reauth', { body: { password: PASSWORD } })).status, 200);
  });

  it('형식을 고치면 새 설정 버전과 설정 파일을 주고, 감사에는 바뀐 항목 이름만 남긴다', async () => {
    const id = await register({ type: 'file', path: '/var/app/order/app.log' }, 'app-01', { name: 'order-api' });
    const r = await patch(id, { version: 1, format: { type: 'multiline', event_start: '^\\d{4}-', log_timezone: 'Asia/Seoul' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.connection, { id, config_version: 2, version: 2, management_state: 'pending' });
    assert.deepEqual(r.body.changed_fields, ['format.type', 'format.event_start', 'format.log_timezone']);
    assert.equal(r.body.config.config_version, 2);
    assert.match(r.body.config.content, /^config_version = 2$/m);
    assert.match(r.body.config.content, /^event_start = '\^\\d\{4\}-'$/m);
    assert.deepEqual((await api.db.query('SELECT version FROM connection_configs ORDER BY version')).rows, [{ version: 1 }, { version: 2 }]);
    assert.deepEqual(await one(`SELECT action, changed_fields FROM audit_log WHERE action = 'connection.update'`), {
      action: 'connection.update',
      changed_fields: ['format.type', 'format.event_start', 'format.log_timezone'],
    });
    // 이벤트 크기 상한을 빼면 지금 값을 둔다
    assert.equal((await one('SELECT max_event_bytes FROM connections')).max_event_bytes, api.config.maxEventBytes.default);
  });

  it('바뀐 것이 없으면 새 설정 버전을 만들지 않고, version이 다르면 409 version_conflict다', async () => {
    const id = await register({ type: 'file', path: '/var/app/order/app.log' }, 'app-01', { name: 'order-api' });
    const same = await patch(id, { version: 1, format: { type: 'text' } });
    assert.equal(same.status, 200);
    assert.deepEqual([same.body.connection.config_version, same.body.changed_fields], [1, []]);
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'connection.update'`)).n, 0);
    const stale = await patch(id, { version: 9, format: { type: 'json' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'version_conflict');
    assert.deepEqual(stale.body.params.current, { id, version: 1, config_version: 1 });
  });

  it('같은 폴더 안의 파일명 규칙만 고칠 수 있고, 그 밖의 대상 변경은 새 연결로 등록하라고 돌려보낸다', async () => {
    const pattern = await register({ type: 'file_pattern', path: '/var/app/order/app-*.log' }, 'app-01', { name: 'order-api' });
    const ok = await patch(pattern, { version: 1, target: { path: '/var/app/order/app-*.txt' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.changed_fields, ['target.path']);
    assert.match(ok.body.config.content, /^path = '\/var\/app\/order\/app-\*\.txt'$/m);
    for (const path of ['/var/app/other/app-*.log', '/var/app/order/sub/app-*.log']) {
      const r = await patch(pattern, { version: 2, target: { path } });
      assert.deepEqual(r.body.params.fields, [{ path: 'target.path', reason: 'new_connection_required' }], path);
    }
    const file = await register({ type: 'file', path: '/var/app/order/error.log' });
    assert.deepEqual((await patch(file, { version: 1, target: { path: '/var/app/order/error2.log' } })).body.params.fields, [
      { path: 'target.path', reason: 'new_connection_required' },
    ]);
    const bad = await patch(pattern, { version: 2, target: { path: '/var/app/order/app-[0-9].log' }, format: { type: 'multiline', event_start: '^(' } });
    assert.deepEqual(bad.body.params.fields, [
      { path: 'target.path', reason: 'wildcard_not_supported' },
      { path: 'format.event_start', reason: 'pattern_invalid', expr: '^(' },
    ]);
  });

  it('파일명 규칙을 고쳐 같은 서버의 다른 연결과 겹치면 409 duplicate_connection이다', async () => {
    const a = await register({ type: 'file_pattern', path: '/var/app/order/app-*.log' }, 'app-01', { name: 'order-api' });
    const b = await register({ type: 'file_pattern', path: '/var/app/order/app-*.txt' });
    const r = await patch(a, { version: 1, target: { path: '/var/app/order/app-*.txt' } });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.params, { connection_id: b });
  });

  it('설정 수정은 최근 재확인이 필요하고, 보관된 연결은 고칠 수 없으며, 감사를 쓸 수 없으면 보류한다', async () => {
    const id = await register({ type: 'file', path: '/var/app/order/app.log' }, 'app-01', { name: 'order-api' });
    const fresh = new Client(api.base);
    await fresh.login(NAME, PASSWORD);
    assert.equal((await patch(id, { version: 1, format: { type: 'json' } }, fresh)).body.code, 'reauth_required');
    await api.db.query(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit storage failure'; END $$`);
    await api.db.query('CREATE TRIGGER fail_audit BEFORE INSERT OR UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()');
    try {
      assert.equal((await patch(id, { version: 1, format: { type: 'json' } })).body.code, 'held_audit_unavailable');
      assert.equal((await place(id, { version: 1, environment: '운영' })).body.code, 'held_audit_unavailable');
    } finally {
      await api.db.query('DROP TRIGGER fail_audit ON audit_log');
      await api.db.query('DROP FUNCTION fail_audit()');
    }
    assert.deepEqual(await one('SELECT format_type, environment, config_version FROM connections'), {
      format_type: 'text',
      environment: null,
      config_version: 1,
    });
    await api.db.query(`UPDATE connections SET management_state = 'archived', archived_at = now()`);
    assert.equal((await patch(id, { version: 1, format: { type: 'json' } })).body.code, 'target_archived');
    assert.equal((await place(id, { version: 1, environment: '운영' })).body.code, 'target_archived');
  });

  it('환경 태그·서버 바꾸기는 재확인 없이 하고 설정 버전을 만들지 않으며 감사에 connection.move를 남긴다', async () => {
    const id = await register({ type: 'file', path: '/var/app/order/app.log' }, 'app-01', { name: 'order-api' });
    const fresh = new Client(api.base);
    await fresh.login(NAME, PASSWORD);
    const r = await place(id, { version: 1, server_display_name: 'app-02', environment: '운영' }, fresh);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, {
      connection: { id, server: { id: 2, display_name: 'app-02' }, environment: '운영', version: 2 },
      changed_fields: ['server', 'environment'],
    });
    assert.equal((await one('SELECT config_version FROM connections')).config_version, 1);
    assert.deepEqual(await one(`SELECT action, changed_fields FROM audit_log WHERE action = 'connection.move'`), {
      action: 'connection.move',
      changed_fields: ['server', 'environment'],
    });
    // 같은 이름(대소문자 무시)은 같은 서버로 묶고, null은 비운다
    const back = await place(id, { version: 2, server_display_name: 'APP-01', environment: null });
    assert.deepEqual(back.body.connection, { id, server: { id: 1, display_name: 'app-01' }, environment: null, version: 3 });
    const cleared = await place(id, { version: 3, server_display_name: null });
    assert.equal(cleared.body.connection.server, null);
  });

  it('다른 서버로 옮겼을 때 그 서버에 같은 대상이 있으면 409 duplicate_connection이다', async () => {
    const a = await register({ type: 'file', path: '/var/app/order/app.log' }, 'app-01', { name: 'order-api' });
    const b = await register({ type: 'file', path: '/var/app/order/app.log' }, 'app-02');
    const r = await place(a, { version: 1, server_display_name: 'app-02' });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.params, { connection_id: b });
  });
});
