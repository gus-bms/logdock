// 알림 평가 시험(계약 5.4절, Q12, TD-11~TD-14). 건수는 흉내 ClickHouse가 주고, 임시 PostgreSQL에서 상태 전이·사건·메일
// 작업·평가 기록·운영 일을 확인한다. 검색 가능 시각을 지난 시각으로 1분씩 옮겨 회차를 만든다. 합성 이름·주소만 쓴다.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ClickHouseError, type ClickHouse } from '../clickhouse/clickhouse.js';
import { type AppConfig, DEFAULTS, type MailConfig } from '../config.js';
import { Database } from '../db/database.js';
import { type EphemeralPostgres, startPostgres } from '../test-support/harness.js';
import { AlertEvaluator } from './alert-evaluator.js';

const MAIL: MailConfig = { host: 'smtp.example.test', port: 465, security: 'tls', from: 'logdock@example.test', user: null, password: null, ca: null, redirectTo: null };
const COND = { sources: { service_ids: [1], server_ids: [], environments: [], connection_ids: [] }, levels: ['ERROR'], body: [], fields: [] };

/** 질의마다 차례로 답한다. 답이 없으면 마지막 답을 되풀이한다. */
class FakeClickHouse {
  readonly logs = '`logdock_test`.`logs_fake`';
  answers: (() => { n: number; u?: number; oldest?: string })[] = [];
  calls = 0;
  async rows<T>(): Promise<T[]> {
    const a = this.answers[Math.min(this.calls++, this.answers.length - 1)]();
    return [{ n: String(a.n), u: String(a.u ?? 0), oldest: a.oldest ?? '2026-11-05 00:00:00.000000' }] as T[];
  }
}

describe('worker: 알림 평가', () => {
  let pg: EphemeralPostgres;
  let db: Database;
  let config: AppConfig;
  let ch: FakeClickHouse;
  let ev: AlertEvaluator;
  let base: number;
  const at = (min: number) => new Date(base + min * 60_000).toISOString();
  const watermark = (min: number) => db.query('UPDATE ingest_watermark SET searchable_through = $1, updated_at = now()', [at(min)]);
  const rule = async () => (await db.query<{ eval_state: string; resolve_streak: number; quality: string | null }>('SELECT eval_state, resolve_streak, quality FROM alert_rules WHERE id = 1')).rows[0];
  const evals = async () => (await db.query<{ status: string; matched_count: string | null; partial: boolean; error_code: string | null }>('SELECT status, matched_count::text, partial, error_code FROM alert_evaluations ORDER BY window_end')).rows;
  const answer = (...ns: number[]) => {
    ch.calls = 0;
    ch.answers = ns.map((n) => () => ({ n }));
  };

  before(async () => {
    pg = await startPostgres();
    config = { ...DEFAULTS, mail: MAIL, db: { host: pg.host, port: pg.port, user: pg.user, database: pg.database, max: 4 } };
    db = new Database(config);
  });

  after(async () => {
    await db?.onModuleDestroy();
    await pg?.stop();
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE accounts, services, connections, connection_status, ingest_keys, alert_rules, alert_rule_recipients, alert_incidents,
                alert_evaluations, mail_jobs, ops_episodes, ingest_watermark RESTART IDENTITY CASCADE`,
    );
    await db.query(`INSERT INTO accounts (name, password_hash) VALUES ('admin', 'x')`);
    await db.query(`INSERT INTO services (name) VALUES ('billing')`);
    await db.query(
      `INSERT INTO alert_rules (owner_account_id, name, enabled, condition, window_minutes, threshold, resolve_wait_minutes)
       VALUES (1, '결제 오류', true, $1, 5, 3, 2)`,
      [COND],
    );
    await db.query(`INSERT INTO alert_rule_recipients (rule_id, address) VALUES (1, 'a@example.test'), (1, 'b@example.test')`);
    base = Math.floor((Date.now() - 3 * 3_600_000) / 60_000) * 60_000;
    await db.query('INSERT INTO ingest_watermark (searchable_through) VALUES ($1)', [at(0)]);
    ch = new FakeClickHouse();
    ev = new AlertEvaluator(db, config, ch as unknown as ClickHouse);
  });

  it('임계 이상이면 사건을 열고 받는 사람마다 메일 작업을 만들고, 해소 대기 시간 동안 미만이면 닫는다', async () => {
    answer(1);
    assert.equal((await ev.round()).evaluated, 1);
    assert.equal((await rule()).eval_state, 'normal');
    assert.equal((await rule()).quality, 'no_targets');

    await watermark(1);
    answer(4);
    await ev.round();
    assert.equal((await rule()).eval_state, 'firing');
    const inc = (await db.query<{ matched_count: string; window_start: Date; window_end: Date; closed_at: Date | null }>('SELECT matched_count::text, window_start, window_end, closed_at FROM alert_incidents')).rows;
    assert.equal(inc.length, 1);
    assert.equal(inc[0].matched_count, '4');
    assert.equal(inc[0].window_end.toISOString(), at(1));
    assert.equal(inc[0].window_start.toISOString(), at(-4));
    const jobs = (await db.query<{ recipient: string; state: string }>('SELECT recipient, state FROM mail_jobs ORDER BY id')).rows;
    assert.deepEqual(jobs, [
      { recipient: 'a@example.test', state: 'queued' },
      { recipient: 'b@example.test', state: 'queued' },
    ]);

    // 같은 창은 다시 평가하지 않는다.
    assert.equal((await ev.round()).window_end, null);

    await watermark(2);
    answer(0);
    await ev.round();
    assert.deepEqual(await rule(), { eval_state: 'resolving', resolve_streak: 1, quality: 'no_targets' });

    // 해소 대기 중 다시 임계 이상이면 같은 사건으로 이어지고 새 메일이 없다.
    await watermark(3);
    answer(5);
    await ev.round();
    assert.equal((await rule()).eval_state, 'firing');
    assert.equal((await db.query('SELECT 1 FROM mail_jobs')).rowCount, 2);

    await watermark(4);
    answer(0);
    await ev.round();
    await watermark(5);
    await ev.round();
    assert.deepEqual(await rule(), { eval_state: 'normal', resolve_streak: 0, quality: 'no_targets' });
    const closed = (await db.query<{ close_reason: string }>('SELECT close_reason FROM alert_incidents')).rows;
    assert.deepEqual(closed, [{ close_reason: 'resolved' }]);
    assert.deepEqual((await evals()).map((e) => e.status), ['below', 'met', 'below', 'met', 'below', 'below']);
  });

  it('밀린 창은 건너뜀으로 남기고 지금 창을 평가한다(TD-12)', async () => {
    answer(0);
    await ev.round();
    await watermark(3);
    const r = await ev.round();
    assert.equal(r.skipped, 2);
    assert.deepEqual((await evals()).map((e) => e.status), ['below', 'skipped', 'skipped', 'below']);
  });

  it('부분 건수가 임계 이상이면 발화하고 일부 구간만 평가로 표시하며, 미만이면 미평가다(TD-13)', async () => {
    await db.query('UPDATE alert_rules SET window_minutes = 120 WHERE id = 1');
    ch.calls = 0;
    ch.answers = [
      () => ({ n: 4 }),
      () => {
        throw new ClickHouseError('Code: 159. Timeout exceeded', 159, 500);
      },
    ];
    await ev.round();
    const inc = (await db.query<{ partial: boolean; matched_count: string }>('SELECT partial, matched_count::text FROM alert_incidents')).rows;
    assert.deepEqual(inc, [{ partial: true, matched_count: '4' }]);
    assert.deepEqual((await evals()).map((e) => [e.status, e.partial]), [['met', true]]);

    await watermark(1);
    ch.calls = 0;
    ch.answers = [
      () => ({ n: 1 }),
      () => {
        throw new ClickHouseError('Code: 159. Timeout exceeded', 159, 500);
      },
    ];
    await ev.round();
    assert.deepEqual((await evals()).at(-1), { status: 'unevaluable', matched_count: '1', partial: true, error_code: 'budget' });
    assert.equal((await rule()).eval_state, 'firing');
  });

  it('평가가 실패하면 미평가로 남기고 운영 일을 열며, 성공하면 닫는다(Q12-06)', async () => {
    ch.answers = [
      () => {
        throw new Error('connection refused');
      },
    ];
    const r = await ev.round();
    assert.equal(r.failed, 1);
    assert.deepEqual((await evals()).map((e) => [e.status, e.error_code]), [['unevaluable', 'eval_failed']]);
    const open = await db.query(`SELECT 1 FROM ops_episodes WHERE kind = 'alert_eval_failed' AND ended_at IS NULL`);
    assert.equal(open.rowCount, 1);
    await watermark(1);
    answer(0);
    await ev.round();
    assert.equal((await db.query(`SELECT 1 FROM ops_episodes WHERE kind = 'alert_eval_failed' AND ended_at IS NULL`)).rowCount, 0);
  });

  it('감시 불가면 해소 계산을 멈추고, 수신처 고정이면 메일 작업이 하나다', async () => {
    const redirected = new AlertEvaluator(db, { ...config, mail: { ...MAIL, redirectTo: 'me@example.test' } }, ch as unknown as ClickHouse);
    answer(5);
    await redirected.round();
    assert.deepEqual((await db.query<{ recipient: string }>('SELECT recipient FROM mail_jobs')).rows, [{ recipient: 'me@example.test' }]);

    // 대상 연결 하나가 보고를 오래 끊으면 관측 판단 대상이 모두 관측되지 않아 감시 불가다.
    await db.query(
      `INSERT INTO connections (service_id, target_type, target_path, format_type, max_event_bytes, management_state)
       VALUES (1, 'file', '/var/app/billing/app.log', 'json', 1024, 'active')`,
    );
    await db.query(`INSERT INTO ingest_keys (key_id, connection_id, secret_hash, slot, issued_as) VALUES ('k1', 1, '\\x00', 1, 'register')`);
    await db.query(
      `INSERT INTO connection_status (connection_id, last_report_at, report, agent_instance_id, agent_version, key_id, observed_states)
       VALUES (1, now() - interval '1 hour', '{}', 'agent-1', '0.1.0', 'k1', ARRAY['collecting'])`,
    );
    await watermark(1);
    answer(0);
    await redirected.round();
    assert.deepEqual(await rule(), { eval_state: 'firing', resolve_streak: 0, quality: 'unmonitorable' });
  });
});
