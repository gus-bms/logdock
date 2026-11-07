// 알림 규칙과 사건 시험(계약 4.3·5.4·5.5절, Q12, TD-01·05·06·07·08). 임시 PostgreSQL에 마이그레이션을 적용하고 앱을 루프백 주소에
// 띄워 HTTP로 확인한다. 사건·메일 작업·평가 기록은 평가·발송 작업이 쓸 행을 DB에 직접 넣어 흉내 낸다. 합성 이름·주소만 쓴다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { hashPassword } from '../auth/password.js';
import type { MailConfig } from '../config.js';
import { encodeConnectionId } from '../connections/public-id.js';
import { type Api, Client, type EphemeralPostgres, type Reply, startApi, startPostgres } from '../test-support/harness.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';
const MAIL: MailConfig = { host: 'smtp.example.test', port: 465, security: 'tls', from: 'logdock@example.test', user: null, password: null, ca: null, redirectTo: null };
const RULE = {
  name: '결제 오류 급증',
  enabled: true,
  condition: { sources: { service_ids: [1] }, levels: ['ERROR'] },
  window_minutes: 5,
  threshold: 10,
  recipients: ['ops@example.test'],
};

describe('알림 규칙과 사건', () => {
  let pg: EphemeralPostgres;
  let api: Api;
  let c: Client;
  const one = async <T = any>(sql: string, values: unknown[] = []): Promise<T> => (await api.db.query(sql, values)).rows[0] as T;
  const all = async <T = any>(sql: string, values: unknown[] = []): Promise<T[]> => (await api.db.query(sql, values)).rows as T[];
  const create = (body: object, key = randomUUID(), client = c): Promise<Reply> =>
    client.call('POST', '/api/v1/alert-rules', { headers: { 'idempotency-key': key }, body });
  const rule = (over: object = {}) => create({ ...RULE, ...over });
  const patch = (id: number | string, body: object, client = c) => client.call('PATCH', `/api/v1/alert-rules/${id}`, { body });
  const reasons = (r: Reply) => (r.body.params.fields as { path: string; reason: string }[]).map((f) => `${f.path}:${f.reason}`).sort();
  const audits = () => all<{ action: string; changed_fields: string[] | null }>('SELECT action, changed_fields FROM audit_log ORDER BY id');
  /** 평가 작업이 연 사건을 흉내 낸다. */
  const incident = async (ruleId: number, ref: string, firedAgo = '1 minute', closed?: string) =>
    (
      await one<{ id: number }>(
        `INSERT INTO alert_incidents (public_ref, rule_id, condition_version, rule_name, condition, window_minutes, threshold,
                                      window_start, window_end, fired_at, matched_count, quality, closed_at, close_reason)
         VALUES ($1, $2, 1, '발화 때 이름', '{"sources": {"service_ids": [1]}, "levels": ["ERROR"]}', 5, 10,
                 now() - $3::interval - interval '5 minutes', now() - $3::interval, now() - $3::interval, 12, 'complete',
                 CASE WHEN $4::text IS NULL THEN NULL ELSE now() END, $4)
         RETURNING id`,
        [ref, ruleId, firedAgo, closed ?? null],
      )
    ).id;
  /** 발송 작업이 만든 메일 작업을 흉내 낸다. */
  const job = (incidentId: number, recipient: string, state: string, lastError: string | null = null) =>
    api.db.query(
      `INSERT INTO mail_jobs (kind, incident_id, recipient, message_id, state, attempts, accepted_at, last_error)
       VALUES ('alert', $1, $2, $3, $4, 1, CASE WHEN $4 = 'accepted' THEN now() END, $5)`,
      [incidentId, recipient, randomUUID() + '@logdock.example.test', state, lastError],
    );
  const jobStates = () => all<{ recipient: string; state: string; cancel_reason: string | null }>(
    'SELECT recipient, state, cancel_reason FROM mail_jobs ORDER BY id',
  );

  before(async () => {
    pg = await startPostgres();
    api = await startApi(pg, { alertRuleLimit: 4, mail: MAIL });
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
      `TRUNCATE services, servers, connections, connection_status, idempotency_keys, alert_rules, alert_rule_recipients,
                alert_incidents, alert_evaluations, mail_jobs, audit_log, audit_gaps RESTART IDENTITY CASCADE`,
    );
    await api.db.query(`INSERT INTO services (name) VALUES ('billing'), ('order-api')`);
    await api.db.query(`INSERT INTO servers (display_name) VALUES ('app-01')`);
  });

  it('만들면 감사에 남기고 같은 Idempotency-Key로 다시 보내도 하나만 만든다', async () => {
    const key = randomUUID();
    const r = await create(RULE, key);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.name, '결제 오류 급증');
    assert.equal(r.body.enabled, true);
    assert.equal(r.body.eval_state, 'normal');
    assert.equal(r.body.window_minutes, 5);
    assert.equal(r.body.threshold, 10);
    assert.equal(r.body.resolve_wait_minutes, null);
    assert.equal(r.body.recipient_count, 1);
    assert.deepEqual(r.body.references.services, [{ id: 1, name: 'billing', state: 'active' }]);
    assert.deepEqual(r.body.condition, {
      sources: { service_ids: [1], server_ids: [], environments: [], connection_ids: [] },
      levels: ['ERROR'],
      body: [],
      fields: [],
    });
    assert.deepEqual(r.body.warnings, []);
    assert.equal(r.body.last_delivery, null);
    assert.equal(r.body.final_failure_unacked, 0);
    assert.equal(r.body.version, 1);
    assert.deepEqual(await audits(), [{ action: 'alert_rule.create', changed_fields: null }]);

    const again = await create(RULE, key);
    assert.equal(again.status, 201);
    assert.equal(again.body.id, r.body.id);
    assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM alert_rules')).n, 1);
    assert.equal((await create({ ...RULE, threshold: 11 }, key)).body.code, 'idempotency_key_reused');
    assert.deepEqual(reasons(await c.call('POST', '/api/v1/alert-rules', { body: RULE })), ['Idempotency-Key:required']);
  });

  it('입력 규칙: 이름·구간·임계·수신 주소를 칸마다 보고, 필터가 없는 조건은 확인을 받는다', async () => {
    assert.deepEqual(reasons(await rule({ name: '', recipients: [] })), ['name:too_small', 'recipients:too_small']);
    assert.deepEqual(reasons(await rule({ name: '가'.repeat(101) })), ['name:too_big']);
    assert.deepEqual(reasons(await rule({ window_minutes: 0, threshold: 0 })), ['threshold:too_small', 'window_minutes:too_small']);
    assert.deepEqual(reasons(await rule({ window_minutes: 1441, resolve_wait_minutes: 1441 })), ['resolve_wait_minutes:too_big', 'window_minutes:too_big']);
    assert.deepEqual(reasons(await rule({ recipients: ['ops', 'A@example.test', 'a@example.test'] })), [
      'recipients.0:format_invalid',
      'recipients.2:duplicate',
    ]);
    assert.deepEqual(reasons(await rule({ recipients: Array.from({ length: 11 }, (_, i) => `u${i}@example.test`) })), ['recipients:too_many']);
    assert.deepEqual(reasons(await rule({ condition: { level: ['ERROR'] } })), ['condition:unrecognized_keys']);
    assert.deepEqual(reasons(await rule({ condition: { sources: { service_ids: [99] } } })), ['condition.sources.service_ids.0:not_found']);
    const { enabled: _enabled, ...noEnabled } = RULE;
    assert.deepEqual(reasons(await create(noEnabled)), ['enabled:invalid_type']);

    // 필터가 하나도 없으면 모든 로그를 센다. 경고를 본 뒤 확인하면 만든다(TD-05).
    assert.deepEqual(reasons(await rule({ condition: {} })), ['condition:no_filter_needs_confirm']);
    const all = await rule({ condition: {}, confirm_no_filter: true, recipients: [' ops@example.test '] });
    assert.equal(all.status, 201, JSON.stringify(all.body));
    assert.equal((await one<{ address: string }>('SELECT address FROM alert_rule_recipients')).address, 'ops@example.test');
  });

  it('같은 이름은 경고만 하고, 개수 상한은 꺼진 규칙도 세며 지운 규칙은 세지 않는다', async () => {
    assert.equal((await rule({ name: 'A' })).status, 201);
    assert.equal((await rule({ name: 'B', enabled: false })).status, 201);
    const dup = await rule({ name: 'a' });
    assert.equal(dup.status, 201);
    assert.deepEqual(dup.body.warnings, ['name_duplicate']);
    assert.equal((await rule({ name: 'C' })).status, 201);
    const full = await rule({ name: 'D' });
    assert.equal(full.status, 409);
    assert.equal(full.body.code, 'limit_reached');
    assert.deepEqual(full.body.params, { limit: 4 });
    assert.equal((await c.call('DELETE', '/api/v1/alert-rules/2')).status, 204);
    assert.equal((await rule({ name: 'D' })).status, 201);

    await api.db.query('TRUNCATE alert_rules, alert_rule_recipients, idempotency_keys RESTART IDENTITY CASCADE');
    const results = await Promise.all(['1', '2', '3', '4', '5', '6'].map((n) => rule({ name: `동시 ${n}` })));
    assert.equal(results.filter((x) => x.status === 201).length, 4);
    assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM alert_rules')).n, 4);
  });

  it('메일 설정이 없으면 켤 수 없고, 끈 채로는 만들고 고칠 수 있다', async () => {
    const noMail = await startApi(pg, { mail: null });
    try {
      const c2 = new Client(noMail.base);
      assert.equal((await c2.login(NAME, PASSWORD)).status, 200);
      const on = await create(RULE, randomUUID(), c2);
      assert.equal(on.status, 409);
      assert.equal(on.body.code, 'mail_not_configured');
      const off = await create({ ...RULE, enabled: false }, randomUUID(), c2);
      assert.equal(off.status, 201);
      assert.equal((await patch(off.body.id, { version: 1, enabled: true }, c2)).body.code, 'mail_not_configured');
      assert.equal((await patch(off.body.id, { version: 1, name: '이름만 고침' }, c2)).status, 200);
      assert.equal((await c2.call('GET', '/api/v1/alert-rules')).body.mail_configured, false);
    } finally {
      await noMail.close();
    }
  });

  it('조건을 고치면 정상으로 돌리고 열린 사건을 닫되 메일은 보내며, 이름·수신 주소만 고치면 상태를 지킨다', async () => {
    const id = (await rule({ recipients: ['ops@example.test', 'dev@example.test'] })).body.id;
    await api.db.query(`UPDATE alert_rules SET eval_state = 'firing', last_fired_at = now() WHERE id = $1`, [id]);
    const inc = await incident(id, 'inc-open');
    await job(inc, 'ops@example.test', 'queued');
    await job(inc, 'dev@example.test', 'retry_wait');
    assert.equal((await c.call('POST', `/api/v1/alert-rules/${id}/recipients/confirm`, { body: { address: 'ops@example.test' } })).status, 200);

    const renamed = await patch(id, { version: 1, name: '결제 오류' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.version, 2);
    assert.equal(renamed.body.eval_state, 'firing');
    assert.equal((await one('SELECT closed_at FROM alert_incidents')).closed_at, null);

    // 대소문자만 바꾼 주소는 같은 주소라 `받았음` 표시가 남고, 뺀 주소로 보내지 않은 메일만 취소한다(F-13).
    const moved = await patch(id, { version: 2, recipients: ['OPS@example.test', 'new@example.test'] });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.eval_state, 'firing');
    const recipients = (await c.call('GET', `/api/v1/alert-rules/${id}`)).body.recipients;
    assert.deepEqual(recipients.map((r: any) => r.address), ['ops@example.test', 'new@example.test']);
    assert.ok(recipients[0].confirmed_at);
    assert.deepEqual(await jobStates(), [
      { recipient: 'ops@example.test', state: 'queued', cancel_reason: null },
      { recipient: 'dev@example.test', state: 'cancelled', cancel_reason: 'recipient_removed' },
    ]);

    const raised = await patch(id, { version: 3, threshold: 20 });
    assert.equal(raised.body.eval_state, 'normal');
    assert.equal((await one('SELECT condition_version FROM alert_rules')).condition_version, 2);
    assert.equal((await one('SELECT close_reason FROM alert_incidents')).close_reason, 'condition_changed');
    assert.equal((await jobStates())[0].state, 'queued');

    const stale = await patch(id, { version: 3, threshold: 30 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'version_conflict');
    assert.equal(stale.body.params.current.version, 4);
    const same = await patch(id, { version: 4, threshold: 20, name: '결제 오류' });
    assert.equal(same.body.version, 4);
    assert.deepEqual(
      (await audits()).map((a) => [a.action, a.changed_fields]),
      [
        ['alert_rule.create', null],
        ['alert_rule.update', ['recipient_confirmed']],
        ['alert_rule.update', ['name']],
        ['alert_rule.update', ['recipients']],
        ['alert_rule.update', ['threshold']],
      ],
    );
  });

  it('끄면 열린 사건을 닫고 아직 보내지 않은 메일만 취소하며, 다시 켜면 정상에서 시작한다', async () => {
    const id = (await rule({ recipients: ['a@example.test', 'b@example.test', 'c@example.test', 'd@example.test', 'e@example.test'] })).body.id;
    await api.db.query(`UPDATE alert_rules SET eval_state = 'resolving', resolve_streak = 2 WHERE id = $1`, [id]);
    const inc = await incident(id, 'inc-open');
    for (const [r, s] of [['a', 'queued'], ['b', 'retry_wait'], ['c', 'sending'], ['d', 'unknown'], ['e', 'accepted']]) {
      await job(inc, `${r}@example.test`, s);
    }
    const off = await patch(id, { version: 1, enabled: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.enabled, false);
    assert.equal(off.body.eval_state, 'normal');
    assert.equal((await one('SELECT close_reason FROM alert_incidents')).close_reason, 'rule_disabled');
    assert.deepEqual((await jobStates()).map((j) => `${j.state}:${j.cancel_reason}`), [
      'cancelled:rule_disabled',
      'cancelled:rule_disabled',
      'sending:null',
      'unknown:null',
      'accepted:null',
    ]);
    const on = await patch(id, { version: 2, enabled: true });
    assert.equal(on.body.enabled, true);
    assert.equal(on.body.eval_state, 'normal');
    assert.deepEqual((await audits()).map((a) => a.action), ['alert_rule.create', 'alert_rule.disable', 'alert_rule.enable']);
  });

  it('지우면 목록과 상세에서 빠지고 열린 사건을 닫으며, 사건은 남아 규칙이 지워졌다고 알린다', async () => {
    const id = (await rule()).body.id;
    const inc = await incident(id, 'inc-open');
    await job(inc, 'ops@example.test', 'queued');
    assert.equal((await c.call('DELETE', `/api/v1/alert-rules/${id}`)).status, 204);
    assert.equal((await c.call('GET', `/api/v1/alert-rules/${id}`)).status, 404);
    assert.equal((await c.call('GET', '/api/v1/alert-rules')).body.total, 0);
    assert.equal((await one('SELECT close_reason FROM alert_incidents')).close_reason, 'rule_deleted');
    assert.deepEqual(await jobStates(), [{ recipient: 'ops@example.test', state: 'cancelled', cancel_reason: 'rule_deleted' }]);
    const kept = await c.call('GET', '/api/v1/incidents/inc-open');
    assert.equal(kept.status, 200);
    assert.equal(kept.body.rule.status, 'deleted');
    assert.equal((await c.call('DELETE', `/api/v1/alert-rules/${id}`)).status, 404);
    assert.deepEqual((await audits()).map((a) => a.action), ['alert_rule.create', 'alert_rule.delete']);
  });

  it('받았음 표시는 주소마다 처음 한 번만 남기고 규칙 버전을 올리지 않는다', async () => {
    const id = (await rule()).body.id;
    const first = await c.call('POST', `/api/v1/alert-rules/${id}/recipients/confirm`, { body: { address: ' OPS@EXAMPLE.TEST ' } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const at = first.body.recipients[0].confirmed_at;
    assert.match(at, /Z$/);
    const again = await c.call('POST', `/api/v1/alert-rules/${id}/recipients/confirm`, { body: { address: 'ops@example.test' } });
    assert.equal(again.body.recipients[0].confirmed_at, at);
    assert.equal((await c.call('POST', `/api/v1/alert-rules/${id}/recipients/confirm`, { body: { address: 'nobody@example.test' } })).status, 404);
    assert.equal((await c.call('GET', `/api/v1/alert-rules/${id}`)).body.version, 1);
    assert.deepEqual((await audits()).map((a) => a.changed_fields), [null, ['recipient_confirmed']]);
  });

  it('감사를 쓸 수 없으면 만들기·수정·삭제·받았음 표시를 하지 않고 보류한다', async () => {
    const id = (await rule()).body.id;
    await api.db.query(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit storage unavailable'; END $$`);
    await api.db.query('CREATE TRIGGER fail_audit BEFORE INSERT OR UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()');
    try {
      assert.equal((await rule({ name: '새 규칙' })).body.code, 'held_audit_unavailable');
      assert.equal((await patch(id, { version: 1, enabled: false })).body.code, 'held_audit_unavailable');
      assert.equal((await c.call('DELETE', `/api/v1/alert-rules/${id}`)).body.code, 'held_audit_unavailable');
      const confirm = await c.call('POST', `/api/v1/alert-rules/${id}/recipients/confirm`, { body: { address: 'ops@example.test' } });
      assert.equal(confirm.body.code, 'held_audit_unavailable');
    } finally {
      await api.db.query('DROP TRIGGER fail_audit ON audit_log');
      await api.db.query('DROP FUNCTION fail_audit()');
    }
    const row = await one('SELECT enabled, version, deleted_at FROM alert_rules');
    assert.deepEqual(row, { enabled: true, version: 1, deleted_at: null });
    assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM alert_rules')).n, 1);
    assert.equal((await one('SELECT confirmed_at FROM alert_rule_recipients')).confirmed_at, null);
  });

  it('목록은 이름순으로 나눠 주고 켬/끔·평가 상태·확인하지 않은 최종 실패로 거르며 마지막 전달 결과를 준다', async () => {
    const beta = (await rule({ name: 'beta' })).body.id;
    await rule({ name: 'Alpha', enabled: false });
    const gamma = (await rule({ name: 'gamma' })).body.id;
    await api.db.query(`UPDATE alert_rules SET eval_state = 'firing' WHERE id = $1`, [gamma]);
    const inc = await incident(beta, 'inc-beta');
    await job(inc, 'ops@example.test', 'accepted');
    await job(inc, 'dev@example.test', 'failed', 'mail_recipient_rejected');

    const first = await c.call('GET', '/api/v1/alert-rules?limit=2');
    assert.deepEqual(first.body.items.map((x: any) => x.name), ['Alpha', 'beta']);
    assert.equal(first.body.total, 3);
    assert.equal(first.body.limit, 4);
    assert.equal(first.body.mail_configured, true);
    const second = await c.call('GET', `/api/v1/alert-rules?limit=2&cursor=${first.body.next_cursor}`);
    assert.deepEqual(second.body.items.map((x: any) => x.name), ['gamma']);
    assert.equal(second.body.next_cursor, null);

    const names = async (q: string) => (await c.call('GET', `/api/v1/alert-rules?${q}`)).body.items.map((x: any) => x.name);
    assert.deepEqual(await names('enabled=false'), ['Alpha']);
    assert.deepEqual(await names('eval_state=firing'), ['gamma']);
    assert.deepEqual(await names('final_failure_unacked=true'), ['beta']);

    const b = first.body.items[1];
    assert.equal(b.final_failure_unacked, 1);
    assert.equal(b.last_delivery.incident_id, 'inc-beta');
    assert.deepEqual(
      { accepted: b.last_delivery.accepted, pending: b.last_delivery.pending, failed: b.last_delivery.failed, cancelled: b.last_delivery.cancelled },
      { accepted: 1, pending: 0, failed: 1, cancelled: 0 },
    );
    assert.deepEqual((await c.call('GET', '/api/v1/alert-rules?eval_state=bad')).body.params.fields.map((f: any) => f.path), ['eval_state']);
  });

  it('상세는 해소 대기 진행·미평가 구간·관측되지 않는 대상 연결·최근 사건을 준다', async () => {
    const conn = (service: number, path: string, state: string) =>
      one<{ id: number }>(
        `INSERT INTO connections (service_id, server_id, target_type, target_path, format_type, max_event_bytes, management_state, archived_at)
         VALUES ($1, 1, 'file', $2, 'text', 1024, $3, ${state === 'archived' ? 'now()' : 'NULL'}) RETURNING id`,
        [service, path, state],
      );
    const status = async (id: number, ago: string, states: string[]) => {
      await api.db.query(`INSERT INTO ingest_keys (key_id, connection_id, secret_hash, slot, issued_as) VALUES ($1, $2, '\\x00', 1, 'register')`, [
        `k${id}`,
        id,
      ]);
      await api.db.query(
        `INSERT INTO connection_status (connection_id, last_report_at, report, agent_instance_id, agent_version, key_id, observed_states)
         VALUES ($1, now() - $2::interval, '{}', 'agent-1', '0.1.0', $3, $4)`,
        [id, ago, `k${id}`, states],
      );
    };
    const seen = await conn(1, '/var/app/billing/app.log', 'active');
    await status(seen.id, '10 seconds', ['collecting']);
    const quiet = await conn(1, '/var/app/billing/sync.log', 'active');
    await status(quiet.id, '1 hour', ['collecting']); // 보고가 끊겨 `stale`
    await conn(1, '/var/app/billing/new.log', 'pending'); // 첫 보고 전이라 관측 판단에서 뺀다
    await conn(1, '/var/app/billing/old.log', 'archived'); // 보관된 연결은 대상이 아니다
    await conn(2, '/var/app/order/app.log', 'active'); // 다른 서비스

    const id = (await rule({ resolve_wait_minutes: 3 })).body.id;
    await api.db.query(`UPDATE alert_rules SET eval_state = 'resolving', resolve_streak = 2 WHERE id = $1`, [id]);
    await api.db.query(
      `INSERT INTO alert_evaluations (rule_id, window_end, window_start, condition_version, status, error_code)
       VALUES ($1, now() - interval '2 minutes', now() - interval '7 minutes', 1, 'unevaluable', 'search_timeout'),
              ($1, now() - interval '1 minute', now() - interval '6 minutes', 1, 'below', NULL)`,
      [id],
    );
    await incident(id, 'inc-1');

    const d = await c.call('GET', `/api/v1/alert-rules/${id}`);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(d.body.resolve, { streak: 2, needed: 3 });
    assert.deepEqual(d.body.unevaluated_windows.map((w: any) => [w.status, w.error_code]), [['unevaluable', 'search_timeout']]);
    assert.equal(d.body.targets.total, 3);
    assert.deepEqual(d.body.targets.unobserved.map((t: any) => [t.id, t.observation]), [[encodeConnectionId(quiet.id), ['stale']]]);
    assert.deepEqual(d.body.recipients, [{ address: 'ops@example.test', confirmed_at: null }]);
    assert.deepEqual(d.body.recent_incidents.map((i: any) => i.id), ['inc-1']);
    assert.equal((await c.call('GET', '/api/v1/alert-rules/99')).status, 404);
  });

  it('사건 이력은 최신순으로 나눠 주고, 상세는 발화 때 조건과 수신자별 전달 상태를 주며 최종 실패를 확인한다', async () => {
    const id = (await rule()).body.id;
    await incident(id, 'inc-old', '3 hours', 'resolved');
    const inc = await incident(id, 'inc-new', '1 hour');
    await job(inc, 'ops@example.test', 'accepted');
    await job(inc, 'dev@example.test', 'failed', 'mail_recipient_rejected');

    const page1 = await c.call('GET', `/api/v1/alert-rules/${id}/incidents?limit=1`);
    assert.deepEqual(page1.body.items.map((i: any) => i.id), ['inc-new']);
    const page2 = await c.call('GET', `/api/v1/alert-rules/${id}/incidents?limit=1&cursor=${page1.body.next_cursor}`);
    assert.deepEqual(page2.body.items.map((i: any) => [i.id, i.close_reason]), [['inc-old', 'resolved']]);
    assert.equal(page2.body.next_cursor, null);

    const d = await c.call('GET', '/api/v1/incidents/inc-new');
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(d.body.rule, { id, name: '결제 오류 급증', status: 'same' });
    assert.equal(d.body.at_fire.rule_name, '발화 때 이름');
    assert.deepEqual(d.body.at_fire.references.services, [{ id: 1, name: 'billing', state: 'active' }]);
    assert.equal(d.body.matched_count, 12);
    assert.deepEqual(d.body.deliveries.map((x: any) => [x.recipient, x.state, x.last_error]), [
      ['dev@example.test', 'failed', 'mail_recipient_rejected'],
      ['ops@example.test', 'accepted', null],
    ]);
    assert.equal(d.body.delivery.failed_unacked, 1);

    assert.deepEqual((await c.call('POST', '/api/v1/incidents/inc-new/ack-final-failures')).body, { id: 'inc-new', acknowledged: 1 });
    assert.equal((await c.call('POST', '/api/v1/incidents/inc-new/ack-final-failures')).body.acknowledged, 0);
    assert.equal((await c.call('GET', '/api/v1/alert-rules')).body.items[0].final_failure_unacked, 0);

    await patch(id, { version: 1, threshold: 50 });
    assert.equal((await c.call('GET', '/api/v1/incidents/inc-new')).body.rule.status, 'changed');
    assert.equal((await c.call('GET', '/api/v1/incidents/inc-none')).status, 404);
    assert.equal((await c.call('GET', '/api/v1/incidents/bad.ref')).status, 404);
  });
});
