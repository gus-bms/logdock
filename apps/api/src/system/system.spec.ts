// 화면용 설정값·전역 배너·조건 값 목록·감사 이력 시험(계약 4.2·4.3·4.4·5.6절, CM-01·CM-03, UI-15). 임시 PostgreSQL에 행을 직접
// 넣어 다른 작업(감사·저장 공간 측정·평가·발송)이 남긴 상태를 흉내 낸다. 합성 이름·주소만 쓴다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';

import { hashPassword } from '../auth/password.js';
import { encodeConnectionId } from '../connections/public-id.js';
import { type Api, Client, type EphemeralPostgres, type Reply, startApi, startPostgres } from '../test-support/harness.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';

describe('설정값·배너·조건 값 목록·감사 이력', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let c: Client;
  const one = async <T = any>(sql: string, values: unknown[] = []): Promise<T> => (await api.db.query(sql, values)).rows[0] as T;
  const reasons = (r: Reply) => (r.body.params.fields as { path: string; reason: string }[]).map((f) => `${f.path}:${f.reason}`).sort();
  const kinds = async () => ((await c.call('GET', '/api/v1/notices')).body.items as any[]).map((n) => [n.kind, n.item_count, n.acknowledgeable]);

  before(async () => {
    pg = await startPostgres();
    api = await startApi(pg, {
      displayTimezone: 'Asia/Seoul',
      mail: { host: 'smtp.example.test', port: 465, security: 'tls', from: 'logdock@example.test', user: null, password: null, ca: null },
    });
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
      `TRUNCATE services, servers, connections, alert_rules, alert_rule_recipients, alert_incidents, mail_jobs, mail_status,
                ops_recipients, notices, audit_log, audit_gaps, audit_cleanups RESTART IDENTITY CASCADE`,
    );
  });

  it('화면용 설정값은 표시 시간대·보관 기간·세션 규칙·개수 상한·제품 버전을 주고 비밀 값은 없다', async () => {
    const r = await c.call('GET', '/api/v1/settings');
    assert.equal(r.status, 200);
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
    assert.deepEqual(r.body, {
      display_timezone: 'Asia/Seoul',
      log_retention: { months: 6 },
      session: { idle_seconds: 3600, absolute_seconds: 86400, reauth_seconds: 900 },
      limits: { saved_searches: 100, alert_rules: 50, recipients_per_rule: 10, ops_recipients: 10 },
      mail_configured: true,
      product_version: version,
    });
  });

  it('조건 값 목록은 보관된 대상과 미입력을 함께 주고 수집 대상을 서비스별로 묶는다', async () => {
    await api.db.query(`INSERT INTO services (name, state, archived_at) VALUES ('billing', 'active', NULL), ('legacy', 'archived', now())`);
    await api.db.query(`INSERT INTO servers (display_name) VALUES ('app-01'), ('orphan')`);
    const conn = (service: number, server: number | null, env: string | null, path: string, state = 'active') =>
      one<{ id: number }>(
        `INSERT INTO connections (service_id, server_id, environment, target_type, target_path, format_type, max_event_bytes, management_state, archived_at)
         VALUES ($1, $2, $3, 'file', $4, 'text', 1024, $5, CASE WHEN $5 = 'archived' THEN now() END) RETURNING id`,
        [service, server, env, path, state],
      );
    const a = await conn(1, 1, '운영', '/var/app/billing/app.log');
    const b = await conn(1, null, null, '/var/app/billing/worker.log');
    const old = await conn(2, 1, '스테이징', '/var/app/legacy/app.log', 'archived');

    const r = await c.call('GET', '/api/v1/sources');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.services, [
      { id: 1, name: 'billing', state: 'active' },
      { id: 2, name: 'legacy', state: 'archived' },
    ]);
    assert.deepEqual(r.body.servers, [{ id: 1, display_name: 'app-01' }, { id: null, display_name: null }]);
    assert.deepEqual(r.body.environments, ['스테이징', '운영', null]);
    assert.deepEqual(
      r.body.targets.map((g: any) => [g.service_id, g.connections.map((x: any) => [x.id, x.server_display_name, x.management_state])]),
      [
        [1, [[encodeConnectionId(b.id), null, 'active'], [encodeConnectionId(a.id), 'app-01', 'active']]],
        [2, [[encodeConnectionId(old.id), 'app-01', 'archived']]],
      ],
    );
  });

  it('배너는 원인을 다시 보는 종류와 저장된 종류를 4.4절 순서로 주고, 지나간 일만 확인해 내린다', async () => {
    // 운영 수신 주소가 없으면 늘 뜬다.
    assert.deepEqual(await kinds(), [['ops_recipients_missing', null, false]]);
    await api.db.query(`INSERT INTO ops_recipients (address) VALUES ('ops@example.test')`);
    assert.deepEqual(await kinds(), []);

    // 연결·설정 문제로 마지막 발송이 실패했다. 주소 문제는 배너가 아니다.
    await api.db.query(`INSERT INTO mail_status (id, last_attempt_at, last_error) VALUES (1, now(), 'mail_recipient_rejected')`);
    assert.deepEqual(await kinds(), []);
    await api.db.query(`UPDATE mail_status SET last_error = 'mail_auth_failed'`);
    assert.deepEqual(await kinds(), [['mail_connection_error', null, false]]);
    await api.db.query(`UPDATE mail_status SET last_error = NULL, last_success_at = now()`);

    // 켜진 규칙이 기준(10분)보다 오래 평가되지 않았다. 막 켠 규칙은 아직 아니다.
    await api.db.query(
      `INSERT INTO alert_rules (owner_account_id, name, enabled, condition, window_minutes, threshold, state_since)
       VALUES (1, 'old', true, '{}', 5, 1, now() - interval '1 hour'), (1, 'new', true, '{}', 5, 1, now()),
              (1, 'off', false, '{}', 5, 1, now() - interval '1 hour')`,
    );
    assert.deepEqual(await kinds(), [['alert_eval_stopped', 1, false]]);
    await api.db.query(`UPDATE alert_rules SET last_success_eval_at = now()`);

    // 확인하지 않은 알림 메일 최종 실패의 수. 확인하면 내려간다.
    const inc = await one<{ id: string }>(
      `INSERT INTO alert_incidents (public_ref, rule_id, condition_version, rule_name, condition, window_minutes, threshold,
                                    window_start, window_end, fired_at, matched_count, quality)
       VALUES ('inc-1', 1, 1, 'old', '{}', 5, 1, now() - interval '5 minutes', now(), now(), 3, 'complete') RETURNING id`,
    );
    for (const to of ['a@example.test', 'b@example.test']) {
      await api.db.query(`INSERT INTO mail_jobs (kind, incident_id, recipient, message_id, state) VALUES ('alert', $1, $2, $3, 'failed')`, [
        inc.id,
        to,
        `<${to}-1@example.test>`,
      ]);
    }
    assert.deepEqual(await kinds(), [['mail_final_failures', 2, false]]);
    await c.call('POST', '/api/v1/incidents/inc-1/ack-final-failures');
    assert.deepEqual(await kinds(), []);

    // 다른 작업이 남긴 배너. 지나간 일만 사람이 확인해 내린다.
    const gap = await one<{ id: string }>(`INSERT INTO notices (kind, item_count) VALUES ('audit_gap', 2) RETURNING id::text`);
    const disk = await one<{ id: string }>(`INSERT INTO notices (kind) VALUES ('disk_warning') RETURNING id::text`);
    assert.deepEqual(await kinds(), [['audit_gap', 2, true], ['disk_warning', null, false]]);
    const notAllowed = await c.call('POST', `/api/v1/notices/${disk.id}/ack`);
    assert.equal(notAllowed.status, 409);
    assert.equal(notAllowed.body.code, 'invalid_state');
    assert.deepEqual((await c.call('POST', `/api/v1/notices/${gap.id}/ack`)).body, { id: gap.id, kind: 'audit_gap', acknowledged: true });
    assert.equal((await c.call('POST', `/api/v1/notices/${gap.id}/ack`)).status, 404);
    assert.equal((await c.call('POST', '/api/v1/notices/abc/ack')).status, 404);
    assert.deepEqual(await kinds(), [['disk_warning', null, false]]);
  });

  it('감사 이력은 최신순으로 나눠 주고 기간·동작·결과로 거르며 조회 가능 시작·조기 정리·공백 구간을 준다', async () => {
    const audit = (action: string, ago: string, result = 'success', target: string | null = null) =>
      api.db.query(
        `INSERT INTO audit_log (logged_at, actor_type, account_id, action, target_type, target_ref, result)
         VALUES (now() - $2::interval, 'shared_account', 1, $1, CASE WHEN $4::text IS NULL THEN NULL ELSE 'connection' END, $4, $3)`,
        [action, ago, result, target],
      );
    await audit('auth.login', '3 hours');
    await audit('connection.archive', '2 hours', 'success', 'c_abc12');
    await audit('auth.login_failed', '90 minutes', 'failure');
    await audit('alert_rule.update', '1 hour');
    await api.db.query(`INSERT INTO audit_gaps (started_at, ended_at) VALUES (now() - interval '100 minutes', now() - interval '95 minutes')`);
    await api.db.query(
      `INSERT INTO audit_cleanups (removed_from, removed_to, removed_rows, early) VALUES (now() - interval '100 days', now() - interval '80 days', 12, true)`,
    );

    const page1 = await c.call('POST', '/api/v1/audit/search', { body: { limit: 2 } });
    assert.equal(page1.status, 200, JSON.stringify(page1.body));
    assert.deepEqual(page1.body.items.map((x: any) => x.action), ['alert_rule.update', 'auth.login_failed']);
    assert.equal(page1.body.items[0].account_name, 'admin');
    const page2 = await c.call('POST', '/api/v1/audit/search', { body: { limit: 2, cursor: page1.body.next_cursor } });
    assert.deepEqual(page2.body.items.map((x: any) => x.action), ['connection.archive', 'auth.login']);
    assert.equal(page2.body.next_cursor, null);
    assert.match(page1.body.available_from, /Z$/);
    assert.deepEqual(page1.body.cleanups.map((x: any) => [x.removed_rows, x.early]), [[12, true]]);
    assert.equal(page1.body.gaps.length, 1);

    const pick = async (body: object) => (await c.call('POST', '/api/v1/audit/search', { body })).body.items.map((x: any) => x.action);
    assert.deepEqual(await pick({ actions: ['auth.login', 'auth.login_failed'] }), ['auth.login_failed', 'auth.login']);
    assert.deepEqual(await pick({ result: 'failure' }), ['auth.login_failed']);
    assert.deepEqual(await pick({ target_type: 'connection', target_ref: 'c_abc12' }), ['connection.archive']);
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    assert.deepEqual(await pick({ from: iso(150 * 60_000), to: iso(80 * 60_000) }), ['auth.login_failed', 'connection.archive']);
    const windowed = await c.call('POST', '/api/v1/audit/search', { body: { from: iso(60 * 60_000), to: iso(0) } });
    assert.equal(windowed.body.gaps.length, 0);

    assert.deepEqual(reasons(await c.call('POST', '/api/v1/audit/search', { body: { from: iso(0), to: iso(60_000) } })), ['to:not_after_from']);
    assert.deepEqual(reasons(await c.call('POST', '/api/v1/audit/search', { body: { from: 'yesterday' } })), ['from:time_invalid']);
    assert.deepEqual(reasons(await c.call('POST', '/api/v1/audit/search', { body: { actions: ['DROP TABLE'] } })), ['actions.0:invalid_format']);
  });

  it('감사 이력을 읽지 못하면 503 audit_unavailable이다', async () => {
    await api.db.query('ALTER TABLE audit_log RENAME TO audit_log_hidden');
    try {
      const r = await c.call('POST', '/api/v1/audit/search', { body: {} });
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'audit_unavailable');
      assert.equal(r.body.retryable, true);
    } finally {
      await api.db.query('ALTER TABLE audit_log_hidden RENAME TO audit_log');
    }
  });
});
