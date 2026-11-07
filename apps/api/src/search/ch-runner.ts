// 로그 저장소 질의 실행기(계약 4.2절 동시 실행, SD-31). 검색·상세·주변 로그·필드 이름 후보가 같은 동시 실행 상한과 실행
// 예산을 쓴다. 질의마다 남은 예산을 서버 실행 상한(`max_execution_time`)으로 걸고, 설정한 자원 상한을 함께 건다.
import { Inject, Injectable } from '@nestjs/common';

import { ClickHouse, ClickHouseAborted, ClickHouseError } from '../clickhouse/clickhouse.js';
import { ApiError, errors } from '../common/api-error.js';
import type { AppConfig } from '../config.js';
import { APP_CONFIG } from '../tokens.js';
import type { Params } from './search-sql.js';

/** 요청 하나가 쓸 수 있는 시간. */
export class Budget {
  private readonly deadline: number;
  constructor(ms: number) {
    this.deadline = Date.now() + ms;
  }

  get remainingMs(): number {
    return this.deadline - Date.now();
  }
}

/** 실행을 멈춘 이유. 예산·자원 상한이면 끝낸 구간까지 부분 결과, 취소면 취소 상태가 된다. */
export class Stop extends Error {
  constructor(readonly why: 'budget' | 'cancelled' | 'resource') {
    super(why);
  }
}

/** 지금 도는 요청의 취소 장치와 ClickHouse 질의 ID. 취소(CM-04)가 함께 멈춘다. */
export interface Track {
  abort: AbortController;
  queryIds: Set<string>;
}

export type Status = 'complete' | 'partial' | 'cancelled';

/** 멈춘 이유를 응답 상태로 바꾼다. 멈춤이 아닌 오류는 그대로 던진다. */
export function stopStatus(e: unknown): Status {
  if (e instanceof Stop) return e.why === 'cancelled' ? 'cancelled' : 'partial';
  throw e;
}

@Injectable()
export class ChRunner {
  private running = 0;
  private readonly perSession = new Map<string, number>();

  constructor(
    readonly ch: ClickHouse,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * 동시 실행 상한(설치 전체·세션마다)을 지키며 실행 예산 안에서 돌린다. 넘으면 `429 search_busy`다. `onTrack`은 취소가
   * 이 요청을 찾을 수 있게 등록하고, 돌려준 함수로 등록을 푼다.
   */
  async gate<T>(sessionKey: string, fn: (budget: Budget, track: Track) => Promise<T>, onTrack?: (track: Track) => () => void): Promise<T> {
    const cfg = this.config.searchRun;
    const mine = this.perSession.get(sessionKey) ?? 0;
    if (this.running >= cfg.maxConcurrent || mine >= cfg.maxPerSession) throw errors.searchBusy(2);
    this.running++;
    this.perSession.set(sessionKey, mine + 1);
    const track: Track = { abort: new AbortController(), queryIds: new Set() };
    const release = onTrack?.(track);
    try {
      return await fn(new Budget(cfg.budgetMs), track);
    } finally {
      release?.();
      this.running--;
      const left = (this.perSession.get(sessionKey) ?? 1) - 1;
      if (left > 0) this.perSession.set(sessionKey, left);
      else this.perSession.delete(sessionKey);
    }
  }

  /** 질의 하나. 엔진 오류 문장은 응답에 담지 않고 `503 storage_unavailable`로 바꾼다(4.5절). */
  async query<T>(sql: string, p: Params, budget: Budget, track: Track): Promise<T[]> {
    if (track.abort.signal.aborted) throw new Stop('cancelled');
    const left = budget.remainingMs;
    if (left <= 0) throw new Stop('budget');
    const cfg = this.config.searchRun;
    const settings: Record<string, string | number> = { max_execution_time: Math.max(0.1, left / 1000).toFixed(3) };
    if (cfg.maxThreads !== null) settings.max_threads = cfg.maxThreads;
    if (cfg.maxMemoryBytes !== null) settings.max_memory_usage = cfg.maxMemoryBytes;
    const queryId = this.ch.newQueryId();
    track.queryIds.add(queryId);
    try {
      return await this.ch.rows<T>(sql, { params: p.values, settings, queryId, signal: track.abort.signal, timeoutMs: left + 5000 });
    } catch (e) {
      if (e instanceof ClickHouseAborted) throw new Stop(e.reason === 'aborted' ? 'cancelled' : 'budget');
      if (e instanceof ClickHouseError) {
        if (e.timedOut) throw new Stop('budget');
        if (e.cancelled) throw new Stop('cancelled');
        if (e.code === 241) throw new Stop('resource'); // MEMORY_LIMIT_EXCEEDED
        if (e.code === 202) throw errors.searchBusy(2); // TOO_MANY_SIMULTANEOUS_QUERIES
      }
      if (e instanceof ApiError) throw e;
      throw errors.storageUnavailable();
    } finally {
      track.queryIds.delete(queryId);
    }
  }
}
