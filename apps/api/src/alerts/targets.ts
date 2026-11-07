// 알림 규칙의 대상 연결과 감시 품질(계약 5.4절, Q12-05, TD-18). 대상은 규칙의 출처 조건에 맞는 보관되지 않은 연결이다.
// 규칙 상세·미리보기·평가가 같은 판단을 쓴다.
import type { AppConfig } from '../config.js';
import { CONNECTION_ROWS, observationParams } from '../connections/connection-views.service.js';
import { decodeConnectionId } from '../connections/public-id.js';
import type { Database } from '../db/database.js';
import type { Condition } from '../search/condition.js';
import { sourcesOf } from '../search/references.js';

/** 관측되지 않는 대상의 관측 상태. `관측됨·무로그`와 `복구 중`은 관측되는 대상이다. */
export const UNOBSERVED = ['stale', 'send_error', 'read_paused', 'disk_unavailable', 'needs_check'];

export interface TargetRow {
  id: number;
  service_name: string;
  display_name: string | null;
  target_type: string;
  target_path: string | null;
  journald_kind: string | null;
  journald_name: string | null;
  observation: string[];
}

export async function loadTargets(c: Pick<Database, 'query'>, cond: Condition, config: AppConfig): Promise<TargetRow[]> {
  const s = sourcesOf(cond);
  const values: unknown[] = observationParams(config);
  const where = [`management_state <> 'archived'`];
  const add = (sql: (p: string) => string, v: unknown) => {
    values.push(v);
    where.push(sql(`$${values.length}`));
  };
  if (s.service_ids.length) add((p) => `service_id = ANY(${p}::int[])`, s.service_ids);
  if (s.server_ids.length) {
    const orNull = s.server_ids.includes(null) ? ' OR server_id IS NULL' : '';
    add((p) => `(server_id = ANY(${p}::int[])${orNull})`, s.server_ids.filter((x) => x !== null));
  }
  if (s.environments.length) {
    const orNull = s.environments.includes(null) ? ' OR environment IS NULL' : '';
    add((p) => `(environment = ANY(${p}::text[])${orNull})`, s.environments.filter((x) => x !== null));
  }
  if (s.connection_ids.length) add((p) => `id = ANY(${p}::int[])`, s.connection_ids.map((x) => decodeConnectionId(x)).filter((x) => x !== null));
  return (
    await c.query<TargetRow>(
      `SELECT id, service_name, display_name, target_type, target_path, journald_kind, journald_name, observation
         FROM (${CONNECTION_ROWS}) x WHERE ${where.join(' AND ')} ORDER BY lower(service_name), id`,
      values,
    )
  ).rows;
}

export type Quality = 'complete' | 'partially_unobserved' | 'unmonitorable' | 'no_targets';

/**
 * 감시 품질. 대상이 없으면 `대상 없음`(건수 0으로 평가), 관측 판단 대상이 모두 관측되지 않으면 `감시 불가`(해소 계산 정지),
 * 일부만이면 `일부 미관측`이다. `연결 대기`(수신 증거 없음)인 연결은 관측 판단에서 뺀다.
 */
export function qualityOf(rows: TargetRow[]): Quality {
  if (rows.length === 0) return 'no_targets';
  const judged = rows.filter((r) => !r.observation.every((o) => o === 'awaiting_connection'));
  const unobserved = judged.filter((r) => r.observation.some((o) => UNOBSERVED.includes(o)));
  if (judged.length > 0 && unobserved.length === judged.length) return 'unmonitorable';
  return unobserved.length > 0 ? 'partially_unobserved' : 'complete';
}
