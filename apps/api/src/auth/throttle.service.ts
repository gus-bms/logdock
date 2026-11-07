import { Inject, Injectable } from '@nestjs/common';

import { type AppConfig } from '../config.js';
import type { Queryable } from '../db/database.js';
import { APP_CONFIG } from '../tokens.js';
import { sha256 } from './tokens.js';

export interface ThrottleKeys {
  /** 같은 계정 이름·같은 접속 주소. 한 사람의 오타가 다른 사람의 로그인을 막지 않게 좁게 센다. */
  source: Buffer;
  /** 주소와 무관한 같은 계정 이름. 여러 주소에서 나눠 맞혀 보는 것을 넓게 막고, 연속 실패 잠금도 여기서 센다. */
  account: Buffer;
}

/** open: 시도할 수 있음. blocked: 잠시 막힘(남은 초). locked: 연속 실패로 잠김, 로컬 재설정으로만 풀린다. */
export type ThrottleState = { kind: 'open' } | { kind: 'blocked'; wait: number } | { kind: 'locked' };

/**
 * 로그인 시도 제한(Q10-03, 계약 4.3절). 로그인·재확인·비밀번호 변경의 비밀번호 실패를 같은 열쇠로 센다.
 * 열쇠는 계정 이름과 주소를 해시해 두고 원문은 남기지 않는다(login_throttle은 감사와 따로 짧게 보관).
 * 막히거나 잠긴 동안에는 맞는 비밀번호도 받지 않는다. 그러지 않으면 제한이 맞히기를 막지 못한다.
 * 잠금은 계정 이름 열쇠로 세므로 없는 계정 이름도 똑같이 잠겨, 잠금으로 계정이 있는지 드러나지 않는다.
 */
@Injectable()
export class ThrottleService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  keys(accountName: string, address: string): ThrottleKeys {
    const name = accountName.normalize('NFC').trim().toLowerCase();
    return { source: sha256('source', name, address), account: sha256('account', name) };
  }

  async check(c: Queryable, k: ThrottleKeys): Promise<ThrottleState> {
    const r = await c.query<{ locked: boolean | null; wait: string | null }>(
      `SELECT bool_or(locked_at IS NOT NULL) AS locked,
              ceil(extract(epoch FROM max(blocked_until) FILTER (WHERE blocked_until > now()) - now()))::bigint AS wait
         FROM login_throttle WHERE key_hash = ANY($1)`,
      [[k.source, k.account]],
    );
    const row = r.rows[0];
    if (row?.locked) return { kind: 'locked' };
    const wait = Number(row?.wait ?? 0);
    return wait > 0 ? { kind: 'blocked', wait } : { kind: 'open' };
  }

  /**
   * 실패를 센다. 창이 지났으면 새로 센다. 창 안의 한도에 닿으면 잠시 막고, 계정 이름의 연속 실패가 잠금 한도에
   * 닿으면 잠근다. 실패 뒤의 상태와, 이번 실패로 막 잠겼는지를 돌려준다.
   */
  async fail(c: Queryable, k: ThrottleKeys): Promise<{ state: ThrottleState; lockedNow: boolean }> {
    const t = this.config.throttle;
    let wait = 0;
    for (const [key, limit] of [
      [k.source, t.perSourceFailures],
      [k.account, t.perAccountFailures],
    ] as const) {
      const r = await c.query<{ wait: string | null }>(
        `INSERT INTO login_throttle AS t (key_hash, failures, window_started_at, blocked_until, updated_at)
              VALUES ($1, 1, now(), CASE WHEN 1 >= $2 THEN now() + make_interval(secs => $4) END, now())
         ON CONFLICT (key_hash) DO UPDATE SET
              failures = CASE WHEN t.window_started_at <= now() - make_interval(secs => $3) THEN 1 ELSE t.failures + 1 END,
              window_started_at = CASE WHEN t.window_started_at <= now() - make_interval(secs => $3) THEN now() ELSE t.window_started_at END,
              blocked_until = CASE
                  WHEN (CASE WHEN t.window_started_at <= now() - make_interval(secs => $3) THEN 1 ELSE t.failures + 1 END) >= $2
                  THEN now() + make_interval(secs => $4)
                  ELSE t.blocked_until END,
              updated_at = now()
         RETURNING CASE WHEN blocked_until > now() THEN ceil(extract(epoch FROM blocked_until - now()))::bigint END AS wait`,
        [key, limit, t.windowSeconds, t.blockSeconds],
      );
      wait = Math.max(wait, Number(r.rows[0]?.wait ?? 0));
    }
    // 위에서 계정 이름 열쇠의 행이 생겼거나 있다. 연속 실패는 성공해야 0으로 돌아가고, 창이 지나도 이어 센다.
    const l = await c.query<{ locked: boolean; locked_now: boolean }>(
      `UPDATE login_throttle SET
              consecutive_failures = consecutive_failures + 1,
              locked_at = coalesce(locked_at, CASE WHEN consecutive_failures + 1 >= $2 THEN now() END)
        WHERE key_hash = $1
        RETURNING locked_at IS NOT NULL AS locked, consecutive_failures = $2 AS locked_now`,
      [k.account, t.lockAfterConsecutiveFailures],
    );
    const locked = l.rows[0]?.locked ?? false;
    const lockedNow = locked && (l.rows[0]?.locked_now ?? false);
    if (locked) return { state: { kind: 'locked' }, lockedNow };
    return { state: wait > 0 ? { kind: 'blocked', wait } : { kind: 'open' }, lockedNow: false };
  }

  /** 성공하면 좁은 열쇠를 지우고 연속 실패 수를 0으로 돌린다. 넓은 열쇠의 창 안 실패 수는 창이 지나면 새로 센다. */
  async succeed(c: Queryable, k: ThrottleKeys): Promise<void> {
    await c.query('DELETE FROM login_throttle WHERE key_hash = $1', [k.source]);
    await c.query('UPDATE login_throttle SET consecutive_failures = 0 WHERE key_hash = $1 AND locked_at IS NULL', [k.account]);
  }
}
