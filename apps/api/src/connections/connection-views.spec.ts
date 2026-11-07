// 수집 연결 목록·상세·조치 필요 수 시험(계약 2.7·4.3·4.4절, UI-10·UI-12). 연결과 상태 보고는 시험이 DB에 직접 넣어
// 수신 서버가 기록한 것처럼 흉내 낸다. 합성 이름·경로만 쓴다.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { hashPassword } from '../auth/password.js';
import { type Api, Client, type EphemeralPostgres, startApi, startPostgres } from '../test-support/harness.js';
import { encodeConnectionId } from './public-id.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';

describe('수집 연결 목록·상세', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let c: Client;
  const get = (path: string) => c.call('GET', path);
  const ids = (items: { id: string }[]) => items.map((i) => i.id);
  const cid = (n: number) => encodeConnectionId(n);

  before(async () => {
    pg = await startPostgres();
    api = await startApi(pg);
    await api.db.query('INSERT INTO accounts (name, password_hash) VALUES ($1, $2)', [NAME, await hashPassword(PASSWORD)]);
    c = new Client(api.base);
    assert.equal((await c.login(NAME, PASSWORD)).status, 200);
    await api.db.query(`INSERT INTO services (name) VALUES ('billing'), ('order-api')`);
    await api.db.query(`INSERT INTO servers (display_name) VALUES ('app-01')`);
    const conn = (service: number, target: string, state: string, extra = '') =>
      api.db.query(
        `INSERT INTO connections (service_id, server_id, target_type, target_path, journald_kind, journald_name, format_type,
                                  max_event_bytes, management_state, archived_at${extra ? ', updated_at' : ''})
         VALUES ($1, 1, $2, $3, $4, $5, 'text', 1024, $6, ${state === 'archived' ? 'now()' : 'NULL'}${extra ? `, ${extra}` : ''})`,
        target.startsWith('unit:')
          ? [service, 'journald', null, 'unit', target.slice(5), state]
          : [service, 'file', target, null, null, state],
      );
    await conn(2, '/var/app/order/app.log', 'pending'); // 1: 첫 보고 전
    await conn(2, '/var/app/order/error.log', 'pending', `now() - interval '2 days'`); // 2: 대기가 오래됨
    await conn(1, 'unit:billing.service', 'active'); // 3: 수집 중
    await conn(1, '/var/app/billing/app.log', 'active'); // 4: 보고가 끊김
    await conn(1, '/var/app/billing/sync.log', 'blocked'); // 5: 전송 차단
    await conn(2, '/var/app/order/old.log', 'archived'); // 6: 보관
    await conn(1, '/var/app/billing/auth.log', 'active'); // 7: 키 폐기로 전송 보류
    await conn(1, '/var/app/billing/net.log', 'active'); // 8: 네트워크 재시도
    for (const n of [3, 4, 7, 8]) {
      await api.db.query(`INSERT INTO ingest_keys (key_id, connection_id, secret_hash, slot, issued_as) VALUES ($1, $2, '\\x00', 1, 'register')`, [
        `k${n}`,
        n,
      ]);
    }
    const status = (n: number, age: string, states: string[], report: object) =>
      api.db.query(
        `INSERT INTO connection_status (connection_id, last_report_at, report, agent_instance_id, agent_version, key_id, observed_states)
         VALUES ($1, now() - $2::interval, $3, 'a_test', '0.1.0', $4, $5)`,
        [n, age, report, `k${n}`, states],
      );
    await status(3, '5 seconds', ['collecting'], {
      agent: { instance_id: 'a_test', version: '0.1.0', timezone: 'Asia/Seoul' },
      config: { version: 1, applied_at: '2026-11-07T00:00:00.000000Z' },
      read: { state: 'running', last_read_at: '2026-11-07T00:00:05.000000Z', bytes: 1024 },
      queue: { records: 120, bytes: 4096, oldest_observed_at: '2026-11-07T00:00:01.000000Z' },
      send: { state: 'ok', acked_through: 980, last_ack_at: '2026-11-07T00:00:04.000000Z' },
    });
    await status(4, '10 minutes', ['collecting'], { read: { state: 'running' } });
    await status(7, '5 seconds', ['send_error'], { send: { state: 'held', reason: 'key_revoked' } });
    await status(8, '5 seconds', ['send_error'], { send: { state: 'retrying', reason: 'timeout' } });
    await api.db.query(`INSERT INTO ingest_progress (connection_id, generation, next_seq) VALUES (3, 1, 981)`);
    await api.db.query(`INSERT INTO status_history (connection_id, reported_at, changes) VALUES (3, now(), '{"read": "running"}')`);
  });

  after(async () => {
    await api?.close();
    await pg?.stop();
  });

  it('보관되지 않은 연결을 서비스 이름순·연결 순으로 주고 관측 상태와 조치 필요를 함께 계산한다', async () => {
    const r = await get('/api/v1/connections');
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r.body.items), [3, 4, 5, 7, 8, 1, 2].map(cid));
    const by = Object.fromEntries(r.body.items.map((i: any) => [i.id, i]));
    assert.deepEqual(
      [3, 4, 5, 7, 8, 1, 2].map((n) => [n, by[cid(n)].observation.states, by[cid(n)].needs_action]),
      [
        [3, ['collecting'], false],
        [4, ['stale'], true],
        [5, ['awaiting_connection'], true],
        [7, ['send_error'], true],
        [8, ['send_error'], false],
        [1, ['awaiting_connection'], false],
        [2, ['awaiting_connection'], true],
      ],
    );
    assert.deepEqual(by[cid(3)].queue, { records: 120, bytes: 4096, oldest_observed_at: '2026-11-07T00:00:01.000000Z' });
    assert.equal(by[cid(1)].queue, null);
    assert.match(by[cid(3)].observation.last_report_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    assert.deepEqual(by[cid(3)].target, { type: 'journald', path: null, kind: 'unit', name: 'billing.service' });
    assert.deepEqual(by[cid(3)].service, { id: 1, name: 'billing', state: 'active' });
    assert.equal(by[cid(3)].valid_keys, 1);
  });

  it('보관된 연결·조치 필요·관측 상태·서비스로 거른다', async () => {
    const archived = await get('/api/v1/connections?archived=true');
    assert.deepEqual(ids(archived.body.items), [cid(6)]);
    assert.deepEqual(archived.body.items[0].observation.states, ['stopped']);
    assert.equal(archived.body.items[0].needs_action, false);
    assert.deepEqual(ids((await get('/api/v1/connections?needs_action=true')).body.items), [4, 5, 7, 2].map(cid));
    assert.deepEqual(ids((await get('/api/v1/connections?observation=stale')).body.items), [cid(4)]);
    assert.deepEqual(ids((await get('/api/v1/connections?service_id=2')).body.items), [1, 2].map(cid));
  });

  it('limit과 불투명한 cursor로 나눠 받는다', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: any = await get(`/api/v1/connections?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(r.status, 200);
      seen.push(...ids(r.body.items));
      cursor = r.body.next_cursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, [3, 4, 5, 7, 8, 1, 2].map(cid));
  });

  it('잘못된 거르기 값과 cursor는 422다', async () => {
    assert.deepEqual((await get('/api/v1/connections?cursor=bad')).body.params.fields, [{ path: 'cursor', reason: 'invalid' }]);
    assert.equal((await get('/api/v1/connections?observation=fine')).status, 422);
    assert.equal((await get('/api/v1/connections?limit=0')).status, 422);
  });

  it('조치 필요 수는 보관된 연결과 정상 진행을 빼고 센다', async () => {
    const r = await get('/api/v1/connections/summary');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { needs_action: 4 });
  });

  it('상세는 상태 보고에서 온 값, 중앙 ACK, 등록 단계, 키, 진단 이력을 주고 로그 저장소 값은 아직 null이다', async () => {
    const r = await get(`/api/v1/connections/${cid(3)}`);
    assert.equal(r.status, 200);
    const d = r.body;
    assert.equal(d.id, cid(3));
    assert.deepEqual(d.format, { type: 'text', event_start: null, log_timezone: null, max_event_bytes: 1024 });
    assert.equal(d.applied_config_version, 1);
    assert.deepEqual(d.report.send, { state: 'ok', acked_through: 980, last_ack_at: '2026-11-07T00:00:04.000000Z' });
    assert.deepEqual(d.report.loss, []);
    assert.equal(d.central_ack.generation, 1);
    assert.equal(d.central_ack.acked_through, 980);
    assert.match(d.registration.registered_at, /Z$/);
    assert.equal(d.registration.agent_applied_at, null);
    assert.deepEqual(
      d.keys.map((k: any) => [k.key_id, k.state, k.slot, k.issued_as]),
      [['k3', 'valid', 1, 'register']],
    );
    assert.deepEqual(d.diagnostics.map((h: any) => h.changes), [{ read: 'running' }]);
    assert.deepEqual([d.rejected_recent, d.parse_failed_recent], [null, null]);
    const none = await get(`/api/v1/connections/${cid(1)}`);
    assert.equal(none.body.report, null);
    assert.equal(none.body.central_ack, null);
    assert.equal((await get(`/api/v1/connections/${cid(99)}`)).status, 404);
    assert.equal((await get('/api/v1/connections/c_bad!')).status, 404);
  });
});
