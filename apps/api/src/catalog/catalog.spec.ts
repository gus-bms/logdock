// 서비스·서버 목록과 이름 변경 시험(계약 4.3·5.3절). 임시 PostgreSQL에 마이그레이션을 적용하고 앱을 루프백 주소에 띄워
// HTTP로 확인한다. 합성 이름만 쓴다.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { hashPassword } from '../auth/password.js';
import { type Api, Client, type EphemeralPostgres, startApi, startPostgres } from '../test-support/harness.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';

describe('서비스·서버 이름', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let c: Client;
  const one = async <T = any>(sql: string, values: unknown[] = []): Promise<T> =>
    (await api.db.query(sql, values)).rows[0] as T;
  const patch = (path: string, body: unknown) => c.call('PATCH', path, { body });

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
    await api.db.query('TRUNCATE services, servers, audit_log, audit_gaps, notices RESTART IDENTITY CASCADE');
    await api.db.query(`INSERT INTO services (name) VALUES ('order-api')`);
    await api.db.query(`INSERT INTO services (name, state, archived_at) VALUES ('billing', 'archived', now())`);
    await api.db.query(`INSERT INTO servers (display_name) VALUES ('app-01'), ('app-02')`);
  });

  it('목록은 대소문자를 가리지 않는 이름순이고 보관된 서비스도 상태와 함께 준다', async () => {
    const s = await c.call('GET', '/api/v1/services');
    assert.equal(s.status, 200);
    assert.deepEqual(
      s.body.items.map((i: any) => [i.id, i.name, i.state, i.archived_at === null, i.version]),
      [
        [2, 'billing', 'archived', false, 1],
        [1, 'order-api', 'active', true, 1],
      ],
    );
    assert.match(s.body.items[0].archived_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    const v = await c.call('GET', '/api/v1/servers');
    assert.deepEqual(v.body.items, [
      { id: 1, display_name: 'app-01', version: 1 },
      { id: 2, display_name: 'app-02', version: 1 },
    ]);
  });

  it('이름을 바꾸면 NFC로 맞춰 저장하고 version을 올리며 감사에는 바뀐 항목 이름만 남긴다', async () => {
    const r = await patch('/api/v1/services/1', { name: `  ${'주문 API'.normalize('NFD')}  `, version: 1 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { id: 1, name: '주문 API', state: 'active', archived_at: null, version: 2 });
    assert.equal((await one<{ ok: boolean }>(`SELECT name IS NFC NORMALIZED AS ok FROM services WHERE id = 1`)).ok, true);
    assert.deepEqual(await one(`SELECT action, target_type, target_ref, changed_fields, result FROM audit_log`), {
      action: 'service.rename',
      target_type: 'service',
      target_ref: '1',
      changed_fields: ['name'],
      result: 'success',
    });
  });

  it('같은 이름이면 바꾸지 않고 감사도 남기지 않는다. 대소문자만 바꾸는 것은 이름 변경이다', async () => {
    const same = await patch('/api/v1/services/1', { name: 'order-api', version: 1 });
    assert.equal(same.status, 200);
    assert.equal(same.body.version, 1);
    assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM audit_log')).n, 0);
    const cased = await patch('/api/v1/services/1', { name: 'Order-API', version: 1 });
    assert.equal(cased.status, 200);
    assert.equal(cased.body.version, 2);
  });

  it('겹치는 이름은 보관된 서비스까지 대소문자를 가리지 않고 막는다', async () => {
    const r = await patch('/api/v1/services/1', { name: 'BILLING', version: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'name_taken');
    assert.deepEqual(r.body.params, { path: 'name' });
    assert.equal((await one<{ name: string }>('SELECT name FROM services WHERE id = 1')).name, 'order-api');
  });

  it('보관된 서비스는 이름을 바꿀 수 없다', async () => {
    const r = await patch('/api/v1/services/2', { name: 'billing-v2', version: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'target_archived');
  });

  it('version이 다르면 409 version_conflict와 지금 값을 준다', async () => {
    await patch('/api/v1/services/1', { name: 'orders', version: 1 });
    const r = await patch('/api/v1/services/1', { name: 'order-service', version: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'version_conflict');
    assert.deepEqual(r.body.params.current, { id: 1, name: 'orders', state: 'active', archived_at: null, version: 2 });
  });

  it('이름 규칙: 빈 값, 상한 초과, 제어 문자, version 누락은 422다', async () => {
    const cases: [unknown, string, string][] = [
      [{ name: '   ', version: 1 }, 'name', 'too_small'],
      [{ name: 'x'.repeat(api.config.nameMaxLength + 1), version: 1 }, 'name', 'too_big'],
      [{ name: 'order\u0007api', version: 1 }, 'name', 'control_characters'],
      [{ name: 'orders' }, 'version', 'invalid_type'],
    ];
    for (const [body, path, reason] of cases) {
      const r = await patch('/api/v1/services/1', body);
      assert.equal(r.status, 422, JSON.stringify(body));
      assert.deepEqual(r.body.params.fields, [{ path, reason }], JSON.stringify(body));
    }
    assert.equal((await c.call('PATCH', '/api/v1/services/1', { body: { name: 'x'.repeat(api.config.nameMaxLength), version: 1 } })).status, 200);
  });

  it('없는 ID와 정수가 아닌 ID는 404다', async () => {
    for (const id of ['999999', 'abc', '0', '01', '99999999999']) {
      const r = await patch(`/api/v1/services/${id}`, { name: 'orders', version: 1 });
      assert.equal(r.status, 404, id);
      assert.equal(r.body.code, 'not_found', id);
    }
  });

  it('감사를 남길 수 없으면 바꾸지 않고 409 held_audit_unavailable로 보류한다', async () => {
    await api.db.query(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit storage failure'; END $$`);
    await api.db.query('CREATE TRIGGER fail_audit BEFORE INSERT OR UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()');
    try {
      const r = await patch('/api/v1/services/1', { name: 'orders', version: 1 });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'held_audit_unavailable');
    } finally {
      await api.db.query('DROP TRIGGER fail_audit ON audit_log');
      await api.db.query('DROP FUNCTION fail_audit()');
    }
    assert.deepEqual(await one('SELECT name, version FROM services WHERE id = 1'), { name: 'order-api', version: 1 });
  });

  it('서버 표시명도 같은 규칙으로 바꾸고 감사에 server.rename을 남긴다', async () => {
    const r = await patch('/api/v1/servers/1', { display_name: 'web-01', version: 1 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { id: 1, display_name: 'web-01', version: 2 });
    assert.deepEqual(await one(`SELECT action, target_ref, changed_fields FROM audit_log`), {
      action: 'server.rename',
      target_ref: '1',
      changed_fields: ['display_name'],
    });
    const taken = await patch('/api/v1/servers/2', { display_name: 'WEB-01', version: 1 });
    assert.equal(taken.status, 409);
    assert.deepEqual(taken.body.params, { path: 'display_name' });
  });

  it('세션이 없으면 401이고 CSRF 토큰이 없으면 바꾸지 않는다', async () => {
    assert.equal((await new Client(api.base).call('GET', '/api/v1/services')).status, 401);
    const r = await c.call('PATCH', '/api/v1/services/1', { body: { name: 'orders', version: 1 }, csrf: false });
    assert.equal(r.status, 403);
    assert.equal((await one<{ name: string }>('SELECT name FROM services WHERE id = 1')).name, 'order-api');
  });
});
