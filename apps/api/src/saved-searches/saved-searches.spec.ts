// 저장 검색 시험(계약 4.2·4.3절, Q11, UI-05). 임시 PostgreSQL에 마이그레이션을 적용하고 앱을 루프백 주소에 띄워 HTTP로
// 확인한다. 합성 이름·경로만 쓴다. 상한을 시험하려고 저장 개수 상한을 3, 조건 수 상한을 3으로 낮춰 띄운다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { hashPassword } from '../auth/password.js';
import { DEFAULTS } from '../config.js';
import { encodeConnectionId } from '../connections/public-id.js';
import { type Api, Client, type EphemeralPostgres, type Reply, startApi, startPostgres } from '../test-support/harness.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';
const REL = { mode: 'relative', last: 'PT1H', basis: 'occurred' };

describe('저장 검색', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let c: Client;
  const one = async <T = any>(sql: string, values: unknown[] = []): Promise<T> => (await api.db.query(sql, values)).rows[0] as T;
  const create = (body: object, key = randomUUID()): Promise<Reply> =>
    c.call('POST', '/api/v1/saved-searches', { headers: { 'idempotency-key': key }, body });
  const patch = (id: number | string, body: object) => c.call('PATCH', `/api/v1/saved-searches/${id}`, { body });
  const named = (name: string, condition: object = { levels: ['ERROR'] }, time: object = REL) => create({ name, condition, time });
  /** 연결을 등록하고 외부 ID를 돌려준다. 첫 연결은 새 서비스 order-api(ID 1)와 서버 app-01(ID 1)을 만든다. */
  async function register(path: string, service: object = { id: 1, version: 1 }): Promise<string> {
    const r = await c.call('POST', '/api/v1/connections', {
      headers: { 'idempotency-key': randomUUID() },
      body: { service, server_display_name: 'app-01', target: { type: 'file', path }, format: { type: 'text' } },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.connection.id as string;
  }
  const reasons = (r: Reply) => (r.body.params.fields as { path: string; reason: string }[]).map((f) => `${f.path}:${f.reason}`).sort();

  before(async () => {
    pg = await startPostgres();
    api = await startApi(pg, { savedSearchLimit: 3, search: { ...DEFAULTS.search, maxConditions: 3 } });
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

  it('조건을 저장할 형태로 맞춰 만들고, 가리키는 대상의 이름을 함께 주며 감사에 남기지 않는다', async () => {
    const conn = await register('/var/app/order/app.log', { name: 'order-api' });
    const audits = (await one<{ n: number }>('SELECT count(*)::int AS n FROM audit_log')).n;
    const body = {
      name: '  주문 오류 ',
      condition: {
        sources: { service_ids: [1, 1], server_ids: [1, null], environments: ['운영', null], connection_ids: [conn] },
        levels: ['ERROR', 'WARN', 'ERROR'],
        body: [{ op: 'contains', text: 'timeout' }, { op: 'not_contains', text: 'Health', case_sensitive: true }],
        fields: [{ path: 'http.status', op: 'gte', value: 500 }],
      },
      time: REL,
    };
    const key = randomUUID();
    const r = await create(body, key);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.name, '주문 오류');
    assert.deepEqual(r.body.condition, {
      sources: { service_ids: [1], server_ids: [1, null], environments: ['운영', null], connection_ids: [conn] },
      levels: ['ERROR', 'WARN'],
      body: [
        { op: 'contains', text: 'timeout', case_sensitive: false },
        { op: 'not_contains', text: 'Health', case_sensitive: true },
      ],
      fields: [{ path: 'http.status', op: 'gte', value: 500 }],
    });
    assert.deepEqual(r.body.time, REL);
    assert.deepEqual(r.body.references, {
      services: [{ id: 1, name: 'order-api', state: 'active' }],
      servers: [{ id: 1, display_name: 'app-01' }],
      connections: [
        { id: conn, server_display_name: 'app-01', target: { type: 'file', path: '/var/app/order/app.log', kind: null, name: null }, management_state: 'pending' },
      ],
    });
    assert.equal(r.body.references_archived, false);
    assert.equal(r.body.version, 1);
    assert.match(r.body.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

    // 같은 키로 다시 보내면 다시 만들지 않고 같은 저장 검색을 준다. 내용이 다르면 409다.
    const again = await create(body, key);
    assert.equal(again.status, 201);
    assert.equal(again.body.id, r.body.id);
    assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM saved_searches')).n, 1);
    assert.equal((await create({ ...body, name: '다른 이름' }, key)).body.code, 'idempotency_key_reused');
    const noKey = await c.call('POST', '/api/v1/saved-searches', { body });
    assert.equal(noKey.status, 422);
    assert.deepEqual(reasons(noKey), ['Idempotency-Key:required']);

    assert.equal((await patch(r.body.id, { version: 1, name: '주문 오류 2' })).status, 200);
    assert.equal((await c.call('DELETE', `/api/v1/saved-searches/${r.body.id}`)).status, 204);
    assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM audit_log')).n, audits);
  });

  it('상대 시간은 그대로, 고정 시간은 UTC로 맞춰 두고 잘못된 시간은 422다', async () => {
    const a = await named('고정', {}, { mode: 'absolute', from: '2026-11-05T10:00:00+09:00', to: '2026-11-05T10:30:00.5+09:00', basis: 'received' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual(a.body.time, { mode: 'absolute', from: '2026-11-05T01:00:00.000000Z', to: '2026-11-05T01:30:00.500000Z', basis: 'received' });
    assert.equal((await named('일주일', {}, { mode: 'relative', last: 'P7D', basis: 'occurred' })).status, 201);
    assert.equal((await named('한 시간 반', {}, { mode: 'relative', last: 'PT1H30M', basis: 'occurred' })).status, 201);

    const bad = async (time: object) => reasons(await named('잘못된 시간', {}, time));
    const at = '2026-11-05T01:00:00Z';
    assert.deepEqual(await bad({ mode: 'absolute', from: at, to: at, basis: 'occurred' }), ['time.to:not_after_from']);
    assert.deepEqual(await bad({ mode: 'absolute', from: '2026-02-30T10:00:00Z', to: at, basis: 'occurred' }), ['time.from:time_invalid']);
    assert.deepEqual(await bad({ mode: 'absolute', from: '2026-11-05T10:00:00', to: '2026-11-05T25:00:00Z', basis: 'occurred' }), [
      'time.from:time_invalid',
      'time.to:time_invalid',
    ]);
    assert.deepEqual(await bad({ mode: 'absolute', from: at, basis: 'occurred' }), ['time.to:time_invalid']);
    for (const last of ['P0D', 'PT', 'P', '1H', 'P1W', 'PT1h', 'P1000000D']) {
      assert.deepEqual(await bad({ mode: 'relative', last, basis: 'occurred' }), ['time.last:duration_invalid'], last);
    }
    assert.deepEqual(await bad({ mode: 'relative', last: 'PT1H', from: at, basis: 'occurred' }), ['time:absolute_fields_not_allowed']);
    assert.deepEqual(await bad({ mode: 'absolute', last: 'PT1H', from: at, to: '2026-11-05T02:00:00Z', basis: 'occurred' }), [
      'time:relative_fields_not_allowed',
    ]);
    assert.deepEqual(await bad({ mode: 'relative', last: 'PT1H' }), ['time.basis:invalid_value']);
  });

  it('조건의 꼴과 한도를 칸마다 모두 보고, 꼴이 맞으면 가리키는 대상이 있는지 본다', async () => {
    const r = await named('', {
      sources: { connection_ids: ['c_!!'] },
      body: [{ op: 'contains', text: '' }, { op: 'contains', text: 'a\u0000b' }],
      fields: [
        { path: 'a..b', op: 'eq', value: 1 },
        { path: 'x', op: 'gt', value: '5' },
        { path: 'y', op: 'exists', value: 1 },
        { path: 'z', op: 'eq' },
      ],
    });
    assert.equal(r.status, 422);
    assert.deepEqual(reasons(r), [
      'condition.body.0.text:too_small',
      'condition.body.1.text:invalid_characters',
      'condition.fields.0.path:path_invalid',
      'condition.fields.1.value:number_required',
      'condition.fields.2.value:value_not_allowed',
      'condition.fields.3.value:required',
      'condition.sources.connection_ids.0:not_found',
      'condition:too_many_conditions',
      'name:too_small',
    ]);
    // 짝 없는 서로게이트는 jsonb에 넣을 수 없어 500 대신 422로 돌려준다. NUL은 이름 규칙대로 제어 문자다.
    assert.deepEqual(reasons(await named('\ud800깨진 이름')), ['name:invalid_characters']);
    assert.deepEqual(reasons(await named('환경', { sources: { environments: ['운영\u0000', '\udc00'] } })), [
      'condition.sources.environments.0:control_characters',
      'condition.sources.environments.1:invalid_characters',
    ]);
    // DB의 정수 ID 범위를 넘는 값은 DB에 보내지 않고 422다.
    assert.deepEqual(reasons(await named('큰 ID', { sources: { service_ids: [2147483648] } })), ['condition.sources.service_ids.0:too_big']);
    // 모르는 칸은 버리지 않고 거절한다. 오타 난 조건이 조용히 빠지면 검색·알림 결과가 넓어지기 때문이다.
    assert.deepEqual(reasons(await named('오타', { level: ['ERROR'] })), ['condition:unrecognized_keys']);
    assert.deepEqual(reasons(await named('모르는 연산', { fields: [{ path: 'a', op: 'like', value: 'x' }] })), ['condition.fields.0.op:invalid_value']);

    const missing = await named('없는 대상', {
      sources: { service_ids: [999], server_ids: [null, 998], connection_ids: [encodeConnectionId(12345)] },
    });
    assert.equal(missing.status, 422);
    assert.deepEqual(reasons(missing), [
      'condition.sources.connection_ids.0:not_found',
      'condition.sources.server_ids.1:not_found',
      'condition.sources.service_ids.0:not_found',
    ]);
    assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM saved_searches')).n, 0);
  });

  it('이름이 겹치면 name_taken, 개수 상한이면 limit_reached이고 동시에 만들어도 상한을 넘지 않는다', async () => {
    assert.equal((await named('Errors')).status, 201);
    const taken = await named('errors');
    assert.equal(taken.status, 409);
    assert.equal(taken.body.code, 'name_taken');
    assert.deepEqual(taken.body.params, { path: 'name' });
    assert.equal((await named('Warnings')).status, 201);
    assert.equal((await named('Fatal')).status, 201);
    const full = await named('Debug');
    assert.equal(full.status, 409);
    assert.equal(full.body.code, 'limit_reached');
    assert.deepEqual(full.body.params, { limit: 3 });
    const list = await c.call('GET', '/api/v1/saved-searches');
    assert.equal(list.body.total, 3);
    assert.equal(list.body.limit, 3);

    await api.db.query('TRUNCATE saved_searches, idempotency_keys RESTART IDENTITY');
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((n) => named(`동시 ${n}`)));
    assert.equal(results.filter((x) => x.status === 201).length, 3);
    assert.deepEqual(
      results.filter((x) => x.status !== 201).map((x) => x.body.code),
      ['limit_reached', 'limit_reached'],
    );
    assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM saved_searches')).n, 3);
  });

  it('목록은 이름순으로 나눠 주고, 보관된 연결을 가리키면 references_archived다', async () => {
    const conn = await register('/var/app/order/app.log', { name: 'order-api' });
    await named('beta', { sources: { connection_ids: [conn] } });
    await named('Alpha', { sources: { service_ids: [1] } });
    await named('gamma');

    const first = await c.call('GET', '/api/v1/saved-searches?limit=2');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.items.map((x: any) => x.name), ['Alpha', 'beta']);
    assert.ok(first.body.next_cursor);
    const second = await c.call('GET', `/api/v1/saved-searches?limit=2&cursor=${first.body.next_cursor}`);
    assert.deepEqual(second.body.items.map((x: any) => x.name), ['gamma']);
    assert.equal(second.body.next_cursor, null);
    assert.deepEqual(reasons(await c.call('GET', '/api/v1/saved-searches?cursor=bm90LWpzb24')), ['cursor:invalid']);

    // 서비스 보관 영향은 이 서비스나 그 연결을 출처로 쓰는 저장 검색을 보인다(같은 조건 형식을 읽는지 확인).
    const impact = await c.call('GET', '/api/v1/services/1/archive-impact');
    assert.deepEqual(impact.body.saved_searches.map((x: any) => x.name).sort(), ['Alpha', 'beta']);

    const archived = await c.call('POST', `/api/v1/connections/${conn}/archive`, { headers: { 'idempotency-key': randomUUID() } });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    const items = (await c.call('GET', '/api/v1/saved-searches')).body.items;
    const beta = items.find((x: any) => x.name === 'beta');
    assert.equal(beta.references_archived, true);
    assert.equal(beta.references.connections[0].management_state, 'archived');
    assert.equal(items.find((x: any) => x.name === 'Alpha').references_archived, false);
    assert.equal(items.find((x: any) => x.name === 'gamma').references_archived, false);
  });

  it('수정은 version을 보고, 확인 뒤 force로 덮어쓰며, 바뀐 것이 없으면 version을 올리지 않는다', async () => {
    const id = (await named('first', { levels: ['ERROR'], body: [{ op: 'contains', text: 'timeout' }] })).body.id;
    await named('other');

    const renamed = await patch(id, { version: 1, name: 'second' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.version, 2);
    // 조건과 시간은 그대로 남는다.
    assert.deepEqual(renamed.body.condition.body, [{ op: 'contains', text: 'timeout', case_sensitive: false }]);

    const stale = await patch(id, { version: 1, name: 'third' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'version_conflict');
    assert.equal(stale.body.params.current.version, 2);
    assert.equal(stale.body.params.current.name, 'second');
    const forced = await patch(id, { version: 1, force: true, name: 'third' });
    assert.equal(forced.status, 200);
    assert.equal(forced.body.version, 3);

    const same = await patch(id, { version: 3, name: 'third', time: REL });
    assert.equal(same.body.version, 3);
    assert.equal(same.body.updated_at, forced.body.updated_at);

    // 조건은 통째로 바뀐다. 주지 않은 항목은 빈 목록이 된다.
    const cond = await patch(id, { version: 3, condition: { levels: ['FATAL'] } });
    assert.equal(cond.body.version, 4);
    assert.deepEqual(cond.body.condition, {
      sources: { service_ids: [], server_ids: [], environments: [], connection_ids: [] },
      levels: ['FATAL'],
      body: [],
      fields: [],
    });
    const timed = await patch(id, { version: 4, time: { mode: 'absolute', from: '2026-11-05T00:00:00-03:00', to: '2026-11-06T00:00:00Z', basis: 'occurred' } });
    assert.deepEqual(timed.body.time, { mode: 'absolute', from: '2026-11-05T03:00:00.000000Z', to: '2026-11-06T00:00:00.000000Z', basis: 'occurred' });

    assert.equal((await patch(id, { version: 5, name: 'OTHER' })).body.code, 'name_taken');
    assert.deepEqual(reasons(await patch(id, { version: 5, time: { mode: 'relative', last: 'P0D', basis: 'occurred' } })), ['time.last:duration_invalid']);
    assert.equal((await one<{ version: number }>('SELECT version FROM saved_searches WHERE id = $1', [id])).version, 5);
    assert.equal((await patch(999, { version: 1, name: 'x' })).status, 404);
    assert.equal((await patch('abc', { version: 1, name: 'x' })).status, 404);
    assert.deepEqual(reasons(await patch(id, { name: 'x' })), ['version:invalid_type']);
  });

  it('삭제는 바로 지우고 복구는 없으며 없는 대상은 404다', async () => {
    const id = (await named('지울 검색')).body.id;
    assert.equal((await c.call('GET', `/api/v1/saved-searches/${id}`)).status, 200);
    const r = await c.call('DELETE', `/api/v1/saved-searches/${id}`);
    assert.equal(r.status, 204);
    assert.equal((await c.call('DELETE', `/api/v1/saved-searches/${id}`)).status, 404);
    assert.equal((await c.call('GET', `/api/v1/saved-searches/${id}`)).status, 404);
    assert.equal((await patch(id, { version: 1, name: '되살리기' })).status, 404);
  });
});
