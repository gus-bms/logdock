// 조회의 공통 상한(계약 3.3절, 4.2절). 검색 가능 확정 수신 시각(SD-28), 조회 가능 시작(SD-33), 차단 구간을 관리 DB에서 읽는다.
// 검색·상세·주변 로그·필드 이름 후보가 같은 값을 쓴다.
import type { AppConfig } from '../config.js';
import { type Database, utc } from '../db/database.js';
import { rfcOf, usOf } from './run-time.js';
import type { Block } from './search-sql.js';

export interface Limits {
  /** 지금(마이크로초). */
  now: bigint;
  /** 검색 가능이 확정된 수신 시각. 수신 서버가 쓴 값이 없으면 지금이다. 지금보다 뒤로 가지 않는다. */
  receivedThrough: string;
  /** 검색 가능 시각을 모르거나 오래 갱신되지 않았다(수집 문제 요약의 `검색 가능 미확인`). */
  searchableUnknown: boolean;
  /** 수신 서버가 쓴 검색 가능 시각의 상태. 없으면 지금을 쓴다. */
  watermark: 'ok' | 'missing' | 'stale';
  /** 조회 가능 시작(수신 시각 기준). 보관 기간(달력 달)과 조기 삭제 중 늦은 쪽이다. */
  availableFrom: string;
  /** 보관 기간만으로 정한 시작. 이보다 앞이면 보존 만료, 이 뒤인데 조회 가능 시작보다 앞이면 조기 삭제다. */
  retentionFrom: string;
}

/** 관리 DB 읽기. 풀(`Database`)이나 트랜잭션 연결 어느 쪽이든 된다. */
type Db = Pick<Database, 'query'>;

export async function loadLimits(db: Db, config: AppConfig): Promise<Limits> {
  const now = BigInt(Date.now()) * 1000n;
  const r = (
    await db.query<{ through: string | null; stale: boolean | null; available_from: string; retention_from: string }>(
      `SELECT ${utc('w.searchable_through')} AS through,
              w.updated_at < now() - make_interval(secs => $2) AS stale,
              ${utc(`greatest(now() - make_interval(months => $1), (SELECT max(received_to) FROM early_deletions))`)} AS available_from,
              ${utc('now() - make_interval(months => $1)')} AS retention_from
         FROM (SELECT 1) one LEFT JOIN ingest_watermark w ON true`,
      [config.logRetentionMonths, config.searchRun.watermarkStaleSeconds],
    )
  ).rows[0];
  let through = r.through === null ? now : usOf(r.through);
  if (through > now) through = now;
  return { now, receivedThrough: rfcOf(through), searchableUnknown: r.through === null || r.stale === true, watermark: r.through === null ? 'missing' : r.stale ? 'stale' : 'ok', availableFrom: r.available_from, retentionFrom: r.retention_from };
}

/**
 * 차단 구간(3.3절 구간 삭제). 연결을 주면 그 연결들만, 검색 기준 시각 범위를 주면 겹치는 것만 읽는다. 수신 시각 기준 검색은
 * 검색 기준 시각 범위를 모르므로 범위 없이 부른다.
 */
export async function loadBlocks(db: Db, connectionIds: number[], range: { from: string; to: string } | null): Promise<Block[]> {
  const r = await db.query<{ connection_id: number; from: string; to: string }>(
    `SELECT connection_id, ${utc('ref_time_from')} AS from, ${utc('ref_time_to')} AS to
       FROM deletion_blocks
      WHERE (cardinality($1::int[]) = 0 OR connection_id = ANY($1))
        AND ($2::timestamptz IS NULL OR (ref_time_to > $2::timestamptz AND ref_time_from < $3::timestamptz))
      ORDER BY connection_id, ref_time_from`,
    [connectionIds, range?.from ?? null, range?.to ?? null],
  );
  return r.rows.map((b) => ({ connectionId: b.connection_id, from: b.from, to: b.to }));
}
