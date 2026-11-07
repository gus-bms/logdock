// 알림 규칙 입력(계약 4.3절 `알림 규칙 입력`, TD-01·05, Q12-01·03·12). 조건은 검색·저장 검색과 같은 구조화 형식과 검사를 쓴다(SD-30).
import { z } from 'zod';

import { type AppConfig, MAIL_ADDRESS } from '../config.js';
import type { FieldProblem } from '../connections/connection-input.js';
import { checkCondition, checkStoredName, type Condition, ConditionSchema, hasInvalidCharacters } from '../search/condition.js';
import { sourcesOf } from '../search/references.js';

/** 규칙 이름 상한(TD-01에서 정한 값이라 DB 제약에도 있다). */
export const RULE_NAME_MAX = 100;
/** 메일 주소 길이 상한(SMTP 경로 상한 256에서 꺾쇠 둘을 뺀 값). */
const ADDRESS_MAX = 254;

/** 시간 구간과 해소 대기(분, 1~1,440). */
const Minutes = z.number().int().min(1).max(1440);
/** 임계(1 이상 정수). DB 정수 범위를 넘지 않게 묶는다. */
const Threshold = z.number().int().min(1).max(2147483647);

export const CreateRuleBody = z.object({
  name: z.string(),
  enabled: z.boolean(),
  condition: ConditionSchema,
  window_minutes: Minutes,
  threshold: Threshold,
  /** 비우면(null·생략) 시간 구간과 같은 길이다(Q12-03). */
  resolve_wait_minutes: Minutes.nullable().optional(),
  recipients: z.array(z.string()),
  /** 필터가 하나도 없는 조건을 사용자가 경고를 본 뒤 확인했다(TD-05). */
  confirm_no_filter: z.boolean().optional(),
});
export type CreateRuleBody = z.infer<typeof CreateRuleBody>;

export const UpdateRuleBody = z.object({
  version: z.number().int().positive(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  condition: ConditionSchema.optional(),
  window_minutes: Minutes.optional(),
  threshold: Threshold.optional(),
  resolve_wait_minutes: Minutes.nullable().optional(),
  recipients: z.array(z.string()).optional(),
  confirm_no_filter: z.boolean().optional(),
});
export type UpdateRuleBody = z.infer<typeof UpdateRuleBody>;

export const ConfirmRecipientBody = z.object({ address: z.string() });

/** DB를 보지 않고 확인한 값. 준 칸만 담는다. */
export interface CheckedRule {
  name?: string;
  condition?: Condition;
  recipients?: string[];
}

/** 출처·레벨·본문·필드 조건이 하나도 없다. 모든 로그를 세는 규칙이라 확인을 받는다(TD-05, UI-07). */
export function hasNoFilter(cond: Condition): boolean {
  const s = sourcesOf(cond);
  return (
    s.service_ids.length === 0 &&
    s.server_ids.length === 0 &&
    s.environments.length === 0 &&
    s.connection_ids.length === 0 &&
    (cond.levels ?? []).length === 0 &&
    (cond.body ?? []).length === 0 &&
    (cond.fields ?? []).length === 0
  );
}

/** 수신 주소 목록. 앞뒤 공백만 걷고 형식만 본다(Q12-12). 대소문자만 다른 같은 주소는 거절한다(DB 유일 색인과 같은 기준). */
export function checkRecipients(raw: string[], limit: number, problems: FieldProblem[], path = 'recipients', min = 1): string[] {
  if (raw.length < min) problems.push({ path, reason: 'too_small' });
  if (raw.length > limit) problems.push({ path, reason: 'too_many' });
  const seen = new Set<string>();
  return raw.map((r, i) => {
    const a = r.trim();
    if ([...a].length > ADDRESS_MAX) problems.push({ path: `${path}.${i}`, reason: 'too_big' });
    else if (hasInvalidCharacters(a) || !MAIL_ADDRESS.test(a)) problems.push({ path: `${path}.${i}`, reason: 'format_invalid' });
    else if (seen.has(a.toLowerCase())) problems.push({ path: `${path}.${i}`, reason: 'duplicate' });
    seen.add(a.toLowerCase());
    return a;
  });
}

/** 이름·조건·수신 주소의 꼴과 한도. 문제를 칸마다 모두 모아 돌려준다. 숫자 칸은 스키마가 이미 봤다. */
export function checkRuleFields(
  body: { name?: string; condition?: z.infer<typeof ConditionSchema>; recipients?: string[] },
  config: AppConfig,
): { ok: true; value: CheckedRule } | { ok: false; problems: FieldProblem[] } {
  const problems: FieldProblem[] = [];
  const value: CheckedRule = {};
  if (body.name !== undefined) {
    const n = checkStoredName(body.name, RULE_NAME_MAX);
    if (n.ok) value.name = n.value;
    else problems.push({ path: 'name', reason: n.reason });
  }
  if (body.condition !== undefined) {
    const c = checkCondition(body.condition, config);
    if (c.ok) value.condition = c.condition;
    else problems.push(...c.problems);
  }
  if (body.recipients !== undefined) value.recipients = checkRecipients(body.recipients, config.alertRecipientLimit, problems);
  return problems.length ? { ok: false, problems } : { ok: true, value };
}

/** 키 순서와 상관없이 같은 값인지 본다. DB의 jsonb는 키 순서를 바꿔 돌려준다. */
export function sameJson(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}
