// 수집 연결 등록 확정 시험(계약 4.1·4.3·5.1절). 임시 PostgreSQL에 마이그레이션을 적용하고 앱을 루프백 주소에 띄워
// HTTP로 확인한다. 만든 설정 파일은 agent/internal/config/testdata의 기준 파일과 글자까지 같아야 하고, 에이전트 시험
// (TestCentralConfigFile)이 같은 파일을 읽는다. 합성 이름·경로만 쓴다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { hashPassword } from '../auth/password.js';
import { type Api, Client, type EphemeralPostgres, startApi, startPostgres } from '../test-support/harness.js';
import { ingestKeyHash, parseIngestKey } from './keys.js';
import { encodeConnectionId } from './public-id.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';

function fixture(file: string): string {
  for (let dir = __dirname; ; ) {
    const p = join(dir, 'agent', 'internal', 'config', 'testdata', file);
    if (existsSync(p)) return readFileSync(p, 'utf8');
    const up = dirname(dir);
    if (up === dir) throw new Error(`fixture ${file} not found`);
    dir = up;
  }
}

const patternBody = () => ({
  service: { name: 'order-api' },
  server_display_name: 'app-01',
  environment: '운영',
  target: { type: 'file_pattern', path: '/var/app/order/app-*.log' },
  format: { type: 'multiline', event_start: '^\\d{4}-\\d{2}-\\d{2} ', log_timezone: 'Asia/Seoul', max_event_bytes: 65536 },
});

const journaldBody = () => ({
  service: { name: 'order-worker' },
  target: { type: 'journald', kind: 'unit', name: 'order-worker' },
  format: { type: 'multiline', event_start: "^\\d+ it's" },
});

describe('수집 연결 등록 확정', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let c: Client;
  const register = (body: unknown, key: string | null = randomUUID(), client = c) =>
    client.call('POST', '/api/v1/connections', { body, headers: key === null ? {} : { 'idempotency-key': key } });
  const count = async (table: string) => (await api.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
  const reauth = async (client = c) =>
    assert.equal((await client.call('POST', '/api/v1/auth/reauth', { body: { password: PASSWORD } })).status, 200);

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
    await reauth();
  });

  it('최근 재확인이 없으면 입력을 보기 전에 403 reauth_required이고 아무것도 만들지 않는다', async () => {
    const fresh = new Client(api.base);
    await fresh.login(NAME, PASSWORD);
    const r = await register({}, randomUUID(), fresh);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'reauth_required');
    assert.equal(await count('idempotency_keys'), 0);
  });

  it('서비스·서버·연결·설정 버전 1·키를 한 번에 만들고 키 원문과 에이전트가 읽는 설정 파일을 준다', async () => {
    const r = await register(patternBody());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const id = encodeConnectionId(1);
    assert.equal(r.body.connection.id, id);
    assert.deepEqual(r.body.connection.service, { id: 1, name: 'order-api' });
    assert.deepEqual(r.body.connection.server, { id: 1, display_name: 'app-01' });
    assert.equal(r.body.connection.environment, '운영');
    assert.equal(r.body.connection.management_state, 'pending');
    assert.equal(r.body.secret_unavailable, false);
    assert.deepEqual(r.body.config, {
      file_name: `${id}.toml`,
      key_file_name: `${id}.key`,
      config_version: 1,
      content: fixture('c_i905t9.toml'),
    });
    // 키: 원문은 응답에만 있고 DB에는 해시만 있다
    const parsed = parseIngestKey(r.body.key.key);
    assert.ok(parsed);
    assert.equal(parsed.keyId, r.body.key.key_id);
    const k = (await api.db.query('SELECT key_id, secret_hash, state, slot, issued_as FROM ingest_keys')).rows[0];
    assert.deepEqual(
      { ...k, secret_hash: undefined },
      { key_id: parsed.keyId, secret_hash: undefined, state: 'valid', slot: 1, issued_as: 'register' },
    );
    assert.ok(k.secret_hash.equals(ingestKeyHash(parsed.secret)));
    const conn = (await api.db.query('SELECT config_version, config_issued_at IS NOT NULL AS issued FROM connections')).rows[0];
    assert.deepEqual(conn, { config_version: 1, issued: true });
    assert.deepEqual(
      (await api.db.query('SELECT action, target_type, target_ref FROM audit_log ORDER BY id')).rows,
      [
        { action: 'connection.register', target_type: 'connection', target_ref: id },
        { action: 'key.issue', target_type: 'key', target_ref: parsed.keyId },
      ],
    );
  });

  it('journald unit 연결의 설정 파일도 에이전트 기준 파일과 같다', async () => {
    await register(patternBody());
    const r = await register(journaldBody());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.connection.server, null);
    assert.equal(r.body.config.content, fixture('c_zgamy.toml'));
  });

  it('같은 Idempotency-Key로 다시 보내면 다시 만들지 않고 처음 결과를 키 원문 없이 준다', async () => {
    const key = randomUUID();
    const first = await register(patternBody(), key);
    const again = await register(patternBody(), key);
    assert.equal(again.status, 201);
    assert.equal(again.body.connection.id, first.body.connection.id);
    assert.deepEqual(again.body.key, { key_id: first.body.key.key_id, key: null, issued_as: 'register' });
    assert.equal(again.body.secret_unavailable, true);
    assert.equal(again.body.config.content, first.body.config.content);
    assert.equal(await count('connections'), 1);
    const other = await register({ ...patternBody(), environment: '개발' }, key);
    assert.equal(other.status, 409);
    assert.equal(other.body.code, 'idempotency_key_reused');
  });

  it('두 번 누른 같은 요청이 동시에 와도 한 번만 만들고 키 원문은 한 응답에만 있다', async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([register(patternBody(), key), register(patternBody(), key)]);
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.equal(a.body.connection.id, b.body.connection.id);
    assert.equal([a, b].filter((r) => r.body.key.key !== null).length, 1);
    assert.equal(await count('connections'), 1);
    assert.equal(await count('ingest_keys'), 1);
  });

  it('Idempotency-Key가 없거나 꼴이 틀리면 422이고 남기지 않는다', async () => {
    const none = await register(patternBody(), null);
    assert.deepEqual(none.body.params.fields, [{ path: 'Idempotency-Key', reason: 'required' }]);
    const bad = await register(patternBody(), 'short');
    assert.deepEqual(bad.body.params.fields, [{ path: 'Idempotency-Key', reason: 'invalid' }]);
    assert.equal(await count('idempotency_keys'), 0);
  });

  it('입력 오류와 같은 서버·같은 대상은 만들지 않고, 같은 키로 고쳐 다시 보낼 수 있다', async () => {
    const key = randomUUID();
    const bad = await register({ ...patternBody(), target: { type: 'file', path: 'relative.log' } }, key);
    assert.equal(bad.status, 422);
    assert.equal(await count('idempotency_keys'), 0);
    assert.equal((await register(patternBody(), key)).status, 201);
    const dup = await register({ ...patternBody(), service: { id: 1, version: 1 }, server_display_name: 'APP-01' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'duplicate_connection');
    assert.deepEqual(dup.body.params, { connection_id: encodeConnectionId(1) });
    assert.equal(await count('connections'), 1);
  });

  it('기존 서비스에 붙이면 서비스를 새로 만들지 않고, 같은 서버 이름은 같은 서버로 묶는다', async () => {
    await register(patternBody());
    const r = await register({
      ...patternBody(),
      service: { id: 1, version: 1 },
      server_display_name: 'APP-01',
      target: { type: 'file', path: '/var/app/order/error.log' },
      format: { type: 'text' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.connection.service, { id: 1, name: 'order-api' });
    assert.deepEqual(r.body.connection.server, { id: 1, display_name: 'app-01' });
    assert.equal(await count('services'), 1);
    assert.equal(await count('servers'), 1);
  });

  it('감사를 쓸 수 없으면 아무것도 만들지 않고 409 held_audit_unavailable이며, 복구 뒤 같은 키로 다시 보낼 수 있다', async () => {
    const key = randomUUID();
    await api.db.query(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit storage failure'; END $$`);
    await api.db.query('CREATE TRIGGER fail_audit BEFORE INSERT OR UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()');
    try {
      const r = await register(patternBody(), key);
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'held_audit_unavailable');
    } finally {
      await api.db.query('DROP TRIGGER fail_audit ON audit_log');
      await api.db.query('DROP FUNCTION fail_audit()');
    }
    for (const t of ['services', 'servers', 'connections', 'connection_configs', 'ingest_keys', 'idempotency_keys']) {
      assert.equal(await count(t), 0, t);
    }
    const retry = await register(patternBody(), key);
    assert.equal(retry.status, 201);
    assert.ok(retry.body.key.key);
  });

  it('설정 내려받기는 키 없이 마지막 설정 파일을 주고, 없는 연결은 404다', async () => {
    const reg = await register(patternBody());
    const r = await c.call('GET', `/api/v1/connections/${reg.body.connection.id}/config`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, reg.body.config);
    assert.ok(!r.body.content.includes('ldk_'));
    for (const id of [encodeConnectionId(99), 'c_bad', '42']) {
      assert.equal((await c.call('GET', `/api/v1/connections/${id}/config`)).status, 404, id);
    }
  });
});
