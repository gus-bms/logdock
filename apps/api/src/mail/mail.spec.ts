// 메일 상태·테스트 발송·운영 수신 주소 시험(계약 4.3·4.4·5.5절, UI-14, Q12-12, TD-08·19·20·21). 임시 PostgreSQL과 루프백 주소의
// 가짜 SMTP 서버로 확인한다. 합성 주소만 쓴다. 발송 속도 상한을 시험하려고 분당 3통으로 낮춰 띄운다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { hashPassword } from '../auth/password.js';
import { FakeSmtp } from '../test-support/fake-smtp.js';
import { type Api, Client, type EphemeralPostgres, type Reply, startApi, startPostgres } from '../test-support/harness.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';
const FROM = 'logdock@example.test';

describe('메일', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let fake: FakeSmtp;
  let c: Client;
  const one = async <T = any>(sql: string, values: unknown[] = []): Promise<T> => (await api.db.query(sql, values)).rows[0] as T;
  const reasons = (r: Reply) => (r.body.params.fields as { path: string; reason: string }[]).map((f) => `${f.path}:${f.reason}`).sort();
  const post = (path: string, body: object, key = randomUUID(), client = c) => client.call('POST', path, { headers: { 'idempotency-key': key }, body });
  const audits = async () =>
    (await api.db.query<{ action: string; changed_fields: string[] }>('SELECT action, changed_fields FROM audit_log ORDER BY id')).rows;

  before(async () => {
    pg = await startPostgres();
    fake = await new FakeSmtp().start();
    api = await startApi(pg, {
      mail: { host: '127.0.0.1', port: fake.port, security: 'plain_relay', from: FROM, user: null, password: null, ca: null, redirectTo: null },
      mailRatePerMinute: 3,
      mailTimeoutSeconds: 1,
    });
    await api.db.query('INSERT INTO accounts (name, password_hash) VALUES ($1, $2)', [NAME, await hashPassword(PASSWORD)]);
    c = new Client(api.base);
    assert.equal((await c.login(NAME, PASSWORD)).status, 200);
  });

  after(async () => {
    await api?.close();
    await fake?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    await api.db.query(
      `TRUNCATE mail_jobs, mail_status, ops_recipients, ops_recipient_list, ops_mail_batches, idempotency_keys, audit_log, audit_gaps
       RESTART IDENTITY CASCADE`,
    );
    fake.script = {};
    fake.received = [];
  });

  it('메일 상태는 비밀이 아닌 서버 값과 마지막 발송 시도로 정한 연결 상태를 준다', async () => {
    const before = await c.call('GET', '/api/v1/mail');
    assert.equal(before.status, 200);
    assert.deepEqual(before.body, {
      configured: true,
      server: { host: '127.0.0.1', port: fake.port, security: 'plain_relay', from: FROM },
      plain_relay: true,
      redirect_to: null,
      connection: 'unknown',
      last_attempt_at: null,
      last_success_at: null,
      last_error: null,
    });
    assert.equal(JSON.stringify(before.body).includes('password'), false);

    // 주소 문제로 실패해도 연결은 된 것이다.
    fake.script.rcpt = '550 5.1.1 no such user';
    await post('/api/v1/mail/test', { address: 'nobody@example.test' });
    assert.equal((await c.call('GET', '/api/v1/mail')).body.connection, 'connected');
    fake.script = { greeting: '421 4.3.2 service not available' };
    await post('/api/v1/mail/test', { address: 'ops@example.test' });
    const down = (await c.call('GET', '/api/v1/mail')).body;
    assert.equal(down.connection, 'error');
    assert.equal(down.last_error, 'mail_temporary_failure');
    assert.equal(down.last_success_at, null);
  });

  it('테스트 발송은 결과와 사유를 바로 주고, 같은 Idempotency-Key로 다시 보내도 한 통만 간다', async () => {
    const key = randomUUID();
    const r = await post('/api/v1/mail/test', { address: ' ops@example.test ' }, key);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { address: 'ops@example.test', result: 'accepted', reason: null, problem: null });
    assert.equal(fake.received.length, 1);
    assert.equal(fake.received[0].to, 'ops@example.test');
    const again = await post('/api/v1/mail/test', { address: ' ops@example.test ' }, key);
    assert.deepEqual(again.body, r.body);
    assert.equal(fake.received.length, 1);
    assert.equal((await post('/api/v1/mail/test', { address: 'dev@example.test' }, key)).body.code, 'idempotency_key_reused');
    assert.deepEqual(await one('SELECT kind, state, attempts FROM mail_jobs'), { kind: 'test', state: 'accepted', attempts: 1 });
    const status = (await c.call('GET', '/api/v1/mail')).body;
    assert.equal(status.connection, 'connected');
    assert.ok(status.last_success_at);

    fake.script.rcpt = '550 5.1.1 no such user';
    const rejected = await post('/api/v1/mail/test', { address: 'nobody@example.test' });
    assert.deepEqual(rejected.body, { address: 'nobody@example.test', result: 'failed', reason: 'mail_recipient_rejected', problem: 'address' });
    assert.deepEqual(reasons(await post('/api/v1/mail/test', { address: 'not-an-address' })), ['address:format_invalid']);
    assert.deepEqual(reasons(await c.call('POST', '/api/v1/mail/test', { body: { address: 'ops@example.test' } })), ['Idempotency-Key:required']);
  });

  it('설치 전체 발송 속도 상한을 넘으면 보내지 않고 429 rate_limited다', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await post('/api/v1/mail/test', { address: `u${i}@example.test` })).status, 200);
    const limited = await post('/api/v1/mail/test', { address: 'u3@example.test' });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'rate_limited');
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal(fake.received.length, 3);
    // 규칙의 테스트 메일도 같은 상한을 쓰고, 여러 주소가 상한을 넘으면 한 통도 보내지 않는다.
    await api.db.query('TRUNCATE mail_jobs RESTART IDENTITY CASCADE');
    assert.equal((await post('/api/v1/alert-rules/test-mail', { addresses: ['a@example.test', 'b@example.test', 'c@example.test', 'd@example.test'] })).status, 429);
    assert.equal(fake.received.length, 3);
  });

  it('규칙의 테스트 메일은 저장 전 주소마다 따로 보내고 본문에 규칙 이름을 넣는다', async () => {
    fake.script.rcpt = undefined;
    const r = await post('/api/v1/alert-rules/test-mail', { addresses: ['ops@example.test', 'dev@example.test'], rule_name: '결제 오류\r\n급증' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.results.map((x: any) => [x.address, x.result]), [['ops@example.test', 'accepted'], ['dev@example.test', 'accepted']]);
    assert.deepEqual(fake.received.map((m) => m.to), ['ops@example.test', 'dev@example.test']);
    const body = Buffer.from(fake.received[0].data.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
    assert.match(body, /알림 규칙 "결제 오류 급증"의 수신 주소/);
    assert.deepEqual(reasons(await post('/api/v1/alert-rules/test-mail', { addresses: ['a@example.test', 'A@example.test'] })), ['addresses.1:duplicate']);
    assert.deepEqual(reasons(await post('/api/v1/alert-rules/test-mail', { addresses: [] })), ['addresses:too_small']);
  });

  it('수신처 고정이 있으면 테스트 메일도 요청한 주소 대신 그 주소로만 보내고 결과에 알린다', async () => {
    const fixed = await startApi(pg, {
      mail: { host: '127.0.0.1', port: fake.port, security: 'plain_relay', from: FROM, user: null, password: null, ca: null, redirectTo: 'me@example.test' },
    });
    try {
      const c2 = new Client(fixed.base);
      assert.equal((await c2.login(NAME, PASSWORD)).status, 200);
      assert.equal((await c2.call('GET', '/api/v1/mail')).body.redirect_to, 'me@example.test');
      const r = await post('/api/v1/mail/test', { address: 'someone@example.test' }, randomUUID(), c2);
      assert.deepEqual(r.body, { address: 'someone@example.test', delivered_to: 'me@example.test', result: 'accepted', reason: null, problem: null });
      assert.deepEqual(fake.received.map((m) => m.to), ['me@example.test']);
      const body = Buffer.from(fake.received[0].data.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
      assert.match(body, /요청한 주소\(someone@example\.test\) 대신 이 주소로 보냈습니다/);
    } finally {
      await fixed.close();
    }
  });

  it('메일 설정이 없으면 상태에 설정 없음을 주고 테스트 발송은 409 mail_not_configured다', async () => {
    const noMail = await startApi(pg, { mail: null });
    try {
      const c2 = new Client(noMail.base);
      assert.equal((await c2.login(NAME, PASSWORD)).status, 200);
      const s = (await c2.call('GET', '/api/v1/mail')).body;
      assert.equal(s.configured, false);
      assert.equal(s.server, null);
      assert.equal((await post('/api/v1/mail/test', { address: 'ops@example.test' }, randomUUID(), c2)).body.code, 'mail_not_configured');
    } finally {
      await noMail.close();
    }
  });

  it('운영 수신 주소는 목록 전체를 version으로 바꾸고, 받았음 표시를 지키며 뺀 주소의 보내지 않은 운영 메일을 취소한다', async () => {
    assert.deepEqual((await c.call('GET', '/api/v1/mail/ops-recipients')).body, { recipients: [], version: 1, limit: 10 });
    const set = await c.call('PUT', '/api/v1/mail/ops-recipients', { body: { version: 1, addresses: ['ops@example.test', 'dev@example.test'] } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.version, 2);
    const confirmed = await c.call('POST', '/api/v1/mail/ops-recipients/confirm', { body: { address: 'OPS@example.test' } });
    assert.ok(confirmed.body.recipients[0].confirmed_at);
    assert.equal(confirmed.body.version, 2);
    assert.equal((await c.call('POST', '/api/v1/mail/ops-recipients/confirm', { body: { address: 'nobody@example.test' } })).status, 404);

    const batch = await one<{ id: string }>('INSERT INTO ops_mail_batches DEFAULT VALUES RETURNING id');
    await api.db.query(`INSERT INTO mail_jobs (kind, ops_batch_id, recipient, message_id, state) VALUES ('ops', $1, 'dev@example.test', $2, 'queued')`, [
      batch.id,
      `<${randomUUID()}@example.test>`,
    ]);
    const stale = await c.call('PUT', '/api/v1/mail/ops-recipients', { body: { version: 1, addresses: [] } });
    assert.equal(stale.body.code, 'version_conflict');
    assert.equal(stale.body.params.current.version, 2);
    const kept = await c.call('PUT', '/api/v1/mail/ops-recipients', { body: { version: 2, addresses: ['ops@example.test'] } });
    assert.deepEqual(kept.body.recipients.map((r: any) => [r.address, Boolean(r.confirmed_at)]), [['ops@example.test', true]]);
    assert.deepEqual(await one('SELECT state, cancel_reason FROM mail_jobs'), { state: 'cancelled', cancel_reason: 'recipient_removed' });
    const empty = await c.call('PUT', '/api/v1/mail/ops-recipients', { body: { version: 3, addresses: [] } });
    assert.deepEqual(empty.body.recipients, []);
    assert.deepEqual(reasons(await c.call('PUT', '/api/v1/mail/ops-recipients', { body: { version: 4, addresses: ['bad'] } })), ['addresses.0:format_invalid']);
    assert.deepEqual(
      (await audits()).map((a) => [a.action, a.changed_fields]),
      [
        ['ops_recipients.update', ['recipients']],
        ['ops_recipients.update', ['recipient_confirmed']],
        ['ops_recipients.update', ['recipients']],
        ['ops_recipients.update', ['recipients']],
      ],
    );
  });

  it('감사를 쓸 수 없으면 운영 수신 주소를 바꾸지 않고 보류한다', async () => {
    await api.db.query(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit storage unavailable'; END $$`);
    await api.db.query('CREATE TRIGGER fail_audit BEFORE INSERT OR UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()');
    try {
      const r = await c.call('PUT', '/api/v1/mail/ops-recipients', { body: { version: 1, addresses: ['ops@example.test'] } });
      assert.equal(r.body.code, 'held_audit_unavailable');
    } finally {
      await api.db.query('DROP TRIGGER fail_audit ON audit_log');
      await api.db.query('DROP FUNCTION fail_audit()');
    }
    assert.deepEqual((await c.call('GET', '/api/v1/mail/ops-recipients')).body, { recipients: [], version: 1, limit: 10 });
  });
});
