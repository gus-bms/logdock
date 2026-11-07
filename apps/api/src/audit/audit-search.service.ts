// 감사 이력 조회(계약 4.3·5.6절, UI-15, Q10-12·13·14). 기간과 동작 종류로 거르고, 조회 가능 시작과 조기 정리 구간, 기록 공백
// 구간을 함께 준다. 감사 값은 데이터로만 돌려주고 화면이 글자로만 보인다(PT-20). 읽지 못하면 `503 audit_unavailable`이다.
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { ApiError, errors } from '../common/api-error.js';
import { Database, utc } from '../db/database.js';
import { isRfc3339 } from '../search/condition.js';

export const AuditSearchBody = z.object({
  /** 이 시각 이상(오프셋을 담은 RFC 3339). */
  from: z.string().optional(),
  /** 이 시각 미만. */
  to: z.string().optional(),
  /** 5.6절 동작 코드(예: `connection.archive`). 주면 그 가운데 하나인 행만 준다. */
  actions: z.array(z.string().regex(/^[a-z_]+\.[a-z_]+$/)).max(50).optional(),
  result: z.enum(['success', 'failure', 'partial']).optional(),
  target_type: z.string().max(64).optional(),
  target_ref: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().max(512).optional(),
});
export type AuditSearchBody = z.infer<typeof AuditSearchBody>;

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

@Injectable()
export class AuditSearchService {
  constructor(private readonly db: Database) {}

  /** 최신순(같으면 ID 역순)으로 나눠 준다. 조기 정리 구간은 최근 20건, 공백 구간은 고른 기간에 걸친 것(기간이 없으면 최근) 50건이다. */
  async search(q: AuditSearchBody) {
    const problems: { path: string; reason: string }[] = [];
    for (const key of ['from', 'to'] as const) if (q[key] !== undefined && !isRfc3339(q[key]!)) problems.push({ path: key, reason: 'time_invalid' });
    if (problems.length) throw errors.validation(problems);
    const values: unknown[] = [];
    const where: string[] = [];
    const add = (sql: (p: string) => string, v: unknown) => {
      values.push(v);
      where.push(sql(`$${values.length}`));
    };
    if (q.from) add((p) => `a.logged_at >= ${p}::timestamptz`, q.from);
    if (q.to) add((p) => `a.logged_at < ${p}::timestamptz`, q.to);
    if (q.actions?.length) add((p) => `a.action = ANY(${p}::text[])`, q.actions);
    if (q.result) add((p) => `a.result = ${p}`, q.result);
    if (q.target_type) add((p) => `a.target_type = ${p}`, q.target_type);
    if (q.target_ref) add((p) => `a.target_ref = ${p}`, q.target_ref);
    if (q.cursor) {
      const [at, id] = parseCursor(q.cursor);
      values.push(at, id);
      where.push(`(a.logged_at, a.id) < ($${values.length - 1}::timestamptz, $${values.length}::bigint)`);
    }
    const limit = q.limit ?? 50;
    values.push(limit + 1);
    try {
      return await this.db.tx(async (c) => {
        if (q.from && q.to) {
          const ordered = (await c.query<{ ok: boolean }>('SELECT $1::timestamptz < $2::timestamptz AS ok', [q.from, q.to])).rows[0].ok;
          if (!ordered) throw errors.validation([{ path: 'to', reason: 'not_after_from' }]);
        }
        const r = await c.query<{ id: string; logged_at: string }>(
          `SELECT a.id::text, ${utc('a.logged_at')} AS logged_at, a.time_trusted, a.actor_type, a.account_id, acc.name AS account_name,
                  a.action, a.target_type, a.target_ref, a.result, a.stage, a.changed_fields, a.reason_code, a.event_count
             FROM audit_log a LEFT JOIN accounts acc ON acc.id = a.account_id
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY a.logged_at DESC, a.id DESC LIMIT $${values.length}`,
          values,
        );
        const rows = r.rows.slice(0, limit);
        const last = rows[rows.length - 1];
        const available = (await c.query<{ at: string | null }>(`SELECT ${utc('min(logged_at)')} AS at FROM audit_log`)).rows[0].at;
        const cleanups = (
          await c.query(
            `SELECT ${utc('cleaned_at')} AS cleaned_at, ${utc('removed_from')} AS removed_from, ${utc('removed_to')} AS removed_to,
                    removed_rows::float8 AS removed_rows, early
               FROM audit_cleanups ORDER BY cleaned_at DESC LIMIT 20`,
          )
        ).rows;
        const gaps = (
          await c.query(
            `SELECT ${utc('started_at')} AS started_at, ${utc('ended_at')} AS ended_at FROM audit_gaps
              WHERE ($1::timestamptz IS NULL OR ended_at IS NULL OR ended_at >= $1) AND ($2::timestamptz IS NULL OR started_at < $2)
              ORDER BY started_at DESC LIMIT 50`,
            [q.from ?? null, q.to ?? null],
          )
        ).rows;
        return {
          items: rows,
          next_cursor: r.rows.length > limit ? Buffer.from(JSON.stringify([last.logged_at, last.id])).toString('base64url') : null,
          available_from: available,
          cleanups,
          gaps,
        };
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw errors.auditUnavailable();
    }
  }
}
