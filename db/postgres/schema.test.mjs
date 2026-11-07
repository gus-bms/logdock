// 관리 DB 스키마(migrations)의 제약이 실제로 막는지 임시 PostgreSQL에서 확인한다.
// API 계약 초안 3.6절의 "제약 동작은 구현 때 시험한다"에 해당한다. 합성 데이터만 쓴다.
//
// 시험마다 한 트랜잭션 안에서 돌리고 되돌린다(ROLLBACK). 막혀야 하는 문장은 맨 끝에 두어,
// 앞 문장이 엉뚱하게 실패하면 기대한 제약 이름과 맞지 않아 시험이 실패하게 한다.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { startEphemeralPostgres } from './ephemeral.mjs';

let pg;
before(async () => {
  pg = await startEphemeralPostgres();
});
after(async () => {
  await pg?.stop();
});

// 계정·서비스·서버 하나씩. 식별 열 값은 되돌려도 다시 쓰이지 않으므로 \gset으로 받아 쓴다.
const FIXTURE = `SET search_path = logdock;
INSERT INTO accounts (name, password_hash) VALUES ('admin', 'x') RETURNING id AS acc \\gset
INSERT INTO services (name) VALUES ('order-api') RETURNING id AS svc \\gset
INSERT INTO servers (display_name) VALUES ('app-01') RETURNING id AS srv \\gset
`;

const run = (body) => pg.run(`BEGIN;\n${FIXTURE}${body}\nROLLBACK;\n`);

async function ok(body) {
  const r = await run(body);
  assert.ok(r.ok, r.stderr);
  return r.stdout.split('\n').filter((l) => l !== '');
}

async function rejects(body, constraint) {
  const r = await run(body);
  assert.equal(r.ok, false, `expected ${constraint} to reject:\n${body}`);
  assert.match(r.stderr, new RegExp(`"${constraint}"`), r.stderr);
}

// 파일 연결 하나를 넣는 문장. cols·vals로 대상을 바꾼다.
const conn = (cols, vals, server = ':srv') =>
  `INSERT INTO connections (service_id, server_id, ${cols}, format_type, max_event_bytes) ` +
  `VALUES (:svc, ${server}, ${vals}, 'text', 65536)`;
const fileConn = (path, server) => conn('target_type, target_path', `'file', '${path}'`, server);

test('임시 DB는 TCP 포트를 열지 않고 소켓으로만 접속한다(DB 안전 규칙 예외 조건)', async () => {
  const rows = await ok(`SELECT current_setting('listen_addresses') = '';
SELECT inet_server_addr() IS NULL;`);
  assert.deepEqual(rows, ['t', 't']);
});

test('스키마는 테이블 31개와 도메인 2개다', async () => {
  const rows = await ok(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'logdock' AND table_type = 'BASE TABLE';
SELECT count(*) FROM information_schema.domains WHERE domain_schema = 'logdock';`);
  assert.deepEqual(rows, ['31', '2']);
});

test('DB는 builtin C.UTF-8이라 lower()가 한글 밖 문자도 소문자로 바꾼다', async () => {
  const rows = await ok(`SELECT datlocprovider::text || ' ' || datlocale FROM pg_database WHERE datname = current_database();
SELECT lower('ÀÉ ÖÜ');`);
  assert.deepEqual(rows, ['b C.UTF-8', 'àé öü']);
});

test('이름은 앞뒤 공백·빈 값·제어 문자·NFC가 아닌 값을 막는다', async () => {
  for (const bad of [`' order'`, `'order '`, `''`, `E'or\\tder'`, `U&'cafe\\0301'`]) {
    await rejects(`INSERT INTO services (name) VALUES (${bad});`, 'name_text_check');
  }
  await ok(`INSERT INTO services (name) VALUES ('주문 API'), (U&'caf\\00E9');`);
});

test('서비스·서버·계정 이름은 대소문자를 가리지 않고 유일하다', async () => {
  await rejects(`INSERT INTO services (name) VALUES ('ORDER-API');`, 'services_name_uq');
  await rejects(`INSERT INTO services (name) VALUES ('éclair'), ('Éclair');`, 'services_name_uq');
  await rejects(`INSERT INTO servers (display_name) VALUES ('APP-01');`, 'servers_display_name_uq');
  await rejects(`INSERT INTO accounts (name, password_hash) VALUES ('Admin', 'y');`, 'accounts_name_uq');
});

test('수집 대상 규칙(계약 2.8절)', async () => {
  for (const [cols, vals] of [
    ['target_type, target_path', `'file', 'var/log/app.log'`], // 절대 경로가 아님
    ['target_type, target_path', `'file', '/var/log/*.log'`], // 파일 하나에 와일드카드
    ['target_type, target_path', `'file_pattern', '/var/*/app.log'`], // 폴더에 와일드카드
    ['target_type, target_path', `'file_pattern', '/var/log/app.log'`], // 와일드카드 없는 규칙
    ['target_type, journald_kind', `'journald', 'container'`], // 이름 없음
    ['target_type, journald_kind, journald_name', `'journald', 'host', 'all'`],
    ['target_type, target_path, journald_kind, journald_name', `'journald', '/var/log/x', 'unit', 'x.service'`],
    ['target_type, journald_kind, journald_name', `'journald', 'container', E'we\\nb'`],
  ]) {
    await rejects(`${conn(cols, vals)};`, 'connections_target');
  }
  const rows = await ok(`${conn('target_type, target_path', `'file_pattern', '/var/log/app-*.log'`)} RETURNING target_identity;
${conn('target_type, journald_kind, journald_name', `'journald', 'container', 'web'`)} RETURNING target_identity;`);
  assert.deepEqual(rows, ['path:/var/log/app-*.log', 'journald:container:web']);
});

test('같은 서버·같은 대상의 보관되지 않은 연결은 하나다(Q07-06)', async () => {
  await rejects(`${fileConn('/var/log/app.log')};\n${fileConn('/var/log/app.log')};`, 'connections_same_target_uq');
  await rejects(
    `${conn('target_type, journald_kind, journald_name', `'journald', 'unit', 'a.service'`)};
${conn('target_type, journald_kind, journald_name', `'journald', 'unit', 'a.service'`)};`,
    'connections_same_target_uq',
  );
  // 보관한 연결은 세지 않고, 서버 표시명이 없는 연결은 여기서 막지 않는다(2.7절 관측으로 확인)
  await ok(`${fileConn('/var/log/app.log')} RETURNING id AS c1 \\gset
UPDATE connections SET management_state = 'archived', archived_at = now() WHERE id = :c1;
${fileConn('/var/log/app.log')};
${fileConn('/var/log/app.log', 'NULL')};
${fileConn('/var/log/app.log', 'NULL')};`);
});

test('여러 줄 형식에만 새 이벤트 시작 규칙이 있다', async () => {
  await rejects(
    `INSERT INTO connections (service_id, target_type, target_path, format_type, max_event_bytes) VALUES (:svc, 'file', '/a.log', 'multiline', 1);`,
    'connections_event_start',
  );
  await rejects(
    `INSERT INTO connections (service_id, target_type, target_path, format_type, event_start_pattern, max_event_bytes) VALUES (:svc, 'file', '/a.log', 'text', '^x', 1);`,
    'connections_event_start',
  );
});

test('연결마다 유효 키는 둘까지다(Q10-07, PT-10)', async () => {
  const key = (id, slot, as) =>
    `INSERT INTO ingest_keys (key_id, connection_id, secret_hash, slot, issued_as) VALUES ('${id}', :c, decode('00', 'hex'), ${slot}, '${as}');`;
  const setup = `${fileConn('/var/log/app.log')} RETURNING id AS c \\gset
${key('k1', 1, 'register')}
${key('k2', 2, 'issue')}`;
  await ok(setup);
  await rejects(`${setup}\n${key('k3', 1, 'rotate')}`, 'ingest_keys_valid_slot_uq');
  await rejects(`${setup}\n${key('k3', 3, 'rotate')}`, 'ingest_keys_slot');
  await rejects(`${setup}\nUPDATE ingest_keys SET state = 'revoked' WHERE key_id = 'k1';`, 'ingest_keys_slot');
  await rejects(
    `${setup}\nUPDATE ingest_keys SET state = 'revoke_requested', slot = NULL WHERE key_id = 'k1';`,
    'ingest_keys_times',
  );
  // 폐기한 키는 자리를 비우고, 빈 자리에 새 키가 들어간다
  await ok(`${setup}
UPDATE ingest_keys SET state = 'revoked', slot = NULL, revoked_at = now() WHERE key_id = 'k1';
${key('k3', 1, 'rotate')}`);
});

test('한 규칙의 열린 사건은 하나이고 회차마다 사건은 하나다(TD-13·14)', async () => {
  const rule = `INSERT INTO alert_rules (owner_account_id, name, enabled, condition, window_minutes, threshold) VALUES (:acc, 'errors', true, '{}', 5, 10) RETURNING id AS r \\gset`;
  const incident = (ref, end, closed = false) =>
    `INSERT INTO alert_incidents (public_ref, rule_id, condition_version, rule_name, condition, window_minutes, threshold, ` +
    `window_start, window_end, fired_at, matched_count, quality${closed ? ', closed_at, close_reason' : ''}) VALUES ('${ref}', :r, 1, ` +
    `'errors', '{}', 5, 10, '${end}'::timestamptz - interval '5 minutes', '${end}', '${end}', 12, 'complete'${closed ? `, now(), 'resolved'` : ''});`;
  await rejects(
    `${rule}\n${incident('i1', '2026-11-06 01:00Z')}\n${incident('i2', '2026-11-06 01:05Z')}`,
    'alert_incidents_open_uq',
  );
  await ok(`${rule}\n${incident('i1', '2026-11-06 01:00Z', true)}\n${incident('i2', '2026-11-06 01:05Z')}`);
  await rejects(
    `${rule}\n${incident('i1', '2026-11-06 01:00Z', true)}\n${incident('i2', '2026-11-06 01:00Z')}`,
    'alert_incidents_round_uq',
  );
  await rejects(
    `${rule}\n${incident('i1', '2026-11-06 01:00Z')}\nUPDATE alert_incidents SET closed_at = now();`,
    'alert_incidents_close',
  );
});

test('알림 규칙의 이름 길이·해소 대기·삭제 상태', async () => {
  const rule = (extra = '', vals = '') =>
    `INSERT INTO alert_rules (owner_account_id, name, enabled, condition, window_minutes, threshold${extra}) VALUES (:acc, 'errors', true, '{}', 5, 10${vals});`;
  await rejects(rule().replace(`'errors'`, `repeat('a', 101)`), 'alert_rules_name');
  await rejects(rule(', eval_state', `, 'resolving'`), 'alert_rules_resolve_streak');
  await rejects(rule(', deleted_at', ', now()'), 'alert_rules_deleted');
  await ok(rule(', eval_state, resolve_streak', `, 'resolving', 1`));
});

test('메일 작업은 사건마다 받는 주소가 대소문자를 가리지 않고 하나다', async () => {
  const setup = `INSERT INTO alert_rules (owner_account_id, name, enabled, condition, window_minutes, threshold) VALUES (:acc, 'errors', true, '{}', 5, 10) RETURNING id AS r \\gset
INSERT INTO alert_incidents (public_ref, rule_id, condition_version, rule_name, condition, window_minutes, threshold, window_start, window_end, fired_at, matched_count, quality)
VALUES ('i1', :r, 1, 'errors', '{}', 5, 10, now() - interval '5 minutes', now(), now(), 12, 'complete') RETURNING id AS inc \\gset`;
  const job = (msg, to, extra = '', vals = '') =>
    `INSERT INTO mail_jobs (kind, incident_id, recipient, message_id${extra}) VALUES ('alert', :inc, '${to}', '${msg}'${vals});`;
  await rejects(`${setup}\n${job('m1', 'ops@example.com')}\n${job('m2', 'Ops@Example.com')}`, 'mail_jobs_incident_recipient_uq');
  await rejects(`${setup}\n${job('m1', 'ops@example.com', ', state', `, 'accepted'`)}`, 'mail_jobs_accepted');
  await rejects(`${setup}\n${job('m1', 'no-at-sign')}`, 'mail_address_check');
  await rejects(
    `INSERT INTO mail_jobs (kind, recipient, message_id) VALUES ('alert', 'ops@example.com', 'm1');`,
    'mail_jobs_kind',
  );
});

test('세션 폐기에는 정한 사유가 함께 있어야 한다', async () => {
  const session = (cols, vals) =>
    `INSERT INTO sessions (id_hash, account_id, csrf_token${cols}) VALUES (decode('01', 'hex'), :acc, decode(repeat('ab', 32), 'hex')${vals});`;
  await rejects(session(', revoked_at', ', now()'), 'sessions_revoke');
  await rejects(session(', revoked_at, revoke_reason', `, now(), 'expired'`), 'sessions_revoke');
  await ok(session(', revoked_at, revoke_reason', `, now(), 'logout'`));
});

test('세션마다 32바이트 CSRF 토큰이 있어야 한다(0002)', async () => {
  await rejects(`INSERT INTO sessions (id_hash, account_id) VALUES (decode('01', 'hex'), :acc);`, 'csrf_token');
  await rejects(
    `INSERT INTO sessions (id_hash, account_id, csrf_token) VALUES (decode('01', 'hex'), :acc, decode('abcd', 'hex'));`,
    'sessions_csrf_token',
  );
});

test('시도 제한 기록의 연속 실패 수는 0 이상이고 처음에는 잠기지 않았다(0003)', async () => {
  const rows = await ok(`INSERT INTO login_throttle (key_hash) VALUES (decode('01', 'hex'))
  RETURNING consecutive_failures, locked_at IS NULL;`);
  assert.deepEqual(rows, ['0|t']);
  await rejects(
    `INSERT INTO login_throttle (key_hash, consecutive_failures) VALUES (decode('02', 'hex'), -1);`,
    'login_throttle_consecutive',
  );
});

test('한 행 테이블은 id 1 하나만 받는다', async () => {
  await rejects(`INSERT INTO ingest_watermark (id, searchable_through) VALUES (2, now());`, 'ingest_watermark_single');
  await rejects(
    `INSERT INTO mail_status DEFAULT VALUES;\nINSERT INTO mail_status DEFAULT VALUES;`,
    'mail_status_pkey',
  );
  await ok(`INSERT INTO ingest_watermark (searchable_through) VALUES (now()) ON CONFLICT DO NOTHING;
INSERT INTO ingest_watermark (searchable_through) VALUES (now()) ON CONFLICT DO NOTHING;`);
});

test('열린 운영 일과 배너는 종류마다 하나다', async () => {
  await rejects(
    `INSERT INTO ops_episodes (kind, started_at) VALUES ('disk_warning', now());\nINSERT INTO ops_episodes (kind, started_at) VALUES ('disk_warning', now());`,
    'ops_episodes_open_uq',
  );
  await rejects(`INSERT INTO ops_episodes (kind, started_at) VALUES ('connection_unobserved', now());`, 'ops_episodes_connection');
  await rejects(
    `INSERT INTO notices (kind) VALUES ('disk_warning');\nINSERT INTO notices (kind) VALUES ('disk_warning');`,
    'notices_open_uq',
  );
  await ok(`INSERT INTO notices (kind, cleared_at) VALUES ('disk_warning', now());\nINSERT INTO notices (kind) VALUES ('disk_warning');`);
});

test('저장 검색의 시간 범위와 이름', async () => {
  const search = (name, mode, range) =>
    `INSERT INTO saved_searches (owner_account_id, name, condition, time_mode, time_range, time_basis) VALUES (:acc, '${name}', '{}', '${mode}', '${range}', 'occurred');`;
  await rejects(search('s1', 'relative', '{"from": "x"}'), 'saved_searches_time');
  await rejects(search('s1', 'absolute', '{"from": "x"}'), 'saved_searches_time');
  await rejects(`${search('errors', 'relative', '{"last": "PT15M"}')}\n${search('Errors', 'relative', '{"last": "PT1H"}')}`, 'saved_searches_name_uq');
});

test('감사 기록의 동작 이름은 영역.동작 꼴이다', async () => {
  await rejects(
    `INSERT INTO audit_log (actor_type, action, result) VALUES ('shared_account', 'Login', 'success');`,
    'audit_log_action',
  );
  await ok(`INSERT INTO audit_log (actor_type, account_id, action, result) VALUES ('shared_account', :acc, 'auth.login', 'success');`);
});
