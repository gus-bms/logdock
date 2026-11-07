// 기록 정리 시험(계약 3.4절 보관 기간·알림 기록, 4.3절 연속 실패 잠금, Q10-13, Q12-14, UI-07). 임시 PostgreSQL에 오래된 행과
// 남아야 할 행을 넣고 한 회차를 돌려 확인한다. 합성 값만 쓴다.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type AppConfig, DEFAULTS } from '../config.js';
import { Database } from '../db/database.js';
import { type EphemeralPostgres, startPostgres } from '../test-support/harness.js';
import { Cleanup } from './cleanup.js';

describe('worker: 기록 정리', () => {
  let pg: EphemeralPostgres;
  let db: Database;
  let config: AppConfig;
  const count = async (sql: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`)).rows[0].n;
  const ago = (v: string) => `now() - interval '${v}'`;

  before(async () => {
    pg = await startPostgres();
    config = { ...DEFAULTS, db: { host: pg.host, port: pg.port, user: pg.user, database: pg.database, max: 4 }, cleanup: { ...DEFAULTS.cleanup, batchRows: 2 } };
    db = new Database(config);
  });

  after(async () => {
    await db?.onModuleDestroy();
    await pg?.stop();
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE accounts, sessions, login_throttle, idempotency_keys, audit_log, audit_gaps, audit_cleanups, services, servers, connections,
                status_history, alert_rules, alert_rule_recipients, alert_incidents, alert_evaluations, mail_jobs, ops_episodes,
                ops_mail_batches, early_deletions, notices RESTART IDENTITY CASCADE`,
    );
    await db.query(`INSERT INTO accounts (name, password_hash) VALUES ('admin', 'x')`);
  });

  it('끝난 세션·풀린 시도 기록·지난 중복 요청 키를 지우고, 잠긴 행과 이어 세는 연속 실패는 남긴다', async () => {
    const session = (created: string, active: string, revoked: string | null) =>
      db.query(
        `INSERT INTO sessions (id_hash, account_id, created_at, last_active_at, revoked_at, revoke_reason, csrf_token)
         VALUES (gen_random_uuid()::text::bytea, 1, ${ago(created)}, ${ago(active)},
                 ${revoked ? ago(revoked) : 'NULL'}, ${revoked ? `'logout'` : 'NULL'}, decode(repeat('ab', 32), 'hex'))`,
      );
    await session('3 days', '3 days', '2 days'); // 로그아웃하고 하루가 지남
    await session('3 days', '30 seconds', null); // 최대 수명(24시간)이 지난 지 하루가 넘음
    await session('1 hour', '1 minute', null); // 쓰는 중
    await session('2 hours', '90 minutes', null); // 비활동으로 끝났지만 아직 하루가 안 됨

    const throttle = (key: string, updated: string, extra: { consecutive?: number; locked?: boolean; blockedFor?: string } = {}) =>
      db.query(
        `INSERT INTO login_throttle (key_hash, failures, updated_at, consecutive_failures, locked_at, blocked_until)
         VALUES ($1::bytea, 1, ${ago(updated)}, $2, ${extra.locked ? ago(updated) : 'NULL'},
                 ${extra.blockedFor ? `now() + interval '${extra.blockedFor}'` : 'NULL'})`,
        [key, extra.consecutive ?? 0],
      );
    await throttle('window-old', '2 days'); // 지움
    await throttle('window-new', '1 hour'); // 남김
    await throttle('blocked', '2 days', { blockedFor: '10 minutes' }); // 아직 막혀 있어 남김
    await throttle('counting', '2 days', { consecutive: 40 }); // 연속 실패를 이어 세야 해 남김
    await throttle('counting-old', '100 days', { consecutive: 40 }); // 90일이 지나 지움
    await throttle('locked', '400 days', { consecutive: 100, locked: true }); // 잠김은 로컬 재설정 전까지 남김

    for (const [key, at] of [['k-old', '2 days'], ['k-new', '1 hour']]) {
      await db.query(
        `INSERT INTO idempotency_keys (account_id, idem_key, request_kind, request_hash, status_code, result, created_at)
         VALUES (1, $1, 'x', '\\x00', 201, '{}', ${ago(at)})`,
        [key],
      );
    }

    const r = await new Cleanup(db, config).run();
    assert.equal(r.sessions, 2);
    assert.equal(r.login_throttle, 2);
    assert.equal(r.idempotency_keys, 1);
    assert.equal(await count('sessions'), 2);
    assert.deepEqual(
      (await db.query<{ k: string }>(`SELECT convert_from(key_hash, 'UTF8') AS k FROM login_throttle ORDER BY 1`)).rows.map((x) => x.k),
      ['blocked', 'counting', 'locked', 'window-new'],
    );
    assert.deepEqual((await db.query<{ idem_key: string }>('SELECT idem_key FROM idempotency_keys')).rows.map((x) => x.idem_key), ['k-new']);
  });

  it('감사는 90일이 지난 행을 지우고, 저장 상한을 넘으면 더 일찍 지우며 지운 구간을 남긴다', async () => {
    const audit = (at: string) =>
      db.query(`INSERT INTO audit_log (logged_at, actor_type, account_id, action, result) VALUES (${ago(at)}, 'shared_account', 1, 'auth.login', 'success')`);
    await audit('100 days');
    await audit('95 days');
    for (const at of ['5 days', '4 days', '3 days', '2 days', '1 day']) await audit(at);
    await db.query(`INSERT INTO audit_gaps (started_at, ended_at) VALUES (${ago('100 days')}, ${ago('99 days')}), (${ago('1 day')}, NULL)`);

    const r = await new Cleanup(db, { ...config, cleanup: { ...config.cleanup, auditMaxRows: 3 } }).run();
    assert.equal(r.audit_log, 4);
    assert.equal(r.audit_gaps, 1);
    assert.equal(await count('audit_log'), 3);
    const cleanups = (
      await db.query<{ removed_rows: string; early: boolean; days: number }>(
        `SELECT removed_rows::text, early, round(extract(epoch FROM now() - removed_to) / 86400)::int AS days FROM audit_cleanups ORDER BY id`,
      )
    ).rows;
    assert.deepEqual(cleanups, [
      { removed_rows: '2', early: false, days: 95 },
      { removed_rows: '2', early: true, days: 4 },
    ]);
    assert.equal(await count('audit_gaps WHERE ended_at IS NULL'), 1);
  });

  it('알림 이력은 로그 보관 기간 뒤 지우고, 지운 규칙은 사건이 모두 정리되면 행까지 지운다', async () => {
    const rule = async (name: string, deleted: boolean) =>
      (
        await db.query<{ id: number }>(
          `INSERT INTO alert_rules (owner_account_id, name, enabled, condition, window_minutes, threshold, deleted_at)
           VALUES (1, $1, false, '{}', 5, 1, ${deleted ? 'now()' : 'NULL'}) RETURNING id`,
          [name],
        )
      ).rows[0].id;
    const live = await rule('live', false);
    const gone = await rule('gone', true); // 사건이 모두 정리되어 행까지 지움
    const goneWithHistory = await rule('gone-recent', true); // 최근 사건이 남아 행을 남김
    await db.query(`INSERT INTO alert_rule_recipients (rule_id, address) VALUES ($1, 'ops@example.test'), ($2, 'ops@example.test')`, [gone, live]);
    const incident = async (ruleId: number, ref: string, fired: string, closed: boolean) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO alert_incidents (public_ref, rule_id, condition_version, rule_name, condition, window_minutes, threshold, window_start,
                                        window_end, fired_at, matched_count, quality, closed_at, close_reason)
           VALUES ($1, $2, 1, 'r', '{}', 5, 1, ${ago(fired)} - interval '5 minutes', ${ago(fired)}, ${ago(fired)}, 1, 'complete',
                   ${closed ? 'now()' : 'NULL'}, ${closed ? `'resolved'` : 'NULL'})
           RETURNING id::text`,
          [ref, ruleId],
        )
      ).rows[0].id;
    const old = await incident(live, 'old', '7 months', true);
    await incident(live, 'old-open', '7 months', false); // 열린 사건은 남김
    await incident(live, 'recent', '1 day', true);
    await incident(goneWithHistory, 'gone-recent', '1 day', true);
    await db.query(`INSERT INTO mail_jobs (kind, incident_id, recipient, message_id, state) VALUES ('alert', $1, 'ops@example.test', '<m1@example.test>', 'failed')`, [old]);
    const evaluation = (ruleId: number, end: string, status: string) =>
      db.query(
        `INSERT INTO alert_evaluations (rule_id, window_end, window_start, condition_version, status)
         VALUES ($1, ${ago(end)}, ${ago(end)} - interval '5 minutes', 1, $2)`,
        [ruleId, status],
      );
    await evaluation(live, '8 days', 'met'); // 충족·미달 회차는 7일
    await evaluation(live, '8 days 1 minute', 'unevaluable'); // 미평가는 알림 이력과 같이 남김
    await evaluation(live, '7 months', 'skipped'); // 보관 기간이 지나 지움
    await evaluation(gone, '1 day', 'below'); // 지운 규칙과 함께 지움

    const batch = (await db.query<{ id: string }>(`INSERT INTO ops_mail_batches (created_at) VALUES (${ago('7 months')}) RETURNING id::text`)).rows[0].id;
    await db.query(`INSERT INTO ops_episodes (kind, started_at, ops_batch_id, ended_at) VALUES ('alert_eval_failed', ${ago('7 months')}, $1, ${ago('7 months')})`, [batch]);
    await db.query(
      `INSERT INTO mail_jobs (kind, ops_batch_id, recipient, message_id, state, accepted_at, created_at)
       VALUES ('ops', $1, 'ops@example.test', '<m2@example.test>', 'accepted', ${ago('7 months')}, ${ago('7 months')})`,
      [batch],
    );

    await db.query(`INSERT INTO services (name) VALUES ('billing')`);
    await db.query(
      `INSERT INTO connections (service_id, target_type, target_path, format_type, max_event_bytes) VALUES (1, 'file', '/var/app/billing/app.log', 'text', 1024)`,
    );
    await db.query(`INSERT INTO status_history (connection_id, reported_at, changes) VALUES (1, ${ago('31 days')}, '{}'), (1, now(), '{}')`);
    await db.query(`INSERT INTO early_deletions (happened_at, received_from, received_to) VALUES (${ago('7 months')}, now() - interval '9 months', now() - interval '8 months')`);
    await db.query(
      `INSERT INTO notices (kind, raised_at, cleared_at, acknowledged_at) VALUES
         ('disk_warning', ${ago('40 days')}, ${ago('31 days')}, NULL),
         ('audit_gap', ${ago('40 days')}, NULL, ${ago('31 days')}),
         ('disk_warning', now(), NULL, NULL)`,
    );

    const r = await new Cleanup(db, config).run();
    assert.ok(Object.values(r).every((n) => n >= 0), JSON.stringify(r));
    assert.deepEqual((await db.query<{ public_ref: string }>('SELECT public_ref FROM alert_incidents ORDER BY public_ref')).rows.map((x) => x.public_ref), [
      'gone-recent',
      'old-open',
      'recent',
    ]);
    assert.deepEqual((await db.query<{ name: string }>('SELECT name FROM alert_rules ORDER BY name')).rows.map((x) => x.name), ['gone-recent', 'live']);
    assert.equal(await count('alert_rule_recipients'), 1);
    assert.deepEqual((await db.query<{ status: string }>('SELECT status FROM alert_evaluations')).rows.map((x) => x.status), ['unevaluable']);
    assert.equal(await count('mail_jobs'), 0);
    assert.equal(await count('ops_episodes'), 0);
    assert.equal(await count('ops_mail_batches'), 0);
    assert.equal(await count('status_history'), 1);
    assert.equal(await count('early_deletions'), 0);
    assert.equal(await count('notices'), 1);
  });
});
