// 검색 SQL 생성 시험(계약 4.2절, SD-15·SD-20~SD-22). ClickHouse 없이 만든 식과 바인딩 값만 본다. 실제 판정은 ClickHouse
// 시험(search.live.spec)에서 확인한다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Condition } from './condition.js';
import { Params, buildFilter, jsonPath, likePattern, type Scope } from './search-sql.js';

const SCOPE: Scope = {
  basis: 'occurred',
  from: '2026-11-05T00:00:00.000000Z',
  to: '2026-11-05T01:00:00.000000Z',
  receivedThrough: '2026-11-05T01:00:00.000000Z',
  availableFrom: '2026-05-05T01:00:00.000000Z',
  connectionIds: [],
  blocks: [],
};
const EMPTY: Condition = { sources: { service_ids: [], server_ids: [], environments: [], connection_ids: [] }, levels: [], body: [], fields: [] };
const build = (over: Partial<Condition>, scope: Partial<Scope> = {}) => {
  const p = new Params();
  const f = buildFilter({ ...EMPTY, ...over }, { ...SCOPE, ...scope }, p);
  return { ...f, values: p.values };
};

describe('검색 SQL', () => {
  it('부분 일치의 %·_·\\는 글자 그대로 찾는다(SD-15)', () => {
    assert.equal(likePattern('100%_done\\x'), '%100\\%\\_done\\\\x%');
  });

  it('필드 경로는 조각마다 역따옴표로 감싸고 형을 붙인다', () => {
    assert.equal(jsonPath('http.status', 'Int64'), 'fields.`http`.`status`.:Int64');
    assert.equal(jsonPath('a`b.c\\d'), 'fields.`a\\`b`.`c\\\\d`');
  });

  it('시간·수신·보관 범위는 바인딩 값으로 들어가고 조건이 없으면 판정 불가가 없다', () => {
    const f = build({});
    assert.equal(f.tvl, null);
    assert.equal(f.unknown, '0');
    assert.match(f.where, /^kind = 'event'/);
    assert.deepEqual(Object.values(f.values), [
      '2026-11-05 00:00:00.000000',
      '2026-11-05 01:00:00.000000',
      '2026-05-05 01:00:00.000000',
      '2026-11-05 01:00:00.000000',
    ]);
    assert.match(build({}, { basis: 'received' }).where, /received_at >= \{p0:/);
  });

  it('서버·환경의 미입력(null)은 NULL·빈 값으로 고른다(SD-12)', () => {
    const f = build({ sources: { service_ids: [3], server_ids: [2, null], environments: [null, '운영'], connection_ids: [] } });
    assert.match(f.where, /service_id IN \(\{p\d+:UInt32\}\)/);
    assert.match(f.where, /\(server_id IN \(\{p\d+:UInt32\}\) OR server_id IS NULL\)/);
    assert.match(f.where, /environment IN \(\{p\d+:String\}, \{p\d+:String\}\)/);
    assert.ok(Object.values(f.values).includes(''));
    assert.match(build({ sources: { ...EMPTY.sources, server_ids: [null] } }).where, /AND server_id IS NULL/);
  });

  it('차단 구간은 연결과 검색 기준 시각 구간으로 뺀다(3.3절)', () => {
    const f = build({}, { blocks: [{ connectionId: 7, from: '2026-11-05T00:10:00.000000Z', to: '2026-11-05T00:20:00.000000Z' }] });
    assert.match(f.where, /NOT \(connection_id = \{p\d+:UInt32\} AND ref_time >= \{p\d+:DateTime64\(6, 'UTC'\)\} AND ref_time < \{p\d+:DateTime64\(6, 'UTC'\)\}\)/);
  });

  it('본문 조건은 두 본문 열을 같이 보고 대소문자 구분을 고른다(SD-16)', () => {
    const f = build({
      body: [
        { op: 'contains', text: 'Timeout', case_sensitive: false },
        { op: 'not_contains', text: 'health', case_sensitive: true },
      ],
    });
    assert.match(f.where, /\(body ILIKE (\{p\d+:String\}) OR body_unescaped ILIKE \1\)/);
    assert.match(f.where, /NOT \(body LIKE (\{p\d+:String\}) OR body_unescaped LIKE \1\)/);
    assert.ok(Object.values(f.values).includes('%Timeout%'));
    assert.equal(f.tvl, null);
  });

  it('레벨 조건은 미확인을 고르지 않았을 때만 판정 불가가 생긴다(SD-09, SD-22)', () => {
    const a = build({ levels: ['ERROR'] });
    assert.match(a.tvl!, /^multiIf\(level IN \(\{p\d+:String\}\), 1, level = 'UNKNOWN', NULL, 0\)$/);
    assert.match(a.unknown, /isNull\(multiIf/);
    const b = build({ levels: ['ERROR', 'UNKNOWN'] });
    assert.equal(b.tvl, null);
    assert.match(b.where, /level IN \(\{p\d+:String\}, \{p\d+:String\}\)/);
  });

  it('필드 조건은 해석 상태에 따라 판정 불가를 낸다(SD-22, Q08-02)', () => {
    const f = build({ fields: [{ path: 'http.status', op: 'not_exists' }] });
    assert.equal(
      f.tvl,
      "multiIf(parse_status = 'failed', NULL, parse_status = 'none', 0, has(field_paths, {p4:String}), 0, parse_status IN ('ok', 'partial') AND NOT fields_truncated, 1, NULL)",
    );
    assert.equal(f.values.p4, 'http.status');
    const two = build({ levels: ['WARN'], fields: [{ path: 'a', op: 'exists' }] });
    assert.match(two.tvl!, /^and\(multiIf\(level/);
  });

  it('숫자 값 일치는 숫자 형과 같은 글자의 문자열에 함께 일치한다(SD-20)', () => {
    const f = build({ fields: [{ path: 'http.status', op: 'eq', value: 500 }] });
    const v = Object.values(f.values);
    assert.ok(v.includes('500'));
    assert.ok(v.includes(500n));
    assert.ok(v.includes(500));
    assert.match(f.tvl!, /`status`\.:String = .*`status`\.:Int64 = .*`status`\.:UInt64 = .*`status`\.:Float64 = /);
    assert.doesNotMatch(f.tvl!, /:Bool/);
  });

  it('숫자로 쓴 문자열도 숫자로 비교하지만 0으로 시작하는 값은 글자로만 비교한다', () => {
    const big = build({ fields: [{ path: 'user.id', op: 'eq', value: '9007199254740993' }] });
    assert.ok(Object.values(big.values).includes(9007199254740993n));
    const zero = build({ fields: [{ path: 'code', op: 'eq', value: '007' }] });
    assert.doesNotMatch(zero.tvl!, /Int64|Float64/);
    const neg = build({ fields: [{ path: 'n', op: 'eq', value: '-1' }] });
    assert.match(neg.tvl!, /:Int64 = /);
    assert.doesNotMatch(neg.tvl!, /:UInt64 = /);
  });

  it('참거짓은 Bool과 같은 글자의 문자열에 일치하고, 값 다름은 일치의 부정이다', () => {
    const f = build({ fields: [{ path: 'ok', op: 'ne', value: 'true' }] });
    assert.match(f.tvl!, /toUInt8\(NOT \(ifNull\(fields\.`ok`\.:String = .* OR ifNull\(fields\.`ok`\.:Bool = /);
    assert.ok(Object.values(f.values).includes(true));
  });

  it('숫자 범위는 숫자 형만 비교하고 그 밖은 NULL(판정 불가)이다(SD-21)', () => {
    const f = build({ fields: [{ path: 'latency', op: 'gte', value: 1.5 }] });
    assert.match(f.tvl!, /coalesce\(fields\.`latency`\.:Int64 >= (\{p\d+:Float64\}), fields\.`latency`\.:UInt64 >= \1, fields\.`latency`\.:Float64 >= \1\)/);
  });
});
