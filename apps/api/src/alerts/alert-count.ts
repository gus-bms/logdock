// 알림 평가 창의 건수(계약 5.4절, Q12 TD-02·TD-04·TD-13·TD-14). 미리보기(API)와 평가(worker)가 같은 질의를 쓴다.
// 창은 수신 시각 `[W-구간, W)`이고, 일치 확정 건만 세며 판정 불가는 따로 센다. 최신 조각부터 세어 예산을 넘으면 끝낸 조각까지의
// 부분 건수를 돌려준다(부분 건수가 이미 임계 이상이면 발화할 수 있다).
import { Stop } from '../search/ch-runner.js';
import type { Condition } from '../search/condition.js';
import { chOf, slicesOf } from '../search/run-time.js';
import { type Block, Params, buildFilter } from '../search/search-sql.js';

export interface WindowCount {
  matched: number;
  unknown: number;
  /** 일치한 로그의 가장 이른 검색 기준 시각(지연 도착 표시, TD-14). 없으면 null. ClickHouse 표기. */
  oldest: string | null;
  /** 예산 안에 창을 다 세지 못했다. */
  partial: boolean;
}

export type Runner = <T>(sql: string, p: Params) => Promise<T[]>;

export async function countWindow(
  logs: string,
  cond: Condition,
  win: { from: bigint; to: bigint },
  ctx: { availableFrom: string; connectionIds: number[]; blocks: Block[]; firstSliceUs: bigint },
  run: Runner,
): Promise<WindowCount> {
  const out: WindowCount = { matched: 0, unknown: 0, oldest: null, partial: false };
  for (const slice of slicesOf(win.from, win.to, 'newest', ctx.firstSliceUs)) {
    const p = new Params();
    const f = buildFilter(
      cond,
      {
        basis: 'received',
        from: rfc(slice.from),
        to: rfc(slice.to),
        receivedThrough: rfc(win.to),
        availableFrom: ctx.availableFrom,
        connectionIds: ctx.connectionIds,
        blocks: ctx.blocks,
      },
      p,
    );
    const m = f.tvl ?? '1';
    const sql = `SELECT countIf(ifNull(m, 0) = 1) AS n, countIf(isNull(m)) AS u, toString(minIf(ref_time, ifNull(m, 0) = 1)) AS oldest
FROM (SELECT ${m} AS m, ref_time FROM ${logs} WHERE ${f.where})`;
    let row: { n: string; u: string; oldest: string };
    try {
      [row] = await run<{ n: string; u: string; oldest: string }>(sql, p);
    } catch (e) {
      if (e instanceof Stop && e.why !== 'cancelled') {
        out.partial = true;
        return out;
      }
      throw e;
    }
    const n = Number(row.n);
    out.matched += n;
    out.unknown += Number(row.u);
    if (n > 0 && (out.oldest === null || row.oldest < out.oldest)) out.oldest = row.oldest;
  }
  return out;
}

function rfc(us: bigint): string {
  return chOf(us).replace(' ', 'T') + 'Z';
}
