// 수집 연결 등록·사전 검사의 입력(계약 2.8절 입력 규칙, 4.3절 관리, 5.1절 등록 충돌). 등록(`POST /api/v1/connections`)과
// 사전 검사(`POST /api/v1/connections/validate`)가 같은 검사를 쓴다. 수집 대상과 형식은 에이전트와 같은 Go 코드(rules.ts)로,
// 이름·시간대·이벤트 크기는 여기서 본다. DB를 봐야 아는 충돌(서비스 상태·이름 겹침·같은 대상)은 connections.service.ts가 본다.
import { z } from 'zod';

import { checkName } from '../common/names.js';
import type { AppConfig } from '../config.js';
import { checkTargetAndFormat, type RuleTarget } from './rules.js';

const OptionalText = z.string().nullish();

export const ConnectionBody = z.object({
  // 기존 서비스는 ID와 읽을 때 받은 version, 새 서비스는 이름을 준다(Q07-01).
  service: z.object({
    id: z.number().int().positive().optional(),
    version: z.number().int().positive().optional(),
    name: z.string().optional(),
  }),
  server_display_name: OptionalText,
  environment: OptionalText,
  target: z.object({ type: z.string(), path: OptionalText, kind: OptionalText, name: OptionalText }),
  format: z.object({
    type: z.string(),
    event_start: OptionalText,
    log_timezone: OptionalText,
    max_event_bytes: z.number().int().nullish(),
  }),
  // 추출 규칙(Q08-07)은 해석을 맡는 수신 서버와 함께 만든다. 그 전에는 비워 둔다.
  extraction_rule: z.unknown().optional(),
});
export type ConnectionBody = z.infer<typeof ConnectionBody>;

export type ServiceChoice = { kind: 'existing'; id: number; version: number } | { kind: 'new'; name: string };

/** 검사를 마치고 저장할 형태로 맞춘 입력. 빈 선택 값은 null이다. */
export interface ConnectionInput {
  service: ServiceChoice;
  serverDisplayName: string | null;
  environment: string | null;
  target: RuleTarget;
  format: { type: string; eventStart: string | null; logTimezone: string | null; maxEventBytes: number };
}

export interface FieldProblem {
  path: string;
  reason: string;
  expr?: string;
}

/** IANA 시간대 이름인지 본다. 에이전트 쪽 Go와 같은 자료는 아니지만 이름 목록은 같은 IANA 자료다. */
function validTimeZone(tz: string): boolean {
  if (tz === 'Local') return false; // Go에서는 서버 시간대를 뜻하는 특수 이름이다
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 선택 이름 칸: 비었으면 null, 아니면 이름 규칙(5.3절)으로 맞춘다. */
function optionalName(raw: string | null | undefined, path: string, max: number, problems: FieldProblem[]): string | null {
  if (raw == null || raw.trim() === '') return null;
  const c = checkName(raw, max);
  if (!c.ok) {
    problems.push({ path, reason: c.reason });
    return null;
  }
  return c.value;
}

/** 입력을 검사한다. 문제가 있으면 모든 칸의 문제를 한 번에 돌려준다. */
export function checkConnectionInput(
  body: ConnectionBody,
  config: AppConfig,
): { ok: true; input: ConnectionInput } | { ok: false; problems: FieldProblem[] } {
  const problems: FieldProblem[] = [];

  let service: ServiceChoice | null = null;
  const s = body.service;
  if (s.name !== undefined && (s.id !== undefined || s.version !== undefined)) {
    problems.push({ path: 'service', reason: 'id_or_name' });
  } else if (s.name !== undefined) {
    const c = checkName(s.name, config.nameMaxLength);
    if (c.ok) service = { kind: 'new', name: c.value };
    else problems.push({ path: 'service.name', reason: c.reason });
  } else if (s.id !== undefined && s.version !== undefined) {
    service = { kind: 'existing', id: s.id, version: s.version };
  } else {
    problems.push({ path: s.id !== undefined ? 'service.version' : 'service', reason: 'required' });
  }

  const serverDisplayName = optionalName(body.server_display_name, 'server_display_name', config.nameMaxLength, problems);
  const environment = optionalName(body.environment, 'environment', config.nameMaxLength, problems);

  const rules = checkTargetAndFormat(body.target, body.format);
  for (const p of rules.problems) problems.push(p.expr ? { path: p.field, reason: p.code, expr: p.expr } : { path: p.field, reason: p.code });

  let logTimezone: string | null = null;
  const tz = body.format.log_timezone;
  if (tz != null && tz.trim() !== '') {
    if (validTimeZone(tz.trim())) logTimezone = tz.trim();
    else problems.push({ path: 'format.log_timezone', reason: 'timezone_invalid' });
  }

  const maxEventBytes = body.format.max_event_bytes ?? config.maxEventBytes.default;
  if (maxEventBytes < 1) problems.push({ path: 'format.max_event_bytes', reason: 'too_small' });
  else if (maxEventBytes > config.maxEventBytes.max) problems.push({ path: 'format.max_event_bytes', reason: 'too_big' });

  if (body.extraction_rule !== undefined && body.extraction_rule !== null) {
    problems.push({ path: 'extraction_rule', reason: 'not_supported' });
  }

  if (problems.length > 0 || !service) return { ok: false, problems };
  const eventStart = body.format.event_start ?? '';
  return {
    ok: true,
    input: {
      service,
      serverDisplayName,
      environment,
      target: rules.target,
      format: {
        type: body.format.type,
        eventStart: eventStart === '' ? null : eventStart,
        logTimezone,
        maxEventBytes,
      },
    },
  };
}

/** 같은 대상인지 가리는 값. DB의 connections.target_identity 생성 열과 같은 식이다(Q07-06). */
export function targetIdentity(t: RuleTarget): string {
  return t.type === 'journald' ? `journald:${t.kind}:${t.name}` : `path:${t.path}`;
}
