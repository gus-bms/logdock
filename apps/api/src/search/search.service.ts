// 검색 실행(계약 4.2절, 조사 명세 3절). 실행할 때 상대 시간을 절대 범위로 고정하고 검색 가능 확정 수신 시각(SD-28)·조회 가능
// 시작(SD-33)·차단 구간(3.3절)을 함께 잡아 실행 기준으로 서버에 둔다. 목록·다음 페이지·발생량·분포·판정 불가 보기가 이
// 기준을 같이 쓴다. 장기 결과 저장이나 엔진 snapshot에 기대지 않는다. 실행 기준은 이 프로세스 메모리에 두므로 API를 다시
// 시작하면 `410 run_expired`가 되고 화면은 다시 검색을 안내한다.
import { Inject, Injectable } from '@nestjs/common';

import { ClickHouse } from '../clickhouse/clickhouse.js';
import { errors } from '../common/api-error.js';
import type { AppConfig } from '../config.js';
import { CONNECTION_ROWS, observationParams } from '../connections/connection-views.service.js';
import { decodeConnectionId, encodeConnectionId } from '../connections/public-id.js';
import type { SessionInfo } from '../auth/session.service.js';
import { Database } from '../db/database.js';
import { APP_CONFIG } from '../tokens.js';
import { type Budget, ChRunner, type Status, type Track, stopStatus } from './ch-runner.js';
import { type Condition, type TimeRange, checkBodyRange, checkCondition, checkConditionReferences, checkTime, normalizeTime } from './condition.js';
import { bucketIntervalOf, chOf, durationUs, rfcOf, type Slice, slicesOf, usOf, usOfCh } from './run-time.js';
import type { SearchBody } from './search-input.js';
import { type ListRow, RowPresenter, listColumns } from './rows.js';
import { loadBlocks, loadLimits } from './scope.js';
import { Params, type Position, type Scope, afterPosition, buildFilter, orderBy, timeColumn } from './search-sql.js';

type Sort = 'newest' | 'oldest';

interface Run {
  id: string;
  sessionKey: string;
  requestKey: string;
  condition: Condition;
  scope: Scope;
  sort: Sort;
  pageSize: number;
  searchableUnknown: boolean;
  expiresAt: number;
  /** 지금 도는 요청의 취소 장치와 ClickHouse 질의 ID. 취소(CM-04)가 함께 멈춘다. */
  inflight: Set<Track>;
}

/** 커서(SD-27). 마지막 행 위치(`row`) 또는 실행 예산으로 멈춘 조각 경계(`edge`)를 담는다. 실행 기준은 서버에 있다. */
interface Cursor {
  r: string;
  k: 'row' | 'edge';
  /** ClickHouse 표기 시각. */
  t: string;
  c?: number;
  g?: number;
  s?: string;
  /** 판정 불가 보기의 커서인지. */
  u?: boolean;
}

@Injectable()
export class SearchService {
  private readonly runs = new Map<string, Run>();

  constructor(
    private readonly db: Database,
    private readonly runner: ChRunner,
    private readonly rowsOut: RowPresenter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get ch(): ClickHouse {
    return this.runner.ch;
  }

  /** 검색 실행. 실행 기준을 정해 두고 목록 첫 페이지를 돌려준다. */
  async start(session: SessionInfo, body: SearchBody) {
    const cfg = this.config.searchRun;
    const pageSize = body.page_size ?? cfg.pageSizeDefault;
    if (pageSize > cfg.pageSizeMax) throw errors.validation([{ path: 'page_size', reason: 'too_big' }]);
    const checked = checkCondition(body.condition, this.config);
    const time = checkTime(body.time);
    const problems = [...(checked.ok ? [] : checked.problems), ...(time.ok ? [] : time.problems)];
    if (!checked.ok || !time.ok) throw errors.conditionInvalid(problems);
    const condition = checked.condition;
    // 읽기만 하지만 검사 함수가 연결 하나를 받으므로 트랜잭션 안에서 부른다.
    const normalized = await this.db.tx(async (c) => {
      const refProblems = await checkConditionReferences(c, condition);
      if (refProblems.length) throw errors.conditionInvalid(refProblems);
      const n = await normalizeTime(c, time.time);
      if (!n.ok) throw errors.conditionInvalid(n.problems);
      const range = checkBodyRange(condition, n.time, this.config.search.bodyMaxRangeDays);
      if (range.length) throw errors.conditionInvalid(range);
      return n.time;
    });

    const sessionKey = session.idHash.toString('hex');
    const requestKey = JSON.stringify([condition, body.time, body.sort ?? 'newest', pageSize]);
    const existing = this.runs.get(body.run_id);
    let run: Run;
    if (existing && existing.sessionKey === sessionKey && existing.requestKey === requestKey && existing.expiresAt > Date.now()) {
      // 같은 실행을 다시 보냈다(재시도). 정한 기준으로 다시 돌린다.
      run = existing;
    } else {
      if (existing) this.cancelInflight(existing);
      run = await this.newRun(body.run_id, sessionKey, requestKey, condition, normalized, body.sort ?? 'newest', pageSize);
    }
    return this.gated(run, async (budget, track) => {
      const page = await this.list(run, null, false, budget, track);
      const unknownCount = page.status === 'cancelled' ? null : await this.countUnknown(run, budget, track);
      const issues = await this.collectionIssues(run, budget, track);
      return {
        run_id: run.id,
        ...this.basis(run),
        ...page,
        unknown_count: unknownCount,
        collection_issues: issues,
      };
    });
  }

  /** `더 보기`(SD-27). */
  async page(session: SessionInfo, runId: string, cursor: string) {
    const run = this.runOf(session, runId);
    const pos = this.decodeCursor(run, cursor, false);
    return this.gated(run, async (budget, track) => ({ run_id: run.id, ...this.basis(run), ...(await this.list(run, pos, false, budget, track)) }));
  }

  /** 판정 불가로 뺀 로그 보기(SD-22, WQ-06). 커서가 없으면 처음부터다. */
  async unknown(session: SessionInfo, runId: string, cursor: string | undefined) {
    const run = this.runOf(session, runId);
    const pos = cursor ? this.decodeCursor(run, cursor, true) : null;
    return this.gated(run, async (budget, track) => ({ run_id: run.id, ...this.basis(run), ...(await this.list(run, pos, true, budget, track)) }));
  }

  /**
   * 시간별 발생량(Q08-08, SD-29). 표본 없이 정확히 센다. 구간 경계는 표시 시간대에 맞추고, 실행 예산을 넘으면 끝낸 구간만
   * 건수를 주고 나머지는 `null`(미확인)이다. 조각 경계를 구간 경계에 맞춰 한 구간이 끝낸 쪽과 못 끝낸 쪽으로 갈리지 않게 한다.
   */
  async histogram(session: SessionInfo, runId: string) {
    const run = this.runOf(session, runId);
    return this.gated(run, async (budget, track) => {
      const from = usOf(run.scope.from);
      const to = usOf(run.scope.to);
      const interval = bucketIntervalOf(from, to, this.config.searchRun.histogramBuckets);
      const tz = this.config.displayTimezone;
      let starts: number[];
      try {
        starts = await this.bucketStarts(from, to, interval, tz, budget, track);
      } catch (e) {
        if (this.stopStatus(e) === 'cancelled') return { run_id: run.id, ...this.basis(run), status: 'cancelled' as Status, timezone: tz, interval: null, buckets: [], completed_range: null };
        throw errors.searchTimeout();
      }
      const counts = new Map<number, number>();
      let doneFrom = to;
      let status: Status = 'complete';
      try {
        // 최신 구간부터 첫 조각 길이만큼의 구간 수로 시작해 두 배씩 늘린다.
        let size = Math.max(1, Math.ceil((this.config.searchRun.firstSliceMinutes * 60) / interval.seconds));
        for (let hiIdx = starts.length; hiIdx > 0; size *= 2) {
          const loIdx = Math.max(0, hiIdx - size);
          const slice = {
            from: loIdx === 0 ? from : BigInt(starts[loIdx]) * 1_000_000n,
            to: hiIdx === starts.length ? to : BigInt(starts[hiIdx]) * 1_000_000n,
          };
          const p = new Params();
          const f = buildFilter(run.condition, run.scope, p);
          const t = timeColumn(run.scope.basis);
          const sql = `SELECT toUnixTimestamp(toStartOfInterval(toDateTime(${t}, ${p.add('String', tz)}), INTERVAL ${interval.n} ${interval.unit})) AS b, count() AS n
FROM ${this.ch.logs}
WHERE ${f.rows}
  AND ${this.sliceWhere(run, slice, p)}
GROUP BY b`;
          for (const r of await this.query<{ b: number; n: string }>(sql, p, budget, track)) counts.set(r.b, (counts.get(r.b) ?? 0) + Number(r.n));
          doneFrom = slice.from;
          hiIdx = loIdx;
        }
      } catch (e) {
        status = this.stopStatus(e);
      }
      if (status === 'partial' && doneFrom === to) throw errors.searchTimeout();
      const buckets = starts.map((s, i) => {
        const start = BigInt(s) * 1_000_000n;
        const end = i + 1 < starts.length ? BigInt(starts[i + 1]) * 1_000_000n : to;
        const clipped = start < from ? from : start;
        return { start: rfcOf(clipped), end: rfcOf(end), count: clipped >= doneFrom ? (counts.get(s) ?? 0) : null };
      });
      return {
        run_id: run.id,
        ...this.basis(run),
        status,
        timezone: tz,
        interval: { n: interval.n, unit: interval.unit.toLowerCase(), seconds: interval.seconds },
        buckets,
        completed_range: status === 'complete' ? null : this.completed(doneFrom, to, status),
      };
    });
  }

  /** 서비스·서버·레벨별 건수(Q08-08). 같은 조각에서 판정 불가 건수도 센다. */
  async distribution(session: SessionInfo, runId: string) {
    const run = this.runOf(session, runId);
    return this.gated(run, async (budget, track) => {
      const from = usOf(run.scope.from);
      const to = usOf(run.scope.to);
      const services = new Map<number, number>();
      const servers = new Map<number | null, number>();
      const levels = new Map<string, number>();
      let unknown = 0;
      let doneFrom = to;
      let status: Status = 'complete';
      try {
        for (const slice of slicesOf(from, to, 'newest', BigInt(this.config.searchRun.firstSliceMinutes) * 60_000_000n)) {
          const p = new Params();
          const f = buildFilter(run.condition, run.scope, p);
          const m = f.tvl ?? '1';
          const sql = `SELECT service_id, server_id, toString(level) AS level, countIf(ifNull(m, 0) = 1) AS n, countIf(isNull(m)) AS u
FROM (SELECT service_id, server_id, level, ${m} AS m FROM ${this.ch.logs}
      WHERE ${f.where}
        AND ${this.sliceWhere(run, slice, p)})
GROUP BY service_id, server_id, level`;
          for (const r of await this.query<{ service_id: number; server_id: number | null; level: string; n: string; u: string }>(sql, p, budget, track)) {
            const n = Number(r.n);
            unknown += Number(r.u);
            if (n === 0) continue;
            services.set(r.service_id, (services.get(r.service_id) ?? 0) + n);
            servers.set(r.server_id, (servers.get(r.server_id) ?? 0) + n);
            levels.set(r.level, (levels.get(r.level) ?? 0) + n);
          }
          doneFrom = slice.from;
        }
      } catch (e) {
        status = this.stopStatus(e);
      }
      if (status === 'partial' && doneFrom === to) throw errors.searchTimeout();
      const names = await this.rowsOut.names([...services.keys()], [...servers.keys()].filter((x): x is number => x !== null));
      const byCount = <T extends { count: number }>(xs: T[]) => xs.sort((a, b) => b.count - a.count);
      return {
        run_id: run.id,
        ...this.basis(run),
        status,
        services: byCount([...services].map(([id, count]) => ({ id, name: names.services.get(id)?.name ?? null, archived: names.services.get(id)?.archived ?? false, count }))),
        servers: byCount([...servers].map(([id, count]) => ({ id, name: id === null ? null : (names.servers.get(id) ?? null), count }))),
        levels: byCount([...levels].map(([level, count]) => ({ level, count }))),
        unknown_count: status === 'complete' || run.condition.fields.length + run.condition.levels.length === 0 ? unknown : null,
        completed_range: status === 'complete' ? null : this.completed(doneFrom, to, status),
      };
    });
  }

  /** 실행 취소(CM-04). 도는 질의를 끊고 서버에서 멈췄는지 확인한다. 멈출 질의가 없으면 멈춘 것이다. */
  async cancel(session: SessionInfo, runId: string): Promise<{ run_id: string; server_stopped: boolean }> {
    const run = this.runOf(session, runId);
    const ids = this.cancelInflight(run);
    const stopped = await Promise.all(ids.map((id) => this.ch.kill(id)));
    return { run_id: run.id, server_stopped: stopped.every(Boolean) };
  }

  // ---- 실행 기준 ----

  private async newRun(id: string, sessionKey: string, requestKey: string, condition: Condition, time: TimeRange, sort: Sort, pageSize: number): Promise<Run> {
    const cfg = this.config.searchRun;
    const limits = await loadLimits(this.db, this.config);
    const now = limits.now;
    const [from, to] = time.mode === 'relative' ? [now - durationUs(time.last), now] : [usOf(time.from), usOf(time.to)];
    const connectionIds = condition.sources.connection_ids.map((x) => decodeConnectionId(x)!);
    // 수신 시각 기준이면 검색 기준 시각 범위를 알 수 없으므로 그 연결들의 차단 구간을 모두 뺀다.
    const blocks = await loadBlocks(this.db, connectionIds, time.basis === 'received' ? null : { from: rfcOf(from), to: rfcOf(to) });
    const run: Run = {
      id,
      sessionKey,
      requestKey,
      condition,
      scope: { basis: time.basis, from: rfcOf(from), to: rfcOf(to), receivedThrough: limits.receivedThrough, availableFrom: limits.availableFrom, connectionIds, blocks },
      sort,
      pageSize,
      searchableUnknown: limits.searchableUnknown,
      expiresAt: Date.now() + cfg.keepMinutes * 60_000,
      inflight: new Set(),
    };
    this.prune();
    this.runs.set(id, run);
    return run;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, run] of this.runs) if (run.expiresAt <= now && run.inflight.size === 0) this.runs.delete(id);
    while (this.runs.size >= this.config.searchRun.maxRuns) {
      const oldest = this.runs.keys().next().value!;
      this.cancelInflight(this.runs.get(oldest)!);
      this.runs.delete(oldest);
    }
  }

  /** 실행 기준을 찾는다. 없거나 지났거나 다른 세션의 것이면 같은 `410 run_expired`다(다른 세션의 실행을 드러내지 않는다). */
  private runOf(session: SessionInfo, runId: string): Run {
    const run = this.runs.get(runId);
    if (!run || run.sessionKey !== session.idHash.toString('hex') || run.expiresAt <= Date.now()) throw errors.runExpired();
    return run;
  }

  private basis(run: Run) {
    return {
      applied: { from: run.scope.from, to: run.scope.to, basis: run.scope.basis, timezone: this.config.displayTimezone },
      received_through: run.scope.receivedThrough,
      available_from: run.scope.availableFrom,
    };
  }

  // ---- 동시 실행과 취소 ----

  /** 동시 검색 상한(4.2절)을 지키며 실행 예산 안에서 돌린다. 요청을 실행 기준에 등록해 취소가 함께 멈추게 한다. */
  private gated<T>(run: Run, fn: (budget: Budget, track: Track) => Promise<T>): Promise<T> {
    return this.runner.gate(run.sessionKey, fn, (track) => {
      run.inflight.add(track);
      return () => run.inflight.delete(track);
    });
  }

  private cancelInflight(run: Run): string[] {
    const ids: string[] = [];
    for (const e of run.inflight) {
      e.abort.abort();
      ids.push(...e.queryIds);
    }
    return ids;
  }

  private query<T>(sql: string, p: Params, budget: Budget, track: Track): Promise<T[]> {
    return this.runner.query<T>(sql, p, budget, track);
  }

  private stopStatus(e: unknown): Status {
    return stopStatus(e);
  }

  private completed(doneFrom: bigint, to: bigint, status: Status) {
    return { from: rfcOf(doneFrom), to: rfcOf(to), reason: status === 'cancelled' ? 'cancelled' : 'budget' };
  }

  // ---- 목록 ----

  private sliceWhere(run: Run, slice: Slice, p: Params): string {
    const t = timeColumn(run.scope.basis);
    return `${t} >= ${p.add("DateTime64(6, 'UTC')", chOf(slice.from))} AND ${t} < ${p.add("DateTime64(6, 'UTC')", chOf(slice.to))}`;
  }

  /**
   * 목록 한 페이지. 커서 위치부터 정렬 방향으로 조각을 나눠 읽고 페이지가 차면 멈춘다. 예산을 넘으면 끝낸 조각까지의 행과
   * 그 경계에서 이어 읽는 커서를 돌려준다(부분 결과).
   */
  private async list(run: Run, pos: Cursor | null, unknownOnly: boolean, budget: Budget, track: Track) {
    const from = usOf(run.scope.from);
    const to = usOf(run.scope.to);
    let lo = from;
    let hi = to;
    let after: Position | null = null;
    if (pos) {
      const t = usOfCh(pos.t);
      if (run.sort === 'newest') hi = pos.k === 'row' ? t + 1n : t;
      else lo = t;
      if (pos.k === 'row') after = { t: pos.t, c: pos.c!, g: pos.g!, s: pos.s! };
    }
    const rows: ListRow[] = [];
    const want = run.pageSize + 1;
    let status: Status = 'complete';
    let edge: bigint | null = null;
    const startEdge = run.sort === 'newest' ? hi : lo;
    try {
      for (const slice of slicesOf(lo, hi, run.sort, BigInt(this.config.searchRun.firstSliceMinutes) * 60_000_000n)) {
        const p = new Params();
        const f = buildFilter(run.condition, run.scope, p);
        if (unknownOnly && !f.tvl) break;
        const n = this.config.searchRun.bodySummaryChars;
        const where = [unknownOnly ? f.unknown : f.rows, this.sliceWhere(run, slice, p)];
        if (after) where.push(afterPosition(run.scope.basis, run.sort, after, p));
        const limit = p.add('UInt32', want - rows.length);
        const chars = p.add('UInt32', n);
        const sql = `SELECT ${listColumns(chars)}
FROM ${this.ch.logs}
WHERE ${where.join('\n  AND ')}
ORDER BY ${orderBy(run.scope.basis, run.sort)}
LIMIT ${limit}`;
        rows.push(...(await this.query<ListRow>(sql, p, budget, track)));
        edge = run.sort === 'newest' ? slice.from : slice.to;
        if (rows.length >= want) break;
      }
    } catch (e) {
      status = this.stopStatus(e);
    }
    if (status === 'partial' && edge === null) throw errors.searchTimeout();
    const page = rows.slice(0, run.pageSize);
    let next: string | null = null;
    if (rows.length > run.pageSize) {
      const last = page[page.length - 1];
      const t = run.scope.basis === 'occurred' ? last.ref_time : last.received_at;
      next = this.encodeCursor(run, { r: '', k: 'row', t, c: last.connection_id, g: last.generation, s: last.seq, u: unknownOnly || undefined });
    } else if (status !== 'complete') {
      const at = edge ?? startEdge;
      const more = run.sort === 'newest' ? at > from : at < to;
      if (more) next = this.encodeCursor(run, { r: '', k: 'edge', t: chOf(at), u: unknownOnly || undefined });
    }
    const done = edge ?? startEdge;
    return {
      status,
      rows: await this.rowsOut.present(page),
      next_cursor: next,
      completed_range:
        status === 'complete'
          ? null
          : run.sort === 'newest'
            ? { from: rfcOf(done), to: rfcOf(startEdge), reason: status === 'cancelled' ? 'cancelled' : 'budget' }
            : { from: rfcOf(startEdge), to: rfcOf(done), reason: status === 'cancelled' ? 'cancelled' : 'budget' },
    };
  }

  /** 판정 불가 건수(SD-22). 예산 안에 다 세지 못하면 null(미확인)이다. */
  private async countUnknown(run: Run, budget: Budget, track: Track): Promise<number | null> {
    if (run.condition.fields.length === 0 && (run.condition.levels.length === 0 || run.condition.levels.includes('UNKNOWN'))) return 0;
    let n = 0;
    try {
      for (const slice of slicesOf(usOf(run.scope.from), usOf(run.scope.to), 'newest', BigInt(this.config.searchRun.firstSliceMinutes) * 60_000_000n)) {
        const p = new Params();
        const f = buildFilter(run.condition, run.scope, p);
        const sql = `SELECT count() AS n FROM ${this.ch.logs} WHERE ${f.unknown}\n  AND ${this.sliceWhere(run, slice, p)}`;
        n += Number((await this.query<{ n: string }>(sql, p, budget, track))[0].n);
      }
    } catch (e) {
      this.stopStatus(e);
      return null;
    }
    return n;
  }

  /**
   * 선택한 출처의 수집 문제 요약(SD-32). 관측 상태는 관리 DB의 연결 상태이고, 크기 초과 거부 건수는 범위 안의 거부 기록을
   * 남은 예산 안에서 센다(못 세면 null). 정상 수집(`collecting`·`observed_no_logs`)만 있는 연결은 넣지 않는다.
   */
  private async collectionIssues(run: Run, budget: Budget, track: Track) {
    const s = run.condition.sources;
    const params = observationParams(this.config);
    const rows = (
      await this.db.query<{ id: number; observation: string[] }>(
        `SELECT id, observation FROM (${CONNECTION_ROWS}) c
          WHERE (cardinality($3::int[]) = 0 OR service_id = ANY($3))
            AND (cardinality($4::int[]) = 0 OR server_id = ANY($4) OR ($5 AND server_id IS NULL))
            AND (cardinality($6::text[]) = 0 OR environment = ANY($6) OR ($7 AND environment IS NULL))
            AND (cardinality($8::int[]) = 0 OR id = ANY($8))
          ORDER BY id`,
        [
          ...params,
          s.service_ids,
          s.server_ids.filter((x) => x !== null),
          s.server_ids.includes(null),
          s.environments.filter((x) => x !== null),
          s.environments.includes(null),
          run.scope.connectionIds,
        ],
      )
    ).rows;
    const normal = new Set(['collecting', 'observed_no_logs']);
    const connections = rows
      .filter((r) => r.observation.some((x) => !normal.has(x)))
      .map((r) => ({ connection_id: encodeConnectionId(r.id), states: r.observation }));
    let rejected: number | null = 0;
    try {
      const p = new Params();
      const f = buildFilter({ ...run.condition, levels: [], body: [], fields: [] }, run.scope, p, 'rejected');
      const sql = `SELECT count() AS n FROM ${this.ch.logs} WHERE ${f.where}`;
      rejected = Number((await this.query<{ n: string }>(sql, p, budget, track))[0].n);
    } catch (e) {
      this.stopStatus(e);
      rejected = null;
    }
    return { connections, rejected_count: rejected, searchable_unknown: run.searchableUnknown };
  }

  /**
   * 표시 시간대에 맞춘 구간 시작(유닉스 초)을 범위 전체에 대해 만든다. 하루 단위는 일광 절약 시간에도 그 시간대의 자정이다.
   * 로그 테이블을 읽지 않는 계산 질의라 예산을 거의 쓰지 않는다.
   */
  private async bucketStarts(from: bigint, to: bigint, interval: ReturnType<typeof bucketIntervalOf>, tz: string, budget: Budget, track: Track): Promise<number[]> {
    const p = new Params();
    const lo = p.add('UInt32', Number(from / 1_000_000n));
    const hi = p.add('UInt32', Number((to + 999_999n) / 1_000_000n));
    const zone = p.add('String', tz);
    // 채우기는 시각 열에 하고, 출력만 유닉스 초로 받는다(`date_time_output_format`).
    const sql = `SELECT toStartOfInterval(toDateTime(${lo}, ${zone}), INTERVAL ${interval.n} ${interval.unit}) AS b
ORDER BY b WITH FILL TO toDateTime(${hi}, ${zone}) STEP INTERVAL ${interval.n} ${interval.unit}
SETTINGS date_time_output_format = 'unix_timestamp'`;
    return (await this.query<{ b: number | string }>(sql, p, budget, track)).map((r) => Number(r.b)).filter((b) => BigInt(b) * 1_000_000n < to);
  }

  // ---- 커서 ----

  private encodeCursor(run: Run, c: Cursor): string {
    return Buffer.from(JSON.stringify({ ...c, r: run.id.slice(0, 8) })).toString('base64url');
  }

  private decodeCursor(run: Run, raw: string, unknownOnly: boolean): Cursor {
    let c: Cursor;
    try {
      c = JSON.parse(Buffer.from(raw, 'base64url').toString()) as Cursor;
    } catch {
      throw errors.validation([{ path: 'cursor', reason: 'cursor_invalid' }]);
    }
    const ok =
      c && c.r === run.id.slice(0, 8) && (c.k === 'row' || c.k === 'edge') && typeof c.t === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(c.t) &&
      Boolean(c.u) === unknownOnly &&
      (c.k === 'edge' || (Number.isInteger(c.c) && Number.isInteger(c.g) && typeof c.s === 'string' && /^\d{1,20}$/.test(c.s)));
    if (!ok) throw errors.validation([{ path: 'cursor', reason: 'cursor_invalid' }]);
    return c;
  }
}

