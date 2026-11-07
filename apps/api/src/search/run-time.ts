// 검색 실행의 시각 계산(계약 4.2절). 로그 시각은 마이크로초라 JS 밀리초 시각으로 다루면 같은 밀리초 안의 행이 겹치거나
// 빠진다(SD-27). 그래서 실행 범위·조각·커서는 마이크로초 정수(bigint)로 계산한다.

/** API 표기(UTC RFC 3339, 소수 6자리까지)를 마이크로초로 바꾼다. */
export function usOf(rfc: string): bigint {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(rfc);
  if (!m) throw new Error(`not a UTC RFC 3339 time: ${rfc}`);
  const ms = Date.parse(`${m[1]}Z`);
  return BigInt(ms) * 1000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/** 마이크로초를 API 표기로 바꾼다. */
export function rfcOf(us: bigint): string {
  const sec = us / 1_000_000n;
  const frac = us % 1_000_000n;
  return new Date(Number(sec) * 1000).toISOString().replace(/\.\d{3}Z$/, `.${frac.toString().padStart(6, '0')}Z`);
}

/** ClickHouse 표기(`YYYY-MM-DD HH:MM:SS.ffffff`)를 마이크로초로 바꾼다. */
export function usOfCh(ch: string): bigint {
  return usOf(ch.replace(' ', 'T') + 'Z');
}

/** 마이크로초를 ClickHouse 표기로 바꾼다. */
export function chOf(us: bigint): string {
  return rfcOf(us).replace('T', ' ').replace(/Z$/, '');
}

const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** 상대 범위의 ISO 8601 기간(일·시·분·초, 꼴 검사는 condition.ts)을 마이크로초로 바꾼다. */
export function durationUs(iso: string): bigint {
  const m = DURATION.exec(iso);
  if (!m) throw new Error(`not a duration: ${iso}`);
  const [d, h, mi, s] = m.slice(1).map((x) => BigInt(x ?? '0'));
  return (((d * 24n + h) * 60n + mi) * 60n + s) * 1_000_000n;
}

/** 실행 범위의 한 조각. 시작 포함·끝 제외. */
export interface Slice {
  from: bigint;
  to: bigint;
}

/**
 * 최신 구간부터 나눠 실행한다(SD-29, SD-31). 첫 조각은 정한 길이이고 다음 조각은 두 배씩 늘린다. 오래된순이면 범위의
 * 앞에서부터 같은 방식으로 나눈다. 짧은 조각을 먼저 끝내 실행 예산을 넘어도 끝낸 구간을 돌려줄 수 있게 한다.
 */
export function* slicesOf(from: bigint, to: bigint, sort: 'newest' | 'oldest', firstUs: bigint): Generator<Slice> {
  let span = firstUs > 0n ? firstUs : 1n;
  if (sort === 'newest') {
    for (let hi = to; hi > from; span *= 2n) {
      const lo = hi - span > from ? hi - span : from;
      yield { from: lo, to: hi };
      hi = lo;
    }
  } else {
    for (let lo = from; lo < to; span *= 2n) {
      const hi = lo + span < to ? lo + span : to;
      yield { from: lo, to: hi };
      lo = hi;
    }
  }
}

/** 시간별 발생량의 간격(Q08-08, SD-29). ClickHouse `INTERVAL n 단위`로 표시 시간대에 맞춰 자른다. */
export interface BucketInterval {
  seconds: number;
  n: number;
  unit: 'SECOND' | 'MINUTE' | 'HOUR' | 'DAY';
}

const INTERVALS: BucketInterval[] = [
  { seconds: 10, n: 10, unit: 'SECOND' },
  { seconds: 30, n: 30, unit: 'SECOND' },
  { seconds: 60, n: 1, unit: 'MINUTE' },
  { seconds: 300, n: 5, unit: 'MINUTE' },
  { seconds: 600, n: 10, unit: 'MINUTE' },
  { seconds: 900, n: 15, unit: 'MINUTE' },
  { seconds: 1800, n: 30, unit: 'MINUTE' },
  { seconds: 3600, n: 1, unit: 'HOUR' },
  { seconds: 10800, n: 3, unit: 'HOUR' },
  { seconds: 21600, n: 6, unit: 'HOUR' },
  { seconds: 43200, n: 12, unit: 'HOUR' },
  { seconds: 86400, n: 1, unit: 'DAY' },
];

/** 구간 수가 목표를 넘지 않는 가장 작은 간격. 하루보다 크게는 늘리지 않는다(보관 6개월이면 하루 단위로 약 180개). */
export function bucketIntervalOf(from: bigint, to: bigint, target: number): BucketInterval {
  const seconds = Number((to - from) / 1_000_000n);
  return INTERVALS.find((i) => Math.ceil(seconds / i.seconds) <= target) ?? INTERVALS[INTERVALS.length - 1];
}
