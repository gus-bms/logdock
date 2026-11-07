// 알림 사건(계약 4.3·5.4·5.5절, UI-08·UI-09). 사건과 메일 작업은 알림 평가·메일 발송 작업이 쓰고, API는 읽고 최종 실패 확인만 한다.
// 사건 경로의 ID는 메일 링크와 같은 불투명 값(public_ref)이다. 없거나 알림 이력 보관 기간이 지났으면 404다(Q12-14).
import { Injectable } from '@nestjs/common';

import { errors } from '../common/api-error.js';
import { Database, type Queryable, utc } from '../db/database.js';
import type { Condition } from '../search/condition.js';
import { loadReferences, resolveReferences } from '../search/references.js';

/** 사건마다 메일 작업의 상태별 수. `pending`은 아직 결과가 없는 작업(대기·전송 중·재시도 대기·전송 여부 불명)이다. */
export interface DeliverySummary {
  accepted: number;
  pending: number;
  failed: number;
  cancelled: number;
  failed_unacked: number;
}

const DELIVERY = (incident: string) => `(
  SELECT jsonb_build_object(
           'accepted', count(*) FILTER (WHERE j.state = 'accepted'),
           'pending', count(*) FILTER (WHERE j.state IN ('queued', 'sending', 'retry_wait', 'unknown')),
           'failed', count(*) FILTER (WHERE j.state = 'failed'),
           'cancelled', count(*) FILTER (WHERE j.state = 'cancelled'),
           'failed_unacked', count(*) FILTER (WHERE j.state = 'failed' AND j.acknowledged_at IS NULL))
    FROM mail_jobs j WHERE j.incident_id = ${incident})`;

const INCIDENT_COLUMNS = `
  i.id, i.public_ref, i.rule_id, i.condition_version, i.rule_name, i.condition, i.window_minutes, i.threshold,
  ${utc('i.window_start')} AS window_start, ${utc('i.window_end')} AS window_end, ${utc('i.fired_at')} AS fired_at,
  i.matched_count::float8 AS matched_count, i.unknown_count::float8 AS unknown_count,
  ${utc('i.oldest_occurred_at')} AS oldest_occurred_at, i.partial, i.quality,
  ${utc('i.closed_at')} AS closed_at, i.close_reason, ${DELIVERY('i.id')} AS delivery`;

interface IncidentRow {
  /** bigint라 문자열로 온다. 커서와 메일 작업 조회에만 쓰고 밖에는 내보내지 않는다. */
  id: string;
  public_ref: string;
  rule_id: number;
  condition_version: number;
  rule_name: string;
  condition: Condition;
  window_minutes: number;
  threshold: number;
  window_start: string;
  window_end: string;
  fired_at: string;
  matched_count: number;
  unknown_count: number | null;
  oldest_occurred_at: string | null;
  partial: boolean;
  quality: string;
  closed_at: string | null;
  close_reason: string | null;
  delivery: DeliverySummary;
}

/** 사건 목록의 한 줄(UI-08 사건 이력). 해소 칸에 닫힌 이유와 시각을 보인다(WQ-45). */
function incidentItem(r: IncidentRow) {
  return {
    id: r.public_ref,
    fired_at: r.fired_at,
    window_start: r.window_start,
    window_end: r.window_end,
    matched_count: r.matched_count,
    threshold: r.threshold,
    unknown_count: r.unknown_count,
    oldest_occurred_at: r.oldest_occurred_at,
    partial: r.partial,
    quality: r.quality,
    closed_at: r.closed_at,
    close_reason: r.close_reason,
    delivery: r.delivery,
  };
}

/** 메일 링크의 사건 ID는 영문·숫자·`_`·`-`로 된 불투명 값이다. 꼴이 다르면 그런 사건이 없는 것으로 본다. */
export function incidentRefParam(raw: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) throw errors.notFound();
  return raw;
}

function cursorOf(r: IncidentRow): string {
  return Buffer.from(JSON.stringify([r.fired_at, r.id])).toString('base64url');
}

function parseCursor(s: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v[0]) && /^\d{1,19}$/.test(v[1])) {
      return v as [string, string];
    }
  } catch {
    // 아래에서 입력 오류로 돌려준다
  }
  throw errors.validation([{ path: 'cursor', reason: 'invalid' }]);
}

/** 한 규칙의 사건을 발화 시각 최신순(같으면 ID 역순)으로 나눠 읽는다. 규칙 상세의 최근 사건도 이것을 쓴다. */
export async function listRuleIncidents(c: Queryable, ruleId: number, limit: number, cursor?: string) {
  const values: unknown[] = [ruleId];
  let where = 'i.rule_id = $1';
  if (cursor) {
    const [at, id] = parseCursor(cursor);
    values.push(at, id);
    where += ' AND (i.fired_at, i.id) < ($2::timestamptz, $3::bigint)';
  }
  values.push(limit + 1);
  const r = await c.query<IncidentRow>(
    `SELECT ${INCIDENT_COLUMNS} FROM alert_incidents i WHERE ${where} ORDER BY i.fired_at DESC, i.id DESC LIMIT $${values.length}`,
    values,
  );
  const rows = r.rows.slice(0, limit);
  return { items: rows.map(incidentItem), next_cursor: r.rows.length > limit ? cursorOf(rows[rows.length - 1]) : null };
}

@Injectable()
export class IncidentsService {
  constructor(private readonly db: Database) {}

  /** 지우지 않은 규칙의 사건 이력. 규칙이 없으면 404다. */
  async listForRule(accountId: number, ruleId: number, q: { limit: number; cursor?: string }) {
    return this.db.tx(async (c) => {
      const rule = await c.query('SELECT 1 FROM alert_rules WHERE id = $1 AND owner_account_id = $2 AND deleted_at IS NULL', [ruleId, accountId]);
      if (!rule.rowCount) throw errors.notFound();
      return listRuleIncidents(c, ruleId, q.limit, q.cursor);
    });
  }

  /**
   * 사건 상세(UI-09). 발화 때의 규칙 이름·조건·구간·임계와, 그 뒤 규칙이 바뀌었거나 지워졌는지(`rule.status`: `same`·`changed`·`deleted`),
   * 수신자별 전달 상태를 준다. 조건이 가리키는 서비스·서버·연결은 지금 이름으로 준다. 규칙을 지워도 사건은 남는다(UI-07).
   */
  async detail(accountId: number, ref: string) {
    return this.db.tx(async (c) => {
      const row = await this.find(c, accountId, ref);
      if (!row) throw errors.notFound();
      const deliveries = (
        await c.query(
          `SELECT recipient, state, attempts, ${utc('last_attempt_at')} AS last_attempt_at, ${utc('accepted_at')} AS accepted_at,
                  last_error, sent_after_resolve, cancel_reason, ${utc('acknowledged_at')} AS acknowledged_at
             FROM mail_jobs WHERE incident_id = $1 ORDER BY lower(recipient), id`,
          [row.id],
        )
      ).rows;
      const refs = await loadReferences(c, [row.condition]);
      return {
        ...incidentItem(row),
        rule: { id: row.rule_id, name: row.current_name, status: row.rule_status },
        at_fire: {
          rule_name: row.rule_name,
          condition: row.condition,
          ...resolveReferences(row.condition, refs),
          window_minutes: row.window_minutes,
          threshold: row.threshold,
        },
        deliveries,
      };
    });
  }

  /** 그 사건의 최종 실패를 사람이 확인했다(WQ-49). 확인한 수를 준다. 확인은 메일 작업에 남고 감사 대상이 아니다(5.6절). */
  async ackFinalFailures(accountId: number, ref: string) {
    return this.db.tx(async (c) => {
      const row = await this.find(c, accountId, ref);
      if (!row) throw errors.notFound();
      const r = await c.query(
        `UPDATE mail_jobs SET acknowledged_at = now() WHERE incident_id = $1 AND state = 'failed' AND acknowledged_at IS NULL`,
        [row.id],
      );
      return { id: row.public_ref, acknowledged: r.rowCount ?? 0 };
    });
  }

  private async find(c: Queryable, accountId: number, ref: string) {
    return (
      await c.query<IncidentRow & { current_name: string; rule_status: 'same' | 'changed' | 'deleted' }>(
        `SELECT ${INCIDENT_COLUMNS}, r.name AS current_name,
                CASE WHEN r.deleted_at IS NOT NULL THEN 'deleted'
                     WHEN r.condition_version <> i.condition_version THEN 'changed'
                     ELSE 'same' END AS rule_status
           FROM alert_incidents i JOIN alert_rules r ON r.id = i.rule_id
          WHERE i.public_ref = $1 AND r.owner_account_id = $2`,
        [ref, accountId],
      )
    ).rows[0];
  }
}
