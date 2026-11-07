// 검색 시험(계약 4.2절, SD-09·SD-12~SD-22·SD-26~SD-29·SD-32, 3.3절). 중앙 서버 ClickHouse의 시험 전용 DB에 실행마다 새 표를
// 만들어 합성 로그를 넣고, 임시 PostgreSQL과 앱을 띄워 HTTP로 확인한다. `LOGDOCK_TEST_CLICKHOUSE=1`일 때만 돌고 측정 중에는
// 건너뛴다(test-support/clickhouse.ts). 합성 이름·본문만 쓴다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { hashPassword } from '../auth/password.js';
import { DEFAULTS } from '../config.js';
import { encodeConnectionId } from '../connections/public-id.js';
import { type Api, Client, type EphemeralPostgres, type Reply, startApi, startPostgres } from '../test-support/harness.js';
import { startTestClickHouse, type TestClickHouse } from '../test-support/clickhouse.js';
import { eventRef } from './rows.js';
import { chOf } from './run-time.js';

const NAME = 'admin';
const PASSWORD = 'correct horse battery staple';

describe('검색(중앙 시험 DB)', () => {
  let tch: TestClickHouse | undefined;
  let skipReason = '';
  /** 시험 DB를 쓸 수 없으면(켜지 않음·측정 중·접속 불가) 건너뛴다. */
  const live = (name: string, fn: () => Promise<void>) =>
    it(name, async (t) => {
      if (!tch) return t.skip(skipReason);
      await fn();
    });
  let pg: EphemeralPostgres;
  let api: Api;
  let c: Client;
  const now = BigInt(Date.now()) * 1000n;
  const T = ((now - 30n * 60_000_000n) / 1_000_000n) * 1_000_000n; // 30분 전, 초 단위
  const at = (sec: number, us = 0n) => chOf(T + BigInt(sec) * 1_000_000n + us);

  type Row = Record<string, unknown> & { seq: number };
  const row = (o: Row): Record<string, unknown> => {
    const t = at(o.seq);
    return {
      connection_id: 1, generation: 1, kind: 'event', service_id: 1, server_id: 1, environment: '운영',
      stream_type: 'file', stream_id: 'f1', stream_label: '/var/app/billing/app.log', stream_offset: null, journald_cursor: '',
      received_at: t, observed_at: t, occurred_at: t, ref_time: t, ref_time_source: 'body', time_flags: 0,
      level: 'ERROR', level_raw: 'error', body: `line ${o.seq}`, body_unescaped: '', body_is_base64: false,
      parse_status: 'ok', parse_rule_version: 1, fields: {}, field_paths: [], fields_truncated: false,
      reject_reason: '', reject_limit_bytes: null, boundary_kind: '', boundary_detail: '',
      ...o,
    };
  };
  const c2 = (o: Row) => row({ connection_id: 2, service_id: 2, server_id: null, environment: '', stream_id: 'j1', stream_type: 'journald', level: 'WARN', level_raw: 'warning', ...o });
  const http = (status: unknown) => ({ fields: { http: { status } }, field_paths: ['http', 'http.status'] });
  const T2 = at(100);

  const search = (body: object, client = c): Promise<Reply> =>
    client.call('POST', '/api/v1/search', { body: { run_id: randomUUID(), time: { mode: 'relative', last: 'PT1H', basis: 'occurred' }, ...body } });
  const seqs = (r: Reply) => (r.body.rows as { event_ref: string }[]).map((x) => Number(Buffer.from(x.event_ref, 'base64url').toString().split('.')[3]));
  const field = (path: string, op: string, value?: unknown) => ({ condition: { fields: [{ path, op, ...(value === undefined ? {} : { value }) }] } });

  before(async () => {
    const prepared = await startTestClickHouse();
    if (typeof prepared === 'string') {
      skipReason = prepared;
      return;
    }
    tch = prepared;
    pg = await startPostgres();
    api = await startApi(pg, { clickhouse: tch!.config, displayTimezone: 'Asia/Seoul', searchRun: { ...DEFAULTS.searchRun } });
    await api.db.query('INSERT INTO accounts (name, password_hash) VALUES ($1, $2)', [NAME, await hashPassword(PASSWORD)]);
    await api.db.query(`INSERT INTO services (name) VALUES ('billing'), ('orders')`);
    await api.db.query(`INSERT INTO servers (display_name) VALUES ('web-1')`);
    await api.db.query(
      `INSERT INTO connections (service_id, server_id, environment, target_type, target_path, format_type, max_event_bytes)
       VALUES (1, 1, '운영', 'file', '/var/app/billing/app.log', 'json', 1024), (2, NULL, NULL, 'file', '/var/app/orders/app.log', 'text', 1024)`,
    );
    await api.db.query('INSERT INTO ingest_watermark (searchable_through) VALUES (now())');
    await api.db.query(
      `INSERT INTO deletion_blocks (connection_id, ref_time_from, ref_time_to) VALUES (1, $1::timestamptz, $2::timestamptz)`,
      [at(43).replace(' ', 'T') + 'Z', at(45).replace(' ', 'T') + 'Z'],
    );
    const rows = [
      row({ seq: 1, ...http(500) }),
      row({ seq: 2, ...http('500') }),
      row({ seq: 3, ...http(500.5) }),
      row({ seq: 4, ...http('abc') }),
      row({ seq: 5, ...http(null) }),
      row({ seq: 6, parse_status: 'failed' }),
      row({ seq: 7, parse_status: 'none' }),
      row({ seq: 8, parse_status: 'partial', fields: { other: 1 }, field_paths: ['other'] }),
      row({ seq: 9, fields_truncated: true, fields: { x: 1 }, field_paths: ['x'] }),
      row({ seq: 10, fields: { x: 1 }, field_paths: ['x'] }),
      row({ seq: 11, fields: { user: { id: 9007199254740993n } }, field_paths: ['user', 'user.id'] }),
      row({ seq: 12, fields: { user: { id: 9007199254740992n } }, field_paths: ['user', 'user.id'] }),
      row({ seq: 13, fields: { ok: true }, field_paths: ['ok'] }),
      row({ seq: 14, fields: { ok: 'true' }, field_paths: ['ok'] }),
      row({ seq: 15, level: 'UNKNOWN', level_raw: '' }),
      row({ seq: 16, body: 'Payment TIMEOUT at gateway' }),
      row({ seq: 17, body: '{"msg":"\\uacb0\\uc81c 지연"}', body_unescaped: '{"msg":"결제 지연"}' }),
      row({ seq: 18, body: 'progress 100%_done' }),
      row({ seq: 19, body: 'health check ok', level: 'INFO', level_raw: 'info' }),
      c2({ seq: 20 }),
      c2({ seq: 21 }),
      ...[30, 31, 32, 33, 34].map((seq) => c2({ seq, ref_time: T2, received_at: T2, observed_at: T2, occurred_at: T2 })),
      row({ seq: 40, kind: 'rejected', body: '', reject_reason: 'event_too_large', reject_limit_bytes: 1024 }),
      row({ seq: 41, received_at: chOf(now + 5n * 60_000_000n) }),
      row({ seq: 42, received_at: chOf(now - 7n * 30n * 24n * 3_600_000_000n) }),
      row({ seq: 43 }),
      row({ seq: 44 }),
      // 검색 범위(최근 1시간) 밖: 상세·필드 이름 후보 시험용.
      row({ seq: 0, kind: 'boundary', body: '', boundary_kind: 'initial_tail' }),
      row({ seq: 50, ref_time: at(-7200), received_at: at(-7200), body: 'Error: boom\n    at handler (app.js:10)\n    at main (app.js:2)' }),
      row({ seq: 51, ref_time: at(-7200), received_at: at(-7200), body: 'failed', fields: { err: { stack: 'Trace: x\n  at y' } }, field_paths: ['err', 'err.stack'] }),
    ];
    // 2^53을 넘는 정수가 JSON.stringify에서 깎이지 않게 직접 쓴다.
    const body = rows.map((r) => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? `@@${v}@@` : v)).replace(/"@@(\d+)@@"/g, '$1'));
    await tch!.ch.exec(`INSERT INTO ${tch!.ch.logs} FORMAT JSONEachRow\n${body.join('\n')}`, {
      settings: { input_format_try_infer_dates: 0, input_format_try_infer_datetimes: 0 },
    });
    c = new Client(api.base);
    assert.equal((await c.login(NAME, PASSWORD)).status, 200);
  });

  after(async () => {
    await api?.close();
    await pg?.stop();
    await tch?.stop();
  });

  live('조건 없이 찾으면 거부·미래 수신·보관 만료·차단 구간을 빼고 최신순으로 준다', async () => {
    const r = await search({ condition: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'complete');
    assert.deepEqual(seqs(r), [34, 33, 32, 31, 30, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    assert.equal(r.body.next_cursor, null);
    assert.equal(r.body.unknown_count, 0);
    assert.equal(r.body.applied.timezone, 'Asia/Seoul');
    assert.equal(r.body.collection_issues.rejected_count, 1);
    assert.equal(r.body.collection_issues.searchable_unknown, false);
    const first = r.body.rows[0];
    assert.equal(first.service.name, 'orders');
    assert.equal(first.server, null);
    assert.equal(first.environment, null);
    assert.equal(first.connection_id, encodeConnectionId(2));
    const s15 = r.body.rows.find((x: { body: string }) => x.body === 'line 15');
    assert.equal(s15.level, 'UNKNOWN');
    assert.equal(r.body.rows.find((x: { body: string }) => x.body === 'line 6').flags.includes('parse_failed'), true);
  });

  live('값 일치는 숫자와 같은 글자의 문자열에 일치하고 해석 실패·일부 해석·필드 생략은 판정 불가다(SD-20, SD-22)', async () => {
    const r = await search(field('http.status', 'eq', 500));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(seqs(r), [2, 1]);
    assert.equal(r.body.unknown_count, 3);
    const s = await search(field('http.status', 'eq', '500'));
    assert.deepEqual(seqs(s), [2, 1]);
  });

  live('숫자 범위는 숫자 값만 비교하고 문자열·null은 판정 불가다(SD-21)', async () => {
    const r = await search(field('http.status', 'gte', 500));
    assert.deepEqual(seqs(r), [3, 1]);
    assert.equal(r.body.unknown_count, 6);
    const u = await c.call('POST', `/api/v1/search/${r.body.run_id}/unknown`, { body: {} });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.deepEqual(seqs(u), [9, 8, 6, 5, 4, 2]);
  });

  live('2^53을 넘는 정수도 정확히 일치한다', async () => {
    assert.deepEqual(seqs(await search(field('user.id', 'eq', '9007199254740993'))), [11]);
  });

  live('항목 존재는 null도 존재이고, 항목 없음은 정상 해석한 로그에만 참이다(Q08-02)', async () => {
    const e = await search(field('http.status', 'exists'));
    assert.deepEqual(seqs(e), [5, 4, 3, 2, 1]);
    assert.equal(e.body.unknown_count, 3);
    const n = await search(field('http.status', 'not_exists'));
    assert.deepEqual(seqs(n), [34, 33, 32, 31, 30, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10]);
  });

  live('참거짓은 Bool과 문자열에 함께 일치하고 값 다름은 값이 있는 로그만 본다', async () => {
    assert.deepEqual(seqs(await search(field('ok', 'eq', true))), [14, 13]);
    const ne = await search(field('ok', 'ne', true));
    assert.deepEqual(seqs(ne), []);
    assert.equal(ne.body.unknown_count, 3);
  });

  live('레벨 조건에서 미확인 로그는 판정 불가이고 미확인을 고르면 함께 든다(SD-09)', async () => {
    const r = await search({ condition: { levels: ['ERROR'] } });
    assert.equal(seqs(r).length, 17);
    assert.equal(r.body.unknown_count, 1);
    const both = await search({ condition: { levels: ['ERROR', 'UNKNOWN'] } });
    assert.equal(seqs(both).length, 18);
    assert.equal(both.body.unknown_count, 0);
  });

  live('본문은 대소문자 구분을 고르고 이스케이프를 푼 본문과 특수 문자를 글자 그대로 찾는다(SD-14~SD-16)', async () => {
    const b = (text: string, case_sensitive = false, op = 'contains') => search({ condition: { body: [{ op, text, case_sensitive }] } });
    assert.deepEqual(seqs(await b('timeout')), [16]);
    assert.deepEqual(seqs(await b('TIMEOUT', true)), [16]);
    assert.deepEqual(seqs(await b('timeout', true)), []);
    assert.deepEqual(seqs(await b('결제')), [17]);
    assert.deepEqual(seqs(await b('%_')), [18]);
    assert.equal(seqs(await b('health', false, 'not_contains')).length, 25);
  });

  live('출처의 미입력(null)과 수집 연결로 거른다(SD-12, SD-37)', async () => {
    const want = [34, 33, 32, 31, 30, 21, 20];
    assert.deepEqual(seqs(await search({ condition: { sources: { server_ids: [null] } } })), want);
    assert.deepEqual(seqs(await search({ condition: { sources: { environments: [null] } } })), want);
    assert.deepEqual(seqs(await search({ condition: { sources: { connection_ids: [encodeConnectionId(2)] } } })), want);
    assert.equal(seqs(await search({ condition: { sources: { service_ids: [1] } } })).length, 19);
  });

  live('같은 마이크로초의 행도 커서로 빠짐없이 겹치지 않게 넘긴다(SD-26, SD-27)', async () => {
    for (const [sort, want] of [
      ['newest', [34, 33, 32, 31, 30, 21, 20]],
      ['oldest', [20, 21, 30, 31, 32, 33, 34]],
    ] as const) {
      const r = await search({ condition: { sources: { connection_ids: [encodeConnectionId(2)] } }, sort, page_size: 3 });
      const got = seqs(r);
      let cursor = r.body.next_cursor;
      while (cursor) {
        const p = await c.call('POST', `/api/v1/search/${r.body.run_id}/page`, { body: { cursor } });
        assert.equal(p.status, 200, JSON.stringify(p.body));
        got.push(...seqs(p));
        cursor = p.body.next_cursor;
      }
      assert.deepEqual(got, want, sort);
    }
  });

  live('수신 시각 기준도 같은 수신·보관 범위를 쓴다(Q08-04)', async () => {
    const r = await search({ condition: {}, time: { mode: 'relative', last: 'PT1H', basis: 'received' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(seqs(r).length, 26);
  });

  live('시간별 발생량은 표시 시간대의 구간 경계와 빈 구간까지 준다(SD-29)', async () => {
    const r = await search({ condition: {} });
    const h = await c.call('POST', `/api/v1/search/${r.body.run_id}/histogram`, { body: {} });
    assert.equal(h.status, 200, JSON.stringify(h.body));
    assert.equal(h.body.status, 'complete');
    assert.equal(h.body.timezone, 'Asia/Seoul');
    assert.deepEqual(h.body.interval, { n: 30, unit: 'second', seconds: 30 });
    const counts = h.body.buckets.map((b: { count: number }) => b.count);
    assert.equal(counts.reduce((a: number, b: number) => a + b, 0), 26);
    assert.ok(counts.includes(0));
    assert.equal(h.body.buckets[0].start, r.body.applied.from);
    assert.equal(h.body.buckets.at(-1).end, r.body.applied.to);
  });

  live('서비스·서버·레벨별 건수와 판정 불가 건수(Q08-08)', async () => {
    const r = await search({ condition: {} });
    const d = await c.call('POST', `/api/v1/search/${r.body.run_id}/distribution`, { body: {} });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(d.body.services, [
      { id: 1, name: 'billing', archived: false, count: 19 },
      { id: 2, name: 'orders', archived: false, count: 7 },
    ]);
    assert.deepEqual(d.body.servers, [
      { id: 1, name: 'web-1', count: 19 },
      { id: null, name: null, count: 7 },
    ]);
    assert.deepEqual(Object.fromEntries(d.body.levels.map((x: { level: string; count: number }) => [x.level, x.count])), { ERROR: 17, WARN: 7, UNKNOWN: 1, INFO: 1 });
    const g = await search(field('http.status', 'gte', 500));
    const gd = await c.call('POST', `/api/v1/search/${g.body.run_id}/distribution`, { body: {} });
    assert.equal(gd.body.unknown_count, 6);
  });

  live('취소·만료·다른 세션과 입력 오류', async () => {
    const r = await search({ condition: {} });
    const x = await c.call('DELETE', `/api/v1/search/${r.body.run_id}`);
    assert.equal(x.status, 200);
    assert.equal(x.body.server_stopped, true);
    assert.equal((await c.call('POST', `/api/v1/search/${randomUUID()}/histogram`, { body: {} })).body.code, 'run_expired');
    const other = new Client(api.base);
    assert.equal((await other.login(NAME, PASSWORD)).status, 200);
    assert.equal((await other.call('POST', `/api/v1/search/${r.body.run_id}/histogram`, { body: {} })).status, 410);
    const bad = await search(field('', 'exists'));
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, 'condition_invalid');
    assert.equal((await search({ condition: {}, page_size: 501 })).body.code, 'validation_failed');
    const cur = await c.call('POST', `/api/v1/search/${r.body.run_id}/page`, { body: { cursor: 'nope' } });
    assert.equal(cur.status, 422);
  });

  const ref = (c: number, seq: number, received = at(seq)) => eventRef(c, 1, String(seq), received);
  const detail = (r: string) => c.call('GET', `/api/v1/events/${r}`);

  live('상세는 필드를 타입과 함께 주고 2^53을 넘는 정수는 문자열로 준다(SD-21, UI-03)', async () => {
    const d1 = await detail(ref(1, 1));
    assert.equal(d1.status, 200, JSON.stringify(d1.body));
    assert.deepEqual(d1.body.fields, [{ path: 'http.status', type: 'number', value: 500 }]);
    assert.equal(d1.body.source.service.name, 'billing');
    assert.equal(d1.body.times.time_source, 'body');
    assert.deepEqual(d1.body.level, { normalized: 'ERROR', raw: 'error' });
    assert.deepEqual((await detail(ref(1, 2))).body.fields, [{ path: 'http.status', type: 'string', value: '500' }]);
    assert.deepEqual((await detail(ref(1, 5))).body.fields, [{ path: 'http.status', type: 'null', value: null }]);
    assert.deepEqual((await detail(ref(1, 11))).body.fields, [{ path: 'user.id', type: 'number', value: '9007199254740993' }]);
    assert.deepEqual((await detail(ref(1, 13))).body.fields, [{ path: 'ok', type: 'boolean', value: true }]);
  });

  live('stack trace는 내장 필드 이름이나 여러 줄 본문의 이어진 줄에서 뽑는다(WQ-18)', async () => {
    assert.deepEqual((await detail(ref(1, 50, at(-7200)))).body.stack_trace, {
      source: 'body',
      path: null,
      text: '    at handler (app.js:10)\n    at main (app.js:2)',
    });
    assert.deepEqual((await detail(ref(1, 51, at(-7200)))).body.stack_trace, { source: 'field', path: 'err.stack', text: 'Trace: x\n  at y' });
    assert.equal((await detail(ref(1, 1))).body.stack_trace, null);
  });

  live('가져올 수 없는 이벤트는 가능한 사유를 준다(UI-03 상태 7)', async () => {
    const blocked = await detail(ref(1, 43));
    assert.equal(blocked.status, 410);
    assert.deepEqual(blocked.body.params.reasons, ['manual_deletion']);
    // 보관 기간이 지난 행은 TTL로 곧 지워지므로, 남아 있으면 보존 만료 하나, 지워졌으면 가능한 사유들(그 연결의 수동 삭제 포함)이다.
    const old = await detail(ref(1, 42, chOf(now - 7n * 30n * 24n * 3_600_000_000n)));
    assert.equal(old.status, 410);
    assert.ok(old.body.params.reasons.includes('retention'), JSON.stringify(old.body));
    assert.deepEqual((await detail(ref(1, 999))).body.params.reasons, ['manual_deletion']);
    assert.equal((await detail(ref(2, 999))).status, 404);
    assert.equal((await detail('not-a-ref')).status, 404);
  });

  live('같은 흐름의 주변 로그는 원본 순서로 앞뒤를 나눠 주고 흐름의 처음에서 멈춘다(Q09-01·02)', async () => {
    const nearby = (body: object) => c.call('POST', `/api/v1/events/${ref(1, 10)}/nearby`, { body: { mode: 'stream', limit: 3, ...body } });
    const first = await nearby({});
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.order, 'stream_order');
    const nums = (rows: { event_ref: string }[]) => rows.map((x) => Number(Buffer.from(x.event_ref, 'base64url').toString().split('.')[3]));
    assert.deepEqual(nums(first.body.before.rows), [7, 8, 9]);
    assert.deepEqual(nums(first.body.after.rows), [11, 12, 13]);
    const before: number[] = [];
    let cursor = first.body.before.next_cursor;
    let end = null;
    while (cursor) {
      const p = await nearby({ direction: 'before', cursor });
      assert.equal(p.status, 200, JSON.stringify(p.body));
      before.unshift(...nums(p.body.before.rows));
      cursor = p.body.before.next_cursor;
      end = p.body.before.end_reason;
    }
    assert.deepEqual(before, [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(end, 'stream_start');
    const after: { rows: { event_ref: string; kind?: string }[] }[] = [];
    cursor = first.body.after.next_cursor;
    while (cursor) {
      const p = await nearby({ direction: 'after', cursor });
      after.push(p.body.after);
      cursor = p.body.after.next_cursor;
      end = p.body.after.end_reason;
    }
    const rest = after.flatMap((x) => x.rows);
    assert.deepEqual(nums(rest), [14, 15, 16, 17, 18, 19, 40]);
    assert.equal(rest.at(-1)!.kind, 'rejected');
    assert.equal(end, 'unobserved');
    assert.deepEqual(first.body.gaps.map((g: { kind: string }) => g.kind), ['manual_deletion']);
  });

  live('같은 서비스·서버의 주변 로그는 다른 흐름까지 시간순으로 준다(Q09-03)', async () => {
    const r = await c.call('POST', `/api/v1/events/${ref(2, 20)}/nearby`, { body: { mode: 'service_server', direction: 'after', limit: 10 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.order, 'time');
    assert.deepEqual(r.body.after.rows.map((x: { event_ref: string }) => Number(Buffer.from(x.event_ref, 'base64url').toString().split('.')[3])), [21, 30, 31, 32, 33, 34]);
  });

  live('필드 이름 후보는 최근 수신분의 경로를 많이 나온 순서로 준다(SD-25)', async () => {
    const r = await c.call('POST', '/api/v1/fields/suggest', { body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.fields.slice(0, 2), [
      { path: 'http', count: 5 },
      { path: 'http.status', count: 5 },
    ]);
    const q = await c.call('POST', '/api/v1/fields/suggest', { body: { query: 'STAT', sources: { service_ids: [1] } } });
    assert.deepEqual(q.body.fields, [{ path: 'http.status', count: 5 }]);
    assert.deepEqual((await c.call('POST', '/api/v1/fields/suggest', { body: { sources: { service_ids: [2] } } })).body.fields, []);
  });

  const GTE = { sources: { service_ids: [], server_ids: [], environments: [], connection_ids: [] }, levels: [], body: [], fields: [{ path: 'http.status', op: 'gte', value: 500 }] };
  const rfcAt = (sec: number) => at(sec).replace(' ', 'T') + 'Z';

  live('알림 미리보기는 평가와 같은 수신 시각 창으로 일치 확정 건만 센다(TD-04, TD-05)', async () => {
    const all = await c.call('POST', '/api/v1/alert-rules/preview', { body: { condition: {}, window_minutes: 60, threshold: 10 } });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(all.body.matched_count, 26);
    assert.equal(all.body.would_fire, true);
    assert.equal(all.body.window.basis, 'received');
    const f = await c.call('POST', '/api/v1/alert-rules/preview', { body: { condition: { fields: GTE.fields }, window_minutes: 60, threshold: 3 } });
    assert.equal(f.body.matched_count, 2);
    assert.equal(f.body.unknown_count, 6);
    assert.equal(f.body.would_fire, false);
  });

  live('알림 조사 모드는 당시 조건과 창으로 지금 건수를 다시 세고 차이 사유를 준다(WQ-13, WQ-14)', async () => {
    await api.db.query(
      `INSERT INTO alert_rules (owner_account_id, name, enabled, condition, window_minutes, threshold) VALUES (1, '결제 오류', false, $1, 60, 1)`,
      [GTE],
    );
    await api.db.query(
      `INSERT INTO alert_incidents (public_ref, rule_id, condition_version, rule_name, condition, window_minutes, threshold,
                                    window_start, window_end, fired_at, matched_count, unknown_count, partial, quality)
       VALUES ('inc-live-1', 1, 1, '결제 오류', $1, 60, 1, $2::timestamptz, $3::timestamptz, now(), 3, 6, false, 'complete')`,
      [GTE, rfcAt(-600), rfcAt(200)],
    );
    await api.db.query('UPDATE alert_rules SET condition_version = 2 WHERE id = 1');
    const r = await c.call('GET', '/api/v1/incidents/inc-live-1/investigation');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.incident.rule_status, 'changed');
    assert.deepEqual(r.body.then, { matched_count: 3, unknown_count: 6, partial: false });
    assert.deepEqual(r.body.now, { matched_count: 2, unknown_count: 6, partial: false });
    assert.deepEqual(
      Object.fromEntries(r.body.reasons.map((x: { kind: string; applies: string }) => [x.kind, x.applies])),
      { retention: 'no', early_deletion: 'no', manual_deletion: 'no', undecided: 'yes', partial: 'no', late: 'unknown' },
    );
    assert.equal((await c.call('GET', '/api/v1/incidents/nope/investigation')).status, 404);
  });
});
