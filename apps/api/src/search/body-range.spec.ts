// 본문 검색 기간 제한 시험(Q15-05, 2026-11-07 합의). 본문 검색어가 있으면 한 번에 고를 수 있는 기간은 7일 이하이고, 본문
// 검색어 없는 조건은 보관 기간 전체를 쓸 수 있다. 검색 실행과 저장 검색이 같은 제한을 따른다. ClickHouse는 쓰지 않는다:
// 허용된 검색은 닫힌 포트로 가 `503 storage_unavailable`이 되므로 제한에 걸리지 않았다는 것만 본다. 합성 값만 쓴다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { hashPassword } from '../auth/password.js';
import { DEFAULTS } from '../config.js';
import { type Api, Client, type EphemeralPostgres, type Reply, startApi, startPostgres } from '../test-support/harness.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';
const BODY = { body: [{ op: 'contains', text: 'timeout' }] };
const rel = (last: string) => ({ mode: 'relative', last, basis: 'occurred' });
const abs = (from: string, to: string) => ({ mode: 'absolute', from, to, basis: 'occurred' });

describe('본문 검색 기간 제한(Q15-05)', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let c: Client;
  const search = (condition: object, time: object): Promise<Reply> =>
    c.call('POST', '/api/v1/search', { body: { run_id: randomUUID(), condition, time } });
  const rejected = (r: Reply) => {
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.deepEqual(r.body.params.fields, [{ path: 'time', reason: 'body_range_too_long' }]);
  };
  const allowed = (r: Reply) => assert.equal(r.body.code, 'storage_unavailable', JSON.stringify(r.body));

  before(async () => {
    pg = await startPostgres();
    // 닫힌 포트(discard). 허용된 검색은 저장소 접속에서 실패한다.
    api = await startApi(pg, { clickhouse: { ...DEFAULTS.clickhouse, url: 'http://127.0.0.1:9' } });
    await api.db.query('INSERT INTO accounts (name, password_hash) VALUES ($1, $2)', [NAME, await hashPassword(PASSWORD)]);
    c = new Client(api.base);
    assert.equal((await c.login(NAME, PASSWORD)).status, 200);
  });

  after(async () => {
    await api?.close();
    await pg?.stop();
  });

  it('본문 검색어가 있으면 7일을 넘는 범위를 실행하지 않는다. 본문 제외도 같다', async () => {
    const r = await search(BODY, rel('P8D'));
    rejected(r);
    assert.equal(r.body.code, 'condition_invalid');
    rejected(await search({ body: [{ op: 'not_contains', text: 'health' }] }, rel('PT169H')));
    allowed(await search(BODY, rel('P7D')));
    allowed(await search(BODY, rel('PT168H')));
  });

  it('고정 범위도 길이로 보고, 본문 검색어가 없으면 보관 기간 전체를 쓸 수 있다', async () => {
    allowed(await search(BODY, abs('2026-11-01T00:00:00+09:00', '2026-11-08T00:00:00+09:00')));
    rejected(await search(BODY, abs('2026-11-01T00:00:00+09:00', '2026-11-08T00:00:00.000001+09:00')));
    allowed(await search({ fields: [{ path: 'http.status', op: 'gte', value: 500 }] }, rel('P180D')));
    allowed(await search({}, rel('P180D')));
  });

  it('저장 검색도 같은 제한을 따르고, 제한 전에 저장한 조건의 이름만 바꾸는 것은 막지 않는다', async () => {
    const create = (body: object) => c.call('POST', '/api/v1/saved-searches', { headers: { 'idempotency-key': randomUUID() }, body });
    const bad = await create({ name: '긴 본문 검색', condition: BODY, time: rel('P30D') });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, 'validation_failed');
    assert.deepEqual(bad.body.params.fields, [{ path: 'time', reason: 'body_range_too_long' }]);
    const ok = await create({ name: '짧은 본문 검색', condition: BODY, time: rel('P7D') });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const widen = await c.call('PATCH', `/api/v1/saved-searches/${ok.body.id}`, { body: { version: ok.body.version, time: rel('P30D') } });
    assert.deepEqual(widen.body.params.fields, [{ path: 'time', reason: 'body_range_too_long' }]);

    const old = (
      await api.db.query<{ id: number }>(
        `INSERT INTO saved_searches (owner_account_id, name, condition, time_mode, time_range, time_basis)
         VALUES (1, '예전 검색', $1, 'relative', '{"last": "P30D"}', 'occurred') RETURNING id`,
        [{ sources: { service_ids: [], server_ids: [], environments: [], connection_ids: [] }, levels: [], body: BODY.body.map((b) => ({ ...b, case_sensitive: false })), fields: [] }],
      )
    ).rows[0].id;
    const renamed = await c.call('PATCH', `/api/v1/saved-searches/${old}`, { body: { version: 1, name: '예전 검색(이름만)' } });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  });

  it('화면용 설정값에 본문 검색 기간을 준다', async () => {
    assert.deepEqual((await c.call('GET', '/api/v1/settings')).body.search, { body_max_range_days: 7 });
  });
});
