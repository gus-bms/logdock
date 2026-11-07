// 구간 로그 삭제 요청과 저장 공간 조회 시험(계약 3.3절, 4.3절, 5.6절). 임시 PostgreSQL과 앱을 띄워 HTTP로 확인한다. 실제
// ClickHouse 삭제는 수신 서버가 하므로 여기서는 차단 구간 기록·재확인·중복 요청·감사만 본다. 합성 이름만 쓴다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { hashPassword } from '../auth/password.js';
import { type Api, Client, type EphemeralPostgres, type Reply, startApi, startPostgres } from '../test-support/harness.js';
import { encodeConnectionId } from './public-id.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';
const RANGE = { from: '2026-11-05T10:00:00+09:00', to: '2026-11-05T10:30:00+09:00' };

describe('구간 로그 삭제와 저장 공간', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let c: Client;
  const del = (body: object, key = randomUUID(), client = c, id = encodeConnectionId(1)): Promise<Reply> =>
    client.call('POST', `/api/v1/connections/${id}/deletions`, { headers: { 'idempotency-key': key }, body });

  before(async () => {
    pg = await startPostgres();
    api = await startApi(pg);
    await api.db.query('INSERT INTO accounts (name, password_hash) VALUES ($1, $2)', [NAME, await hashPassword(PASSWORD)]);
    await api.db.query(`INSERT INTO services (name) VALUES ('billing')`);
    await api.db.query(
      `INSERT INTO connections (service_id, target_type, target_path, format_type, max_event_bytes) VALUES (1, 'file', '/var/app/billing/app.log', 'json', 1024)`,
    );
    c = new Client(api.base);
    assert.equal((await c.login(NAME, PASSWORD)).status, 200);
    assert.equal((await c.call('POST', '/api/v1/auth/reauth', { body: { password: PASSWORD } })).status, 200);
  });

  after(async () => {
    await api?.close();
    await pg?.stop();
  });

  it('차단 구간을 요청으로 남기고 감사에 단계를 남긴다. 같은 키는 처음 결과를 준다', async () => {
    const key = randomUUID();
    const r = await del(RANGE, key);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.state, 'requested');
    assert.deepEqual(r.body.range, { from: '2026-11-05T01:00:00.000000Z', to: '2026-11-05T01:30:00.000000Z', basis: 'occurred' });
    assert.equal(r.body.connection_id, encodeConnectionId(1));
    const again = await del(RANGE, key);
    assert.equal(again.status, 201);
    assert.equal(again.body.id, r.body.id);
    assert.equal((await del({ ...RANGE, to: '2026-11-05T11:00:00+09:00' }, key)).body.code, 'idempotency_key_reused');
    const rows = (await api.db.query('SELECT state FROM deletion_blocks')).rows;
    assert.deepEqual(rows, [{ state: 'requested' }]);
    const audit = (await api.db.query<{ action: string; stage: string | null; target_ref: string }>(`SELECT action, stage, target_ref FROM audit_log WHERE action = 'connection.delete_range'`)).rows;
    assert.deepEqual(audit, [{ action: 'connection.delete_range', stage: 'requested', target_ref: encodeConnectionId(1) }]);
  });

  it('재확인이 없거나 범위·대상이 틀리면 거절한다', async () => {
    const fresh = new Client(api.base);
    assert.equal((await fresh.login(NAME, PASSWORD)).status, 200);
    assert.equal((await del(RANGE, randomUUID(), fresh)).body.code, 'reauth_required');
    assert.equal((await del({ from: RANGE.to, to: RANGE.from })).status, 422);
    assert.equal((await del({ from: 'yesterday', to: RANGE.to })).status, 422);
    assert.equal((await del(RANGE, randomUUID(), c, encodeConnectionId(99))).status, 404);
  });

  it('저장 공간은 마지막 측정과 조기 삭제·경고를 준다', async () => {
    const empty = await c.call('GET', '/api/v1/storage');
    assert.equal(empty.status, 200);
    assert.equal(empty.body.retention_months, 6);
    assert.equal(empty.body.measured_at, null);
    assert.match(empty.body.available_from, /Z$/);
    await api.db.query(
      `INSERT INTO storage_metrics (measured_at, log_bytes, log_limit_bytes, disk_free_bytes, estimated) VALUES
         (now() - interval '1 hour', 1, 2, 3, true), (now(), 1000, 5000, 9000, false)`,
    );
    await api.db.query(`INSERT INTO early_deletions (received_from, received_to, bytes) VALUES (now() - interval '170 days', now() - interval '169 days', 42)`);
    await api.db.query(`INSERT INTO notices (kind, raised_at) VALUES ('disk_warning', now())`);
    const s = await c.call('GET', '/api/v1/storage');
    assert.equal(s.body.log_bytes, 1000);
    assert.equal(s.body.log_limit_bytes, 5000);
    assert.equal(s.body.disk_free_bytes, 9000);
    assert.equal(s.body.estimated, false);
    assert.equal(s.body.early_deletions.length, 1);
    assert.equal(s.body.early_deletions[0].bytes, 42);
    assert.deepEqual(s.body.warnings, ['disk_warning']);
    // 조기 삭제가 있으면 조회 가능 시작은 지운 구간의 끝이다.
    assert.ok(Date.parse(s.body.available_from) > Date.now() - 170 * 86_400_000);
  });
});
