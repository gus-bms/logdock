// worker의 알림·운영 메일 발송 시험(계약 5.5절, Q12-06·09·10·11, F-08, TD-09·19). 임시 PostgreSQL과 루프백 가짜 SMTP 서버로
// 확인한다. 평가 작업이 만들 사건·메일 작업은 DB에 직접 넣어 흉내 낸다. 합성 이름·주소만 쓴다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type AppConfig, DEFAULTS } from '../config.js';
import { Database } from '../db/database.js';
import { FakeSmtp } from '../test-support/fake-smtp.js';
import { type EphemeralPostgres, startPostgres } from '../test-support/harness.js';
import { MailSender } from './mail-sender.js';
import { OpsEpisodes } from './ops-episodes.js';

const FROM = 'logdock@example.test';

/** 받은 메일의 머리 하나와 본문을 읽는다(encoded-word·base64를 푼다). */
function read(data: string) {
  const [head, body] = data.split('\r\n\r\n');
  const header = (name: string) => {
    const m = new RegExp(`^${name}: (.*(?:\\r\\n .*)*)`, 'm').exec(head);
    return (m ? m[1] : '').replace(/\r\n /g, '').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
  };
  return { header, text: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8').replace(/\r\n/g, '\n') };
}

describe('worker: 알림·운영 메일 발송', () => {
  let pg: EphemeralPostgres;
  let fake: FakeSmtp;
  let db: Database;
  let config: AppConfig;
  const one = async <T = any>(sql: string, values: unknown[] = []): Promise<T> => (await db.query(sql, values)).rows[0] as T;
  const sender = (over: Partial<AppConfig> = {}, mail: Partial<NonNullable<AppConfig['mail']>> = {}) =>
    new MailSender(db, { ...config, ...over, mail: { ...config.mail!, ...mail } }, () => 0.5);
  /** 평가 작업이 연 사건(발화 때 고정한 값)을 흉내 낸다. */
  const incident = async (ref: string, firedAgo = '30 seconds', closed: string | null = null) =>
    (
      await one<{ id: string }>(
        `INSERT INTO alert_incidents (public_ref, rule_id, condition_version, rule_name, condition, window_minutes, threshold,
                                      window_start, window_end, fired_at, matched_count, unknown_count, oldest_occurred_at, quality,
                                      closed_at, close_reason)
         VALUES ($1, 1, 1, '결제 오류 급증',
                 '{"sources": {"service_ids": [1], "server_ids": [1], "environments": [], "connection_ids": []},
                   "levels": ["ERROR", "UNKNOWN"], "body": [{"op": "contains", "text": "timeout", "case_sensitive": false}], "fields": []}',
                 5, 10, '2026-11-02T01:00:00Z', '2026-11-02T01:05:00Z', now() - $2::interval, 12, 3, '2026-11-02T00:12:04Z',
                 'partially_unobserved', CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, $3)
         RETURNING id::text`,
        [ref, firedAgo, closed],
      )
    ).id;
  const job = async (incidentId: string, recipient = 'ops@example.test', extra: { state?: string; kind?: string; attempts?: number; createdAgo?: string } = {}) =>
    (
      await one<{ id: string; message_id: string }>(
        `INSERT INTO mail_jobs (kind, incident_id, recipient, message_id, state, attempts, next_attempt_at, created_at, cancel_reason)
         VALUES ($1, CASE WHEN $1 = 'alert' THEN $2::bigint END, $3, $4, $5, $6, now(), now() - $7::interval,
                 CASE WHEN $5 = 'cancelled' THEN 'rule_disabled' END)
         RETURNING id::text, message_id`,
        [extra.kind ?? 'alert', incidentId, recipient, `<${randomUUID()}@example.test>`, extra.state ?? 'queued', extra.attempts ?? 0, extra.createdAgo ?? '0 seconds'],
      )
    );
  const state = (id: string) =>
    one<{ state: string; last_error: string | null; attempts: number; wait: number | null }>(
      `SELECT state, last_error, attempts, extract(epoch FROM next_attempt_at - now())::float8 AS wait FROM mail_jobs WHERE id = $1`,
      [id],
    );

  before(async () => {
    pg = await startPostgres();
    fake = await new FakeSmtp().start();
    config = {
      ...DEFAULTS,
      db: { host: pg.host, port: pg.port, user: pg.user, database: pg.database, max: 4 },
      mail: { host: '127.0.0.1', port: fake.port, security: 'plain_relay', from: FROM, user: null, password: null, ca: null, redirectTo: null },
      publicBaseUrl: 'https://logdock.example.test',
      displayTimezone: 'Asia/Seoul',
      mailRatePerMinute: 100,
      mailTimeoutSeconds: 1,
    };
    db = new Database(config);
  });

  after(async () => {
    await db?.onModuleDestroy();
    await fake?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE accounts, services, servers, connections, connection_status, ingest_keys, alert_rules, alert_incidents, mail_jobs,
                mail_status, ops_episodes, ops_mail_batches, ops_recipients RESTART IDENTITY CASCADE`,
    );
    await db.query(`INSERT INTO accounts (name, password_hash) VALUES ('admin', 'x')`);
    await db.query(`INSERT INTO services (name) VALUES ('billing')`);
    await db.query(`INSERT INTO servers (display_name) VALUES ('app-01')`);
    await db.query(
      `INSERT INTO alert_rules (owner_account_id, name, enabled, condition, window_minutes, threshold) VALUES (1, '결제 오류 급증', true, '{}', 5, 10)`,
    );
    fake.script = {};
    fake.received = [];
  });

  it('보낼 시각이 된 알림 메일을 보내고 발화 때 고정한 값으로 Q12 형식을 쓴다', async () => {
    const j = await job(await incident('inc-1'));
    assert.equal(await sender().sendDue(), 1);
    assert.equal(fake.received.length, 1);
    const m = read(fake.received[0].data);
    assert.equal(fake.received[0].to, 'ops@example.test');
    assert.equal(m.header('Subject'), '[LogDock] 결제 오류 급증 — 12건 / 5분 (기준 10건)');
    assert.equal(m.header('Message-ID'), j.message_id);
    assert.equal(m.header('Auto-Submitted'), 'auto-generated');
    assert.deepEqual(m.text.split('\n'), [
      '규칙: 결제 오류 급증',
      '대상: billing / app-01 / ERROR, 미확인 / 본문·필드 조건 있음',
      '건수: 12건 (기준 10건 이상)',
      '집계 구간: 2026-11-02 10:00:00 이상 ~ 2026-11-02 10:05:00 미만 (+09:00, 중앙 수신 시각)',
      '가장 오래된 발생 시각: 2026-11-02 09:12:04 (+09:00)',
      '판정 불가: 3건',
      '감시 상태: 일부 미관측',
      '',
      '조사 열기: https://logdock.example.test/alerts/incidents/inc-1',
      '로그인이 필요합니다.',
      '현재 결과는 보존·삭제로 위 건수와 다를 수 있습니다.',
      '',
      '이 메일은 조건이 해소될 때까지 다시 오지 않으며 회복 메일은 없습니다.',
    ]);
    assert.equal(m.text.includes('timeout'), false);
    assert.deepEqual(await state(j.id), { state: 'accepted', last_error: null, attempts: 1, wait: null });
    assert.ok((await one('SELECT last_success_at FROM mail_status')).last_success_at);
    assert.equal(await sender().sendDue(), 0);
  });

  it('늦게 나가면 제목 앞에 지연을 붙이고, 사건이 닫힌 뒤면 해소 사실을 적는다', async () => {
    await job(await incident('inc-late', '45 minutes', 'resolved'));
    await sender().sendDue();
    const m = read(fake.received[0].data);
    assert.equal(m.header('Subject'), '[지연 45분] [LogDock] 결제 오류 급증 — 12건 / 5분 (기준 10건)');
    assert.ok(m.text.includes('발송 시점에 이미 해소됨'));
  });

  it('실패는 결과표대로 다시 보내거나 최종 실패로 두고, 본문 뒤 무응답은 같은 Message-ID로 다시 보낸다', async () => {
    const inc = await incident('inc-1');
    const temp = await job(inc);
    fake.script.rcpt = '451 4.3.0 try later';
    await sender().sendDue();
    const t = await state(temp.id);
    assert.equal(t.state, 'retry_wait');
    assert.equal(t.last_error, 'mail_temporary_failure');
    assert.ok(t.wait! > 55 && t.wait! <= 60, `첫 재시도는 1분 뒤(흔들림 없음): ${t.wait}`);
    await db.query(`UPDATE mail_jobs SET state = 'cancelled', cancel_reason = 'rule_disabled', next_attempt_at = NULL WHERE id = $1`, [temp.id]);

    const rejected = await job(inc, 'nobody@example.test');
    fake.script.rcpt = '550 5.1.1 no such user';
    await sender().sendDue();
    assert.deepEqual(await state(rejected.id), { state: 'failed', last_error: 'mail_recipient_rejected', attempts: 1, wait: null });

    const lost = await job(inc, 'dev@example.test');
    fake.script = { end: null };
    await sender().sendDue();
    const u = await state(lost.id);
    assert.equal(u.state, 'unknown');
    assert.equal(u.last_error, 'mail_no_response_after_data');
    fake.script = {};
    await db.query('UPDATE mail_jobs SET next_attempt_at = now() WHERE id = $1', [lost.id]);
    await sender().sendDue();
    assert.equal((await state(lost.id)).state, 'accepted');
    const ids = fake.received.filter((r) => r.to === 'dev@example.test').map((r) => read(r.data).header('Message-ID'));
    assert.deepEqual(ids, [lost.message_id, lost.message_id]);

    // 시도 상한(12회)이나 첫 시도부터 4시간을 넘기면 다시 보내지 않고 최종 실패다.
    fake.script.rcpt = '451 4.3.0 try later';
    const many = await job(inc, 'a@example.test', { attempts: 11 });
    const old = await job(inc, 'b@example.test', { createdAgo: '4 hours' });
    await sender().sendDue();
    assert.equal((await state(many.id)).last_error, 'mail_retry_exhausted');
    assert.equal((await state(old.id)).state, 'failed');
    assert.equal((await state(old.id)).last_error, 'mail_retry_exhausted');
  });

  it('다시 시작하면 전송 중에 멈춘 작업을 다시 보내고, 테스트 메일과 취소된 작업은 다루지 않는다', async () => {
    const inc = await incident('inc-1');
    const stuck = await job(inc, 'ops@example.test', { state: 'sending', attempts: 1 });
    const test = await job(inc, 'test@example.test', { state: 'sending', kind: 'test' });
    await job(inc, 'off@example.test', { state: 'cancelled' });
    assert.equal(await sender().recover(), 1);
    assert.equal((await state(stuck.id)).state, 'unknown');
    assert.equal((await state(test.id)).state, 'sending');
    assert.equal(await sender().sendDue(), 1);
    assert.deepEqual(fake.received.map((r) => r.to), ['ops@example.test']);
    assert.equal(read(fake.received[0].data).header('Message-ID'), stuck.message_id);
  });

  it('설치 전체 발송 속도 상한 안에서만 꺼낸다', async () => {
    const inc = await incident('inc-1');
    for (const to of ['a@example.test', 'b@example.test', 'c@example.test']) await job(inc, to);
    assert.equal(await sender({ mailRatePerMinute: 2 }).sendDue(), 2);
    assert.equal(await sender({ mailRatePerMinute: 2 }).sendDue(), 0);
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM mail_jobs WHERE state = 'queued'`)).n, 1);
  });

  it('수신처 고정이 있으면 작업의 수신자 대신 그 주소로만 보낸다', async () => {
    await job(await incident('inc-1'), 'someone@example.test');
    await sender({}, { redirectTo: 'me@example.test' }).sendDue();
    assert.deepEqual(fake.received.map((r) => r.to), ['me@example.test']);
  });

  it('운영 메일은 10분 넘게 관측되지 않는 연결을 묶어 한 번 보내고, 다시 관측되면 조용히 닫는다', async () => {
    const conn = (path: string, state: string) =>
      one<{ id: number }>(
        `INSERT INTO connections (service_id, server_id, target_type, target_path, format_type, max_event_bytes, management_state, archived_at)
         VALUES (1, 1, 'file', $1, 'text', 1024, $2, CASE WHEN $2 = 'archived' THEN now() END) RETURNING id`,
        [path, state],
      );
    const status = async (id: number, ago: string) => {
      await db.query(`INSERT INTO ingest_keys (key_id, connection_id, secret_hash, slot, issued_as) VALUES ($1, $2, '\\x00', 1, 'register')`, [`k${id}`, id]);
      await db.query(
        `INSERT INTO connection_status (connection_id, last_report_at, report, agent_instance_id, agent_version, key_id, observed_states)
         VALUES ($1, now() - $2::interval, '{}', 'agent-1', '0.1.0', $3, '{collecting}')`,
        [id, ago, `k${id}`],
      );
    };
    const quiet = await conn('/var/app/billing/app.log', 'active');
    await status(quiet.id, '1 hour'); // 보고가 끊김
    const fine = await conn('/var/app/billing/worker.log', 'active');
    await status(fine.id, '10 seconds');
    await conn('/var/app/billing/new.log', 'pending'); // 첫 보고 전이라 넣지 않는다
    const ops = new OpsEpisodes(db, config);

    assert.deepEqual(await ops.check(), { opened: 1, closed: 0, batched: 0 });
    await db.query(`UPDATE ops_episodes SET started_at = now() - interval '11 minutes'`);
    // 받을 주소가 없으면 묶지 않고 기다린다. 주소가 생기면 아직 이어지는 일을 그때 보낸다.
    assert.equal((await ops.check()).batched, 0);
    await db.query(`INSERT INTO ops_recipients (address) VALUES ('ops@example.test')`);
    assert.equal((await ops.check()).batched, 1);
    assert.equal((await ops.check()).batched, 0);
    assert.equal(await sender().sendDue(), 1);
    const m = read(fake.received[0].data);
    assert.equal(m.header('Subject'), '[LogDock] 운영 알림 — 1건');
    assert.match(m.text, /^- 수집 연결 관측 불가: billing · app-01 · \/var\/app\/billing\/app\.log \(시작 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+09:00\)$/m);
    assert.ok(m.text.includes('수집 상태 보기: https://logdock.example.test/connections'));

    await db.query(`UPDATE connection_status SET last_report_at = now() WHERE connection_id = $1`, [quiet.id]);
    assert.deepEqual(await ops.check(), { opened: 0, closed: 1, batched: 0 });
    assert.equal(await sender().sendDue(), 0);

    // 수신처 고정이 있으면 운영 수신 주소 대신 그 주소로 묶는다.
    await db.query('DELETE FROM ops_recipients');
    await db.query(`UPDATE connection_status SET last_report_at = now() - interval '1 hour' WHERE connection_id = $1`, [quiet.id]);
    const redirected = new OpsEpisodes(db, { ...config, mail: { ...config.mail!, redirectTo: 'me@example.test' } });
    await redirected.check();
    await db.query(`UPDATE ops_episodes SET started_at = now() - interval '11 minutes' WHERE ended_at IS NULL`);
    assert.equal((await redirected.check()).batched, 1);
    assert.equal((await one(`SELECT recipient FROM mail_jobs WHERE kind = 'ops' AND state = 'queued'`)).recipient, 'me@example.test');
  });
});
