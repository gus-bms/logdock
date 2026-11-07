// 검색 조건을 ClickHouse 질의로 바꾼다(계약 4.2절, SD-13~SD-22). 값은 모두 바인딩 파라미터로 넣는다(SD-15).
// 조건은 일치·불일치·판정 불가의 세 값으로 본다(SD-22). 출처·시간·본문은 언제나 판정할 수 있어 WHERE에 바로 넣고, 판정 불가가
// 생길 수 있는 레벨·필드 조건은 1·0·NULL을 내는 식으로 만들어 ClickHouse `and`(NULL이 섞이면 0이 없을 때만 NULL)로 묶는다.
import { type ParamValue, quoteIdent, toChTime } from '../clickhouse/clickhouse.js';
import type { Condition, Level } from './condition.js';

/** 차단 구간(3.3절 구간 삭제). 검색·주변 로그·상세·알림 평가에서 뺀다. 기준은 `ref_time`이다. */
export interface Block {
  connectionId: number;
  from: string;
  to: string;
}

/** 한 실행의 고정 범위(4.2절 실행 기준). 시각은 API 표기(UTC RFC 3339 마이크로초)다. */
export interface Scope {
  basis: 'occurred' | 'received';
  /** 시작 포함·끝 제외. */
  from: string;
  to: string;
  /** 검색 가능이 확정된 수신 시각. 이보다 앞에 수신된 로그만 본다(SD-28). */
  receivedThrough: string;
  /** 조회 가능 시작(수신 시각 기준, SD-33). 보관 기간·조기 삭제로 정한다. */
  availableFrom: string;
  /** 조건의 수집 연결(외부 ID를 푼 내부 ID). */
  connectionIds: number[];
  blocks: Block[];
}

/** 바인딩 파라미터를 모은다. 이름은 `p0`, `p1`…이다. */
export class Params {
  readonly values: Record<string, ParamValue> = {};
  private n = 0;

  add(type: string, value: ParamValue): string {
    const name = `p${this.n++}`;
    this.values[name] = value;
    return `{${name}:${type}}`;
  }

  time(rfc: string): string {
    return this.add("DateTime64(6, 'UTC')", toChTime(rfc));
  }
}

/** 시간 기준 열. `occurred`는 검색 기준 시각, `received`는 수신 시각이다(Q08-04). */
export function timeColumn(basis: Scope['basis']): 'ref_time' | 'received_at' {
  return basis === 'occurred' ? 'ref_time' : 'received_at';
}

/** 부분 일치 패턴. `%`·`_`·`\`를 이스케이프해 글자 그대로 찾는다(SD-15). */
export function likePattern(text: string): string {
  return '%' + text.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/** JSON 필드 경로의 하위 열. 점으로 나눈 조각을 하나씩 역따옴표로 감싸고, 형을 주면 그 형의 값만 읽는다(없으면 NULL). */
export function jsonPath(path: string, type?: 'String' | 'Int64' | 'UInt64' | 'Float64' | 'Bool'): string {
  const col = 'fields.' + path.split('.').map(quoteIdent).join('.');
  return type ? `${col}.:${type}` : col;
}

export interface Filter {
  /** 언제나 판정되는 조건(AND). */
  where: string;
  /** 판정 불가가 생길 수 있는 조건을 묶은 식(1·0·NULL). 없으면 null이고 판정 불가도 없다. */
  tvl: string | null;
}

/** 실행 범위와 조건으로 거르는 식을 만든다. `rows`는 일치, `unknown`은 판정 불가 행을 고르는 WHERE다. */
export function buildFilter(cond: Condition, scope: Scope, p: Params, kind: 'event' | 'rejected' = 'event'): Filter & { rows: string; unknown: string } {
  const t = timeColumn(scope.basis);
  const where = [
    kind === 'event' ? `kind = 'event'` : `kind = 'rejected'`,
    `${t} >= ${p.time(scope.from)}`,
    `${t} < ${p.time(scope.to)}`,
    `received_at >= ${p.time(scope.availableFrom)}`,
    `received_at < ${p.time(scope.receivedThrough)}`,
  ];
  const s = cond.sources;
  if (s.service_ids.length) where.push(`service_id IN (${s.service_ids.map((id) => p.add('UInt32', id)).join(', ')})`);
  if (s.server_ids.length) {
    const ids = s.server_ids.filter((x): x is number => x !== null);
    const parts = [];
    if (ids.length) parts.push(`server_id IN (${ids.map((id) => p.add('UInt32', id)).join(', ')})`);
    if (s.server_ids.includes(null)) parts.push('server_id IS NULL');
    where.push(parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0]);
  }
  if (s.environments.length) {
    // `미입력`은 빈 값으로 저장한다(3.2절).
    const values = s.environments.map((e) => p.add('String', e ?? ''));
    where.push(`environment IN (${values.join(', ')})`);
  }
  if (scope.connectionIds.length) where.push(`connection_id IN (${scope.connectionIds.map((id) => p.add('UInt32', id)).join(', ')})`);
  for (const b of scope.blocks) {
    where.push(`NOT (connection_id = ${p.add('UInt32', b.connectionId)} AND ref_time >= ${p.time(b.from)} AND ref_time < ${p.time(b.to)})`);
  }
  for (const b of cond.body) {
    const pat = p.add('String', likePattern(b.text));
    const op = b.case_sensitive ? 'LIKE' : 'ILIKE';
    const hit = `(body ${op} ${pat} OR body_unescaped ${op} ${pat})`;
    where.push(b.op === 'contains' ? hit : `NOT ${hit}`);
  }
  const tvl: string[] = [];
  if (cond.levels.length) {
    const list = cond.levels.map((l) => p.add('String', l)).join(', ');
    // `미확인`을 고르지 않았으면 미확인 로그는 레벨 조건을 판정할 수 없다(SD-22). 골랐으면 값 목록의 하나일 뿐이다.
    if (cond.levels.includes('UNKNOWN' as Level)) where.push(`level IN (${list})`);
    else tvl.push(`multiIf(level IN (${list}), 1, level = 'UNKNOWN', NULL, 0)`);
  }
  for (const f of cond.fields) tvl.push(fieldExpr(f, p));
  const filter: Filter = { where: where.join('\n  AND '), tvl: tvl.length === 0 ? null : tvl.length === 1 ? tvl[0] : `and(${tvl.join(', ')})` };
  return {
    ...filter,
    rows: filter.tvl ? `${filter.where}\n  AND ${filter.tvl}` : filter.where,
    unknown: filter.tvl ? `${filter.where}\n  AND isNull(${filter.tvl})` : '0',
  };
}

/**
 * 필드 조건 하나(SD-19~SD-22). 해석 실패 로그는 판정 불가, 해석하지 않는 형식(`none`)은 불일치다. 항목이 없을 때는 해석했고
 * 생략한 필드가 없으면 `없음`으로 단정하고, 필드를 일부 생략했으면 판정 불가다. `partial`은 시각·레벨 가운데 일부만 읽었다는
 * 뜻이라(Q02-05, 수신 서버 해석) 필드는 다 읽은 것으로 본다. 필드가 잘린 것은 `fields_truncated`가 따로 알린다.
 */
function fieldExpr(f: Condition['fields'][number], p: Params): string {
  const present = `has(field_paths, ${p.add('String', f.path)})`;
  let whenPresent: string;
  switch (f.op) {
    case 'exists':
      whenPresent = '1';
      break;
    case 'not_exists':
      whenPresent = '0';
      break;
    case 'eq':
      whenPresent = `toUInt8(${eqExpr(f.path, f.value!, p)})`;
      break;
    case 'ne':
      whenPresent = `toUInt8(NOT ${eqExpr(f.path, f.value!, p)})`;
      break;
    default:
      whenPresent = rangeExpr(f.path, f.op, f.value as number, p);
  }
  const whenAbsent = f.op === 'not_exists' ? '1' : '0';
  return (
    `multiIf(parse_status = 'failed', NULL, parse_status = 'none', 0, ${present}, ${whenPresent}, ` +
    `parse_status IN ('ok', 'partial') AND NOT fields_truncated, ${whenAbsent}, NULL)`
  );
}

const CANONICAL_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

/**
 * 값 일치(SD-20). 화면에 보이는 값 기준이라 숫자 입력은 같은 수의 숫자 값과 같은 글자의 문자열에 일치하고, true·false도 같다.
 * 그 밖의 문자열은 대소문자까지 같아야 한다. 정수는 정수 형끼리 비교해 2^53을 넘어도 정확하다(SD-21).
 */
function eqExpr(path: string, value: string | number | boolean, p: Params): string {
  const text = typeof value === 'string' ? value : String(value);
  const parts = [`ifNull(${jsonPath(path, 'String')} = ${p.add('String', text)}, 0)`];
  const numeric = typeof value === 'number' ? Number.isFinite(value) : CANONICAL_NUMBER.test(value as string);
  if (typeof value !== 'boolean' && numeric) {
    const n = Number(value);
    let int: bigint | null = null;
    if (typeof value === 'number' && Number.isInteger(value)) int = BigInt(value);
    else if (typeof value === 'string' && /^-?(0|[1-9]\d*)$/.test(value)) int = BigInt(value);
    if (int !== null) {
      if (int >= INT64_MIN && int <= INT64_MAX) parts.push(`ifNull(${jsonPath(path, 'Int64')} = ${p.add('Int64', int)}, 0)`);
      if (int >= 0n && int <= UINT64_MAX) parts.push(`ifNull(${jsonPath(path, 'UInt64')} = ${p.add('UInt64', int)}, 0)`);
    }
    if (Number.isFinite(n)) parts.push(`ifNull(${jsonPath(path, 'Float64')} = ${p.add('Float64', n)}, 0)`);
  }
  const bool = value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
  if (bool !== null) parts.push(`ifNull(${jsonPath(path, 'Bool')} = ${p.add('Bool', bool)}, 0)`);
  return `(${parts.join(' OR ')})`;
}

/** 숫자 범위(SD-21). 숫자 값만 비교하고 숫자가 아닌 값(문자열·참거짓·null·배열·객체)은 판정 불가(NULL)다. */
function rangeExpr(path: string, op: 'gt' | 'gte' | 'lt' | 'lte', value: number, p: Params): string {
  const sym = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
  const v = p.add('Float64', value);
  return `coalesce(${jsonPath(path, 'Int64')} ${sym} ${v}, ${jsonPath(path, 'UInt64')} ${sym} ${v}, ${jsonPath(path, 'Float64')} ${sym} ${v})`;
}

/** 정렬과 커서 위치(SD-26, SD-27). 기준 시각 다음에 연결·세대·순번을 보조 키로 써서 행 순서가 유일하다. */
export interface Position {
  /** ClickHouse 표기 시각. */
  t: string;
  c: number;
  g: number;
  s: string;
}

export function orderBy(basis: Scope['basis'], sort: 'newest' | 'oldest'): string {
  const dir = sort === 'newest' ? 'DESC' : 'ASC';
  return [timeColumn(basis), 'connection_id', 'generation', 'seq'].map((c) => `${c} ${dir}`).join(', ');
}

/** 커서 다음 행만 고르는 조건. 시각 조건을 따로 붙여 파티션·정렬 키로 덜 읽게 한다. */
export function afterPosition(basis: Scope['basis'], sort: 'newest' | 'oldest', pos: Position, p: Params): string {
  const t = timeColumn(basis);
  const cmp = sort === 'newest' ? '<' : '>';
  const tp = p.add("DateTime64(6, 'UTC')", pos.t);
  const tuple = `(${tp}, ${p.add('UInt32', pos.c)}, ${p.add('UInt16', pos.g)}, ${p.add('UInt64', pos.s)})`;
  return `${t} ${cmp}= ${tp} AND (${t}, connection_id, generation, seq) ${cmp} ${tuple}`;
}
