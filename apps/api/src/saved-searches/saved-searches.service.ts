// 저장 검색(계약 4.3절, Q11, UI-05). 공용 계정이 함께 쓰는 목록 하나다(F07). 업무 설정이 아니라 조사 조건이라 감사에 남기지
// 않고 재확인도 받지 않는다(5.6절). 조건은 검색·알림 규칙과 같은 구조화 형식이고(SD-30) 시간은 고른 방식을 그대로 둔다(Q11).
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { z } from 'zod';

import { sha256 } from '../auth/tokens.js';
import { errors } from '../common/api-error.js';
import { claimIdempotency, completeIdempotency } from '../common/idempotency.js';
import type { AppConfig } from '../config.js';
import type { FieldProblem } from '../connections/connection-input.js';
import { Database, lockCount, type Queryable, utc } from '../db/database.js';
import {
  checkCondition,
  checkConditionReferences,
  checkStoredName,
  checkTime,
  type Condition,
  ConditionSchema,
  normalizeTime,
  type TimeRange,
  TimeSchema,
} from '../search/condition.js';
import { loadReferences, type ReferenceMaps, resolveReferences, type ResolvedReferences } from '../search/references.js';
import { APP_CONFIG } from '../tokens.js';

export const CreateBody = z.object({ name: z.string(), condition: ConditionSchema, time: TimeSchema });
export type CreateBody = z.infer<typeof CreateBody>;

export const UpdateBody = z.object({
  version: z.number().int().positive(),
  /** 다른 사람이 먼저 고쳤다는 경고(409 version_conflict)를 본 뒤 덮어쓴다(Q11 설계 기본값). */
  force: z.boolean().optional(),
  name: z.string().optional(),
  condition: ConditionSchema.optional(),
  time: TimeSchema.optional(),
});
export type UpdateBody = z.infer<typeof UpdateBody>;

interface Row {
  id: number;
  name: string;
  sort_name: string;
  condition: Condition;
  time_mode: 'relative' | 'absolute';
  time_range: { last?: string; from?: string; to?: string };
  time_basis: 'occurred' | 'received';
  created_at: string;
  updated_at: string;
  version: number;
}

const COLUMNS = `id, name, lower(name) AS sort_name, condition, time_mode, time_range, time_basis,
                 ${utc('created_at')} AS created_at, ${utc('updated_at')} AS updated_at, version`;

export interface SavedSearchView {
  id: number;
  name: string;
  condition: Condition;
  time: TimeRange;
  /** 조건이 가리키는 서비스·서버·수집 연결의 지금 이름과 상태. 화면이 조건 요약을 만든다(UI-05). */
  references: ResolvedReferences;
  /** 보관된 서비스·연결을 출처로 쓴다. 화면은 실행 전에 경고한다(Q11 설계 기본값, UI-05). */
  references_archived: boolean;
  created_at: string;
  updated_at: string;
  version: number;
}

function timeOf(r: Row): TimeRange {
  return r.time_mode === 'relative'
    ? { mode: 'relative', last: r.time_range.last!, basis: r.time_basis }
    : { mode: 'absolute', from: r.time_range.from!, to: r.time_range.to!, basis: r.time_basis };
}

function rangeOf(t: TimeRange): Record<string, string> {
  return t.mode === 'relative' ? { last: t.last } : { from: t.from, to: t.to };
}

function view(r: Row, refs: ReferenceMaps): SavedSearchView {
  return {
    id: r.id,
    name: r.name,
    condition: r.condition,
    time: timeOf(r),
    ...resolveReferences(r.condition, refs),
    created_at: r.created_at,
    updated_at: r.updated_at,
    version: r.version,
  };
}

function cursorOf(r: Row): string {
  return Buffer.from(JSON.stringify([r.sort_name, r.id])).toString('base64url');
}

function parseCursor(s: string): [string, number] {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1])) return v as [string, number];
  } catch {
    // 아래에서 입력 오류로 돌려준다
  }
  throw errors.validation([{ path: 'cursor', reason: 'invalid' }]);
}

/** DB를 보지 않고 확인한 입력. 준 칸만 담는다. */
interface Checked {
  name?: string;
  condition?: Condition;
  time?: TimeRange;
}

@Injectable()
export class SavedSearchesService {
  constructor(
    private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * 이름순(대소문자 무시), 같으면 ID 순이다. 불투명한 cursor로 나눠 받는다(4.1절 목록 나누기). 화면이 상한 도달을 그릴 수
   * 있게 전체 개수(`total`)와 상한(`limit`)을 함께 준다(UI-05).
   */
  async list(accountId: number, q: { limit: number; cursor?: string }) {
    const values: unknown[] = [accountId];
    let where = 'owner_account_id = $1';
    if (q.cursor) {
      const [name, id] = parseCursor(q.cursor);
      values.push(name, id);
      where += ' AND (lower(name), id) > ($2, $3)';
    }
    values.push(q.limit + 1);
    return this.db.tx(async (c) => {
      const r = await c.query<Row>(`SELECT ${COLUMNS} FROM saved_searches WHERE ${where} ORDER BY lower(name), id LIMIT $${values.length}`, values);
      const rows = r.rows.slice(0, q.limit);
      const total = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM saved_searches WHERE owner_account_id = $1', [accountId])).rows[0].n;
      const refs = await loadReferences(c, rows.map((x) => x.condition));
      return {
        items: rows.map((x) => view(x, refs)),
        next_cursor: r.rows.length > q.limit ? cursorOf(rows[rows.length - 1]) : null,
        total,
        limit: this.config.savedSearchLimit,
      };
    });
  }

  async get(accountId: number, id: number): Promise<SavedSearchView> {
    return this.db.tx(async (c) => {
      const row = await this.find(c, accountId, id);
      if (!row) throw errors.notFound();
      return this.viewOf(c, row);
    });
  }

  /**
   * 만들기(UI-02 `조건 저장`). Idempotency-Key가 필요하고 같은 키로 다시 받으면 만든 저장 검색의 지금 값을 돌려준다.
   * 이름이 겹치면(대소문자 무시) `409 name_taken`, 개수 상한이면 `409 limit_reached`다(Q11-03).
   */
  async create(body: CreateBody, idemKey: string, accountId: number): Promise<SavedSearchView> {
    const input = this.check(body) as Required<Checked>;
    const requestHash = sha256('saved_search.create', JSON.stringify(input));
    return this.mapNameTaken(() =>
      this.db.tx(async (c) => {
        const claim = await claimIdempotency(c, accountId, idemKey, 'saved_search.create', requestHash);
        if (claim.kind === 'replay') {
          const row = await this.find(c, accountId, Number(claim.result.saved_search_id));
          if (!row) throw errors.notFound();
          return this.viewOf(c, row);
        }
        await lockCount(c, 'savedSearches', accountId);
        const time = (await this.checkStored(c, input.condition, input.time))!;
        const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM saved_searches WHERE owner_account_id = $1', [accountId])).rows[0].n;
        if (n >= this.config.savedSearchLimit) throw errors.limitReached(this.config.savedSearchLimit);
        const row = (
          await c.query<Row>(
            `INSERT INTO saved_searches (owner_account_id, name, condition, time_mode, time_range, time_basis)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
            [accountId, input.name, input.condition, time.mode, rangeOf(time), time.basis],
          )
        ).rows[0];
        await completeIdempotency(c, accountId, idemKey, 201, { saved_search_id: row.id });
        return this.viewOf(c, row);
      }),
    );
  }

  /**
   * 이름·조건·시간 수정(Q11-01). 준 칸만 바꾸고 조건과 시간은 통째로 바꾼다. 읽을 때 받은 `version`이 다르면
   * `409 version_conflict`와 지금 값이고, 사용자가 확인하면 `force: true`로 덮어쓴다. 바뀐 것이 없으면 version을 올리지 않는다.
   */
  async update(id: number, body: UpdateBody, accountId: number): Promise<SavedSearchView> {
    const patch = this.check(body);
    return this.mapNameTaken(() =>
      this.db.tx(async (c) => {
        const row = (await c.query<Row>(`SELECT ${COLUMNS} FROM saved_searches WHERE id = $1 AND owner_account_id = $2 FOR UPDATE`, [id, accountId])).rows[0];
        if (!row) throw errors.notFound();
        if (!body.force && row.version !== body.version) throw errors.versionConflict({ ...(await this.viewOf(c, row)) });
        const time = (await this.checkStored(c, patch.condition, patch.time)) ?? timeOf(row);
        const name = patch.name ?? row.name;
        const condition = patch.condition ?? row.condition;
        // 값이 그대로면 고치지 않는다. jsonb 비교라 키 순서는 상관없다.
        const updated = (
          await c.query<Row>(
            `UPDATE saved_searches
                SET name = $3, condition = $4, time_mode = $5, time_range = $6, time_basis = $7, updated_at = now(), version = version + 1
              WHERE id = $1 AND owner_account_id = $2
                AND (name IS DISTINCT FROM $3 OR condition IS DISTINCT FROM $4::jsonb OR time_mode IS DISTINCT FROM $5
                     OR time_range IS DISTINCT FROM $6::jsonb OR time_basis IS DISTINCT FROM $7)
              RETURNING ${COLUMNS}`,
            [id, accountId, name, condition, time.mode, rangeOf(time), time.basis],
          )
        ).rows[0];
        return this.viewOf(c, updated ?? row);
      }),
    );
  }

  /** 확인 뒤 즉시 삭제한다. 복구는 없다(Q11-02). 없으면(다른 사람이 지움 포함) 404다. */
  async remove(id: number, accountId: number): Promise<void> {
    const r = await this.db.query('DELETE FROM saved_searches WHERE id = $1 AND owner_account_id = $2', [id, accountId]);
    if (!r.rowCount) throw errors.notFound();
  }

  private find(c: Queryable, accountId: number, id: number): Promise<Row | undefined> {
    return c.query<Row>(`SELECT ${COLUMNS} FROM saved_searches WHERE id = $1 AND owner_account_id = $2`, [id, accountId]).then((r) => r.rows[0]);
  }

  private async viewOf(c: Queryable, row: Row): Promise<SavedSearchView> {
    return view(row, await loadReferences(c, [row.condition]));
  }

  /** DB를 보지 않는 검사. 문제를 칸마다 모두 모아 `422 validation_failed`로 돌려준다. */
  private check(body: { name?: string; condition?: z.infer<typeof ConditionSchema>; time?: z.infer<typeof TimeSchema> }): Checked {
    const problems: FieldProblem[] = [];
    const out: Checked = {};
    if (body.name !== undefined) {
      const n = checkStoredName(body.name, this.config.nameMaxLength);
      if (n.ok) out.name = n.value;
      else problems.push({ path: 'name', reason: n.reason });
    }
    if (body.condition !== undefined) {
      const r = checkCondition(body.condition, this.config);
      if (r.ok) out.condition = r.condition;
      else problems.push(...r.problems);
    }
    if (body.time !== undefined) {
      const r = checkTime(body.time);
      if (r.ok) out.time = r.time;
      else problems.push(...r.problems);
    }
    if (problems.length) throw errors.validation(problems);
    return out;
  }

  /** DB가 필요한 검사: 가리키는 대상이 있는지와 고정 범위의 순서. 고정 범위는 UTC로 맞춘 값을 돌려준다. */
  private async checkStored(c: Queryable, condition?: Condition, time?: TimeRange): Promise<TimeRange | undefined> {
    const problems = condition ? await checkConditionReferences(c, condition) : [];
    let normalized: TimeRange | undefined;
    if (time) {
      const r = await normalizeTime(c, time);
      if (r.ok) normalized = r.time;
      else problems.push(...r.problems);
    }
    if (problems.length) throw errors.validation(problems);
    return normalized;
  }

  /** 확인과 저장 사이에 다른 요청이 같은 이름을 먼저 쓴 경우(유일 색인). */
  private async mapNameTaken<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const e = err as pg.DatabaseError;
      if (e?.code === '23505' && e.constraint === 'saved_searches_name_uq') throw errors.nameTaken('name');
      throw err;
    }
  }
}
