// 수집 연결 사전 검사 시험(계약 2.8·4.3·5.1절). 수집 대상과 형식은 에이전트와 같은 Go 코드(WebAssembly)로 본다.
// 임시 PostgreSQL에 마이그레이션을 적용하고 앱을 루프백 주소에 띄워 HTTP로 확인한다. 합성 이름·경로만 쓴다.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { hashPassword } from '../auth/password.js';
import { type Api, Client, type EphemeralPostgres, startApi, startPostgres } from '../test-support/harness.js';
import { encodeConnectionId } from './public-id.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';

const base = () => ({
  service: { name: 'order-api' },
  server_display_name: 'app-01',
  environment: '운영',
  target: { type: 'file', path: '/var/app/order/app.log' },
  format: { type: 'text' },
});

describe('수집 연결 사전 검사', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let c: Client;
  const validate = (body: unknown) => c.call('POST', '/api/v1/connections/validate', { body });
  const count = async (table: string) => (await api.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;

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
    await api.db.query('TRUNCATE services, servers, connections, audit_log RESTART IDENTITY CASCADE');
  });

  it('통과하면 저장할 형태로 맞춘 값을 돌려주고 아무것도 만들지 않는다', async () => {
    const r = await validate({ ...base(), environment: '  운영  ', format: { type: 'text', log_timezone: 'Asia/Seoul' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      valid: true,
      service: { id: null, name: 'order-api', new: true },
      server_display_name: 'app-01',
      environment: '운영',
      target: { type: 'file', path: '/var/app/order/app.log', kind: null, name: null },
      format: { type: 'text', event_start: null, log_timezone: 'Asia/Seoul', max_event_bytes: api.config.maxEventBytes.default },
    });
    for (const t of ['services', 'servers', 'connections']) assert.equal(await count(t), 0, t);
  });

  it('journald unit 이름에 종류 접미사가 없으면 .service를 붙인다', async () => {
    const r = await validate({ ...base(), target: { type: 'journald', kind: 'unit', name: 'nginx' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.target, { type: 'journald', path: null, kind: 'unit', name: 'nginx.service' });
  });

  it('새 이벤트 시작 규칙은 에이전트와 같은 Go 문법으로 검사하고 오류가 난 부분을 준다', async () => {
    const ok = await validate({ ...base(), format: { type: 'multiline', event_start: '(?i)^\\d{4}-\\d{2}-\\d{2} ' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    for (const [pattern, expr] of [
      ['^(\\d{4}-', '^(\\d{4}-'],
      ['(?<=x)ERROR', '(?<=x)ERROR'],
    ]) {
      const r = await validate({ ...base(), format: { type: 'multiline', event_start: pattern } });
      assert.equal(r.status, 422, pattern);
      assert.deepEqual(r.body.params.fields, [{ path: 'format.event_start', reason: 'pattern_invalid', expr }], pattern);
    }
    const missing = await validate({ ...base(), format: { type: 'multiline' } });
    assert.deepEqual(missing.body.params.fields, [{ path: 'format.event_start', reason: 'required' }]);
  });

  it('여러 칸의 문제를 한 번에 돌려준다', async () => {
    const r = await validate({
      service: {},
      server_display_name: 'app\u000701',
      target: { type: 'file_pattern', path: '/var/*/app.log' },
      format: { type: 'text', log_timezone: 'Mars/Base', max_event_bytes: 0 },
      extraction_rule: { time: '(?P<time>\\S+)' },
    });
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.params.fields, [
      { path: 'service', reason: 'required' },
      { path: 'server_display_name', reason: 'control_characters' },
      { path: 'target.path', reason: 'wildcard_in_folder' },
      { path: 'format.log_timezone', reason: 'timezone_invalid' },
      { path: 'format.max_event_bytes', reason: 'too_small' },
      { path: 'extraction_rule', reason: 'not_supported' },
    ]);
  });

  it('기존 서비스는 있고 보관되지 않았으며 version이 같아야 한다. 새 이름은 겹치지 않아야 한다', async () => {
    await api.db.query(`INSERT INTO services (name) VALUES ('order-api')`);
    await api.db.query(`INSERT INTO services (name, state, archived_at, version) VALUES ('billing', 'archived', now(), 2)`);
    assert.equal((await validate({ ...base(), service: { id: 1, version: 1 } })).body.service.new, false);
    const stale = await validate({ ...base(), service: { id: 1, version: 7 } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'version_conflict');
    assert.equal(stale.body.params.current.name, 'order-api');
    assert.equal((await validate({ ...base(), service: { id: 2, version: 2 } })).body.code, 'target_archived');
    const missing = await validate({ ...base(), service: { id: 99, version: 1 } });
    assert.deepEqual(missing.body.params.fields, [{ path: 'service.id', reason: 'not_found' }]);
    const taken = await validate({ ...base(), service: { name: 'BILLING' } });
    assert.equal(taken.status, 409);
    assert.deepEqual(taken.body.params, { path: 'service.name' });
    const both = await validate({ ...base(), service: { id: 1, version: 1, name: 'x' } });
    assert.deepEqual(both.body.params.fields, [{ path: 'service', reason: 'id_or_name' }]);
  });

  it('같은 서버·같은 대상의 보관되지 않은 연결이 있으면 그 연결의 외부 ID와 함께 막는다', async () => {
    await api.db.query(`INSERT INTO services (name) VALUES ('order-api')`);
    await api.db.query(`INSERT INTO servers (display_name) VALUES ('app-01')`);
    await api.db.query(`INSERT INTO connections (service_id, server_id, target_type, target_path, format_type, max_event_bytes)
                        VALUES (1, 1, 'file', '/var/app/order/app.log', 'text', 1024)`);
    const existing = { ...base(), service: { id: 1, version: 1 } };
    const r = await validate({ ...existing, server_display_name: 'APP-01' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'duplicate_connection');
    assert.deepEqual(r.body.params, { connection_id: encodeConnectionId(1) });
    // 서버 표시명이 없으면 여기서는 알 수 없어 막지 않는다(에이전트 적용 때 확인)
    assert.equal((await validate({ ...existing, server_display_name: null })).status, 200);
    // 보관된 연결은 겹침으로 보지 않는다
    await api.db.query(`UPDATE connections SET management_state = 'archived', archived_at = now()`);
    assert.equal((await validate(existing)).status, 200);
  });
});
