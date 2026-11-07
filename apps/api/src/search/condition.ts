// 검색 조건과 시간 범위(계약 4.2절, SD-30). 검색·저장 검색·알림 규칙이 같은 구조화 형식을 쓰고 같은 검사를 거친다.
// 출처와 레벨은 값 목록(같은 항목 안은 OR), 항목 사이와 본문·필드 조건 사이는 AND다(CM-03). 문자열을 쿼리에 이어 붙이지 않고
// 바인딩 파라미터로 넣는 것은 검색 실행 쪽 책임이다(SD-15).
import { z } from 'zod';

import { checkName } from '../common/names.js';
import type { AppConfig } from '../config.js';
import type { FieldProblem } from '../connections/connection-input.js';
import { decodeConnectionId } from '../connections/public-id.js';
import { type Queryable, utc } from '../db/database.js';
import { durationUs, usOf } from './run-time.js';

/** 정규화 레벨(3.2절 level). `UNKNOWN`은 미확인이며 `ERROR`를 골라도 들지 않는다(SD-09). */
export const LEVELS = ['UNKNOWN', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;
export type Level = (typeof LEVELS)[number];
const FIELD_OPS = ['eq', 'ne', 'exists', 'not_exists', 'gt', 'gte', 'lt', 'lte'] as const;
type FieldOp = (typeof FIELD_OPS)[number];

/** 관리 DB의 정수 ID(int4). 넘는 값을 DB에 보내면 형 변환 오류가 500이 된다. */
const Id = z.number().int().positive().max(2147483647);

export const ConditionSchema = z
  .object({
    sources: z
      .object({
        service_ids: z.array(Id).optional(),
        // 서버·환경의 `미입력`은 값 목록 안의 null이다(SD-12).
        server_ids: z.array(Id.nullable()).optional(),
        environments: z.array(z.string().nullable()).optional(),
        connection_ids: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    levels: z.array(z.enum(LEVELS)).optional(),
    body: z
      .array(z.object({ op: z.enum(['contains', 'not_contains']), text: z.string(), case_sensitive: z.boolean().optional() }).strict())
      .optional(),
    fields: z
      .array(z.object({ path: z.string(), op: z.enum(FIELD_OPS), value: z.union([z.string(), z.number(), z.boolean()]).optional() }).strict())
      .optional(),
  })
  .strict();

export const TimeSchema = z
  .object({
    mode: z.enum(['relative', 'absolute']),
    last: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    basis: z.enum(['occurred', 'received']),
  })
  .strict();

/** 저장하는 형태. 빈 항목도 배열로 두고 같은 값은 한 번만 둔다. */
export interface Condition {
  sources: { service_ids: number[]; server_ids: (number | null)[]; environments: (string | null)[]; connection_ids: string[] };
  levels: Level[];
  body: { op: 'contains' | 'not_contains'; text: string; case_sensitive: boolean }[];
  fields: { path: string; op: FieldOp; value?: string | number | boolean }[];
}

export type TimeRange =
  | { mode: 'relative'; last: string; basis: 'occurred' | 'received' }
  | { mode: 'absolute'; from: string; to: string; basis: 'occurred' | 'received' };

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

/**
 * 관리 DB에 저장할 수 없는 글자(짝 없는 서로게이트, NUL)가 있는지 본다. 조건은 jsonb로 저장하는데 jsonb는 둘 다 받지 않아
 * 그대로 두면 500이 된다. 탭·줄바꿈은 여러 줄 이벤트를 찾을 때 쓸 수 있어 막지 않는다.
 */
export function hasInvalidCharacters(s: string): boolean {
  return /[\p{Cs}\u0000]/u.test(s);
}

/**
 * jsonb에 넣는 이름(환경 값·저장 검색 이름). 5.3절 이름 규칙(NUL은 제어 문자로 거절)을 먼저 보고, 규칙이 보지 않는 짝 없는
 * 서로게이트를 `invalid_characters`로 거절한다.
 */
export function checkStoredName(raw: string, maxLength: number): { ok: true; value: string } | { ok: false; reason: string } {
  const c = checkName(raw, maxLength);
  if (c.ok && hasInvalidCharacters(c.value)) return { ok: false, reason: 'invalid_characters' };
  return c;
}

/**
 * 조건의 꼴과 한도를 본다(DB를 보지 않는 부분). 문제는 칸 경로(`condition.body.0.text` 등)와 사유로 모두 돌려준다.
 * 한도(조건 수·검색식 길이·출처 값 수·필드 경로 길이)는 Q15 전의 시제품 설정값이다.
 */
export function checkCondition(
  raw: z.infer<typeof ConditionSchema>,
  config: AppConfig,
  prefix = 'condition',
): { ok: true; condition: Condition } | { ok: false; problems: FieldProblem[] } {
  const lim = config.search;
  const problems: FieldProblem[] = [];
  const s = raw.sources ?? {};
  const sources: Condition['sources'] = {
    service_ids: unique(s.service_ids ?? []),
    server_ids: unique(s.server_ids ?? []),
    environments: [],
    connection_ids: unique(s.connection_ids ?? []),
  };
  (s.environments ?? []).forEach((env, i) => {
    if (env === null) return sources.environments.push(null);
    const c = checkStoredName(env, config.nameMaxLength);
    if (c.ok) sources.environments.push(c.value);
    else problems.push({ path: `${prefix}.sources.environments.${i}`, reason: c.reason });
  });
  sources.environments = unique(sources.environments);
  sources.connection_ids.forEach((id, i) => {
    if (decodeConnectionId(id) === null) problems.push({ path: `${prefix}.sources.connection_ids.${i}`, reason: 'not_found' });
  });
  for (const key of ['service_ids', 'server_ids', 'environments', 'connection_ids'] as const) {
    if (sources[key].length > lim.maxSourceValues) problems.push({ path: `${prefix}.sources.${key}`, reason: 'too_many' });
  }
  const body = (raw.body ?? []).map((b, i) => {
    if (b.text.length === 0) problems.push({ path: `${prefix}.body.${i}.text`, reason: 'too_small' });
    else if (hasInvalidCharacters(b.text)) problems.push({ path: `${prefix}.body.${i}.text`, reason: 'invalid_characters' });
    else if ([...b.text].length > lim.maxTextLength) problems.push({ path: `${prefix}.body.${i}.text`, reason: 'too_big' });
    return { op: b.op, text: b.text, case_sensitive: b.case_sensitive ?? false };
  });
  const fields = (raw.fields ?? []).map((f, i) => {
    const at = `${prefix}.fields.${i}`;
    const segments = f.path.split('.');
    if (f.path === '' || segments.some((x) => x === '')) problems.push({ path: `${at}.path`, reason: 'path_invalid' });
    else if (hasInvalidCharacters(f.path)) problems.push({ path: `${at}.path`, reason: 'invalid_characters' });
    else if ([...f.path].length > lim.maxFieldPathLength) problems.push({ path: `${at}.path`, reason: 'too_big' });
    else if (/\p{Cc}/u.test(f.path)) problems.push({ path: `${at}.path`, reason: 'control_characters' });
    if (f.op === 'exists' || f.op === 'not_exists') {
      if (f.value !== undefined) problems.push({ path: `${at}.value`, reason: 'value_not_allowed' });
      return { path: f.path, op: f.op };
    }
    if (f.value === undefined) problems.push({ path: `${at}.value`, reason: 'required' });
    else if (['gt', 'gte', 'lt', 'lte'].includes(f.op) && typeof f.value !== 'number') problems.push({ path: `${at}.value`, reason: 'number_required' });
    else if (typeof f.value === 'string' && hasInvalidCharacters(f.value)) problems.push({ path: `${at}.value`, reason: 'invalid_characters' });
    else if (typeof f.value === 'string' && [...f.value].length > lim.maxTextLength) problems.push({ path: `${at}.value`, reason: 'too_big' });
    return { path: f.path, op: f.op, value: f.value };
  });
  if (body.length + fields.length > lim.maxConditions) problems.push({ path: prefix, reason: 'too_many_conditions' });
  if (problems.length) return { ok: false, problems };
  return { ok: true, condition: { sources, levels: unique(raw.levels ?? []), body, fields } };
}

/** 조건이 가리키는 서비스·서버·수집 연결이 있는지 본다. 보관된 대상도 고를 수 있다(4.2절 특수 값). */
export async function checkConditionReferences(c: Queryable, cond: Condition, prefix = 'condition'): Promise<FieldProblem[]> {
  const problems: FieldProblem[] = [];
  const missing = async (table: string, ids: number[], key: string) => {
    if (ids.length === 0) return;
    const found = new Set((await c.query<{ id: number }>(`SELECT id FROM ${table} WHERE id = ANY($1)`, [ids])).rows.map((r) => r.id));
    ids.forEach((id, i) => {
      if (!found.has(id)) problems.push({ path: `${prefix}.sources.${key}.${i}`, reason: 'not_found' });
    });
  };
  await missing('services', cond.sources.service_ids, 'service_ids');
  const servers = cond.sources.server_ids.filter((x): x is number => x !== null);
  if (servers.length) {
    const found = new Set((await c.query<{ id: number }>('SELECT id FROM servers WHERE id = ANY($1)', [servers])).rows.map((r) => r.id));
    cond.sources.server_ids.forEach((id, i) => {
      if (id !== null && !found.has(id)) problems.push({ path: `${prefix}.sources.server_ids.${i}`, reason: 'not_found' });
    });
  }
  const conns = cond.sources.connection_ids.map((x) => decodeConnectionId(x)!);
  if (conns.length) {
    const found = new Set((await c.query<{ id: number }>('SELECT id FROM connections WHERE id = ANY($1)', [conns])).rows.map((r) => r.id));
    conns.forEach((id, i) => {
      if (!found.has(id)) problems.push({ path: `${prefix}.sources.connection_ids.${i}`, reason: 'not_found' });
    });
  }
  return problems;
}

// 칸마다 6자리까지만 받는다. 형식이 터무니없이 큰 값을 막을 뿐 기간 상한이 아니며, 보존 기간 밖은 검색할 때 잘린다.
const DURATION = /^P(?=\d|T\d)(?:(\d{1,6})D)?(?:T(?=\d)(?:(\d{1,6})H)?(?:(\d{1,6})M)?(?:(\d{1,6})S)?)?$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * 오프셋을 담은 RFC 3339 시각인지 본다. 날짜·시각 칸이 실제로 있는 값인지(2월 30일·25시 거절)까지 여기서 봐서 DB 형 변환
 * 오류가 500이 되지 않게 한다. 윤초(60초)와 100년 전의 연도는 받지 않는다. 오프셋은 PostgreSQL이 받는 ±15:59까지다.
 */
export function isRfc3339(s: string): boolean {
  const m = RFC3339.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  const same =
    t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d &&
    t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === se;
  return same && (m[7] === undefined || (Number(m[7]) <= 15 && Number(m[8]) <= 59));
}

/**
 * 시간 범위(4.2절 시간, Q11). 상대 범위는 ISO 8601 기간(`PT1H`·`P7D`, 일·시·분·초)이고, 고정 범위는 오프셋을 담은 RFC 3339
 * 시각이다. 고정 범위의 앞뒤와 UTC 맞춤은 DB가 본다(normalizeTime). 상대 범위를 절대 시각으로 바꾸지 않는다.
 */
export function checkTime(raw: z.infer<typeof TimeSchema>, prefix = 'time'): { ok: true; time: TimeRange } | { ok: false; problems: FieldProblem[] } {
  const problems: FieldProblem[] = [];
  if (raw.mode === 'relative') {
    if (raw.from !== undefined || raw.to !== undefined) problems.push({ path: prefix, reason: 'absolute_fields_not_allowed' });
    const m = raw.last === undefined ? null : DURATION.exec(raw.last);
    if (!m || m.slice(1).every((x) => x === undefined || Number(x) === 0)) problems.push({ path: `${prefix}.last`, reason: 'duration_invalid' });
    if (problems.length) return { ok: false, problems };
    return { ok: true, time: { mode: 'relative', last: raw.last!, basis: raw.basis } };
  }
  if (raw.last !== undefined) problems.push({ path: prefix, reason: 'relative_fields_not_allowed' });
  for (const key of ['from', 'to'] as const) {
    if (raw[key] === undefined || !isRfc3339(raw[key]!)) problems.push({ path: `${prefix}.${key}`, reason: 'time_invalid' });
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, time: { mode: 'absolute', from: raw.from!, to: raw.to!, basis: raw.basis } };
}

/**
 * 본문 검색어가 있으면 한 번에 고를 수 있는 기간(Q15-05, 2026-11-07 합의). 본문 검색어 없는 필드 조건·목록·발생량은 보관
 * 기간 전체를 쓸 수 있다. 본문 제외도 본문을 훑으므로 같이 본다. 고정 범위는 UTC로 맞춘 값(normalizeTime 뒤)을 받는다.
 * 저장한 조건에 빠진 항목이 있어도 빈 목록으로 읽는다.
 */
export function checkBodyRange(cond: Pick<Condition, 'body'>, time: TimeRange, maxDays: number, path = 'time'): FieldProblem[] {
  if ((cond.body ?? []).length === 0) return [];
  const span = time.mode === 'relative' ? durationUs(time.last) : usOf(time.to) - usOf(time.from);
  return span > BigInt(maxDays) * 86_400_000_000n ? [{ path, reason: 'body_range_too_long' }] : [];
}

/** 고정 범위를 UTC 마이크로초 문자열로 맞추고 시작이 끝보다 앞인지 본다(시작 포함·끝 제외라 같으면 빈 범위). */
export async function normalizeTime(c: Queryable, t: TimeRange, prefix = 'time'): Promise<{ ok: true; time: TimeRange } | { ok: false; problems: FieldProblem[] }> {
  if (t.mode === 'relative') return { ok: true, time: t };
  const r = (
    await c.query<{ from: string; to: string; ordered: boolean }>(
      `SELECT ${utc('$1::timestamptz')} AS from, ${utc('$2::timestamptz')} AS to, $1::timestamptz < $2::timestamptz AS ordered`,
      [t.from, t.to],
    )
  ).rows[0];
  if (!r.ordered) return { ok: false, problems: [{ path: `${prefix}.to`, reason: 'not_after_from' }] };
  return { ok: true, time: { mode: 'absolute', from: r.from, to: r.to, basis: t.basis } };
}
