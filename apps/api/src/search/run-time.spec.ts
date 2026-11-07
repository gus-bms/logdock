// 검색 실행 시각 계산 시험(계약 4.2절, SD-27·SD-29). 마이크로초를 잃지 않는지와 조각·구간 간격을 본다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bucketIntervalOf, chOf, durationUs, rfcOf, slicesOf, usOf, usOfCh } from './run-time.js';

const H = 3_600_000_000n;

describe('검색 실행 시각', () => {
  it('마이크로초를 그대로 오간다', () => {
    const us = usOf('2026-11-05T01:02:03.123456Z');
    assert.equal(rfcOf(us), '2026-11-05T01:02:03.123456Z');
    assert.equal(rfcOf(us + 1n), '2026-11-05T01:02:03.123457Z');
    assert.equal(usOf('2026-11-05T01:02:03Z'), us - 123456n);
    assert.equal(chOf(us), '2026-11-05 01:02:03.123456');
    assert.equal(usOfCh('2026-11-05 01:02:03.123456'), us);
  });

  it('상대 기간을 마이크로초로 바꾼다', () => {
    assert.equal(durationUs('PT1H'), H);
    assert.equal(durationUs('P1DT2H3M4S'), ((24n + 2n) * 3600n + 3n * 60n + 4n) * 1_000_000n);
  });

  it('최신순은 끝에서부터, 오래된순은 앞에서부터 두 배씩 늘려 나눈다', () => {
    const newest = [...slicesOf(0n, 10n * H, 'newest', H)].map((s) => [s.from / H, s.to / H]);
    assert.deepEqual(newest, [[9n, 10n], [7n, 9n], [3n, 7n], [0n, 3n]]);
    const oldest = [...slicesOf(0n, 10n * H, 'oldest', H)].map((s) => [s.from / H, s.to / H]);
    assert.deepEqual(oldest, [[0n, 1n], [1n, 3n], [3n, 7n], [7n, 10n]]);
    assert.deepEqual([...slicesOf(5n, 5n, 'newest', H)], []);
  });

  it('구간 수가 목표를 넘지 않는 가장 작은 간격을 고른다', () => {
    assert.deepEqual(bucketIntervalOf(0n, H, 200), { seconds: 30, n: 30, unit: 'SECOND' });
    assert.deepEqual(bucketIntervalOf(0n, 24n * H, 200), { seconds: 600, n: 10, unit: 'MINUTE' });
    assert.deepEqual(bucketIntervalOf(0n, 7n * 24n * H, 200), { seconds: 3600, n: 1, unit: 'HOUR' });
    assert.deepEqual(bucketIntervalOf(0n, 184n * 24n * H, 200), { seconds: 86400, n: 1, unit: 'DAY' });
    assert.deepEqual(bucketIntervalOf(0n, 400n * 24n * H, 200), { seconds: 86400, n: 1, unit: 'DAY' });
  });
});
