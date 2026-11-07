// 기록 정리(계약 3.4절 보관 기간과 알림 기록, Q10-13, Q12-14, UI-07). worker가 주기마다 돌린다. 단계마다 따로 트랜잭션을
// 쓰고 큰 표는 나눠 지워, 한 단계의 실패나 긴 잠금이 다른 단계와 API를 막지 않게 한다.
import type { AppConfig } from '../config.js';
import { Database, utc } from '../db/database.js';

export type CleanupCounts = Record<string, number>;

export class Cleanup {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  /** 한 회차. 단계별로 지운 행 수를 돌려준다. 실패한 단계는 건너뛰고 다음 회차에 다시 한다. */
  async run(): Promise<CleanupCounts> {
    const counts: CleanupCounts = {};
    const steps: [string, () => Promise<number>][] = [
      ['sessions', () => this.sessions()],
      ['login_throttle', () => this.throttle()],
      ['idempotency_keys', () => this.idempotency()],
      ['audit_log', () => this.audit()],
      ['audit_gaps', () => this.auditGaps()],
      ['alert_history', () => this.alertHistory()],
      ['status_history', () => this.statusHistory()],
      ['early_deletions', () => this.earlyDeletions()],
      ['notices', () => this.notices()],
    ];
    for (const [name, step] of steps) {
      try {
        counts[name] = await step();
      } catch {
        counts[name] = -1;
      }
    }
    return counts;
  }

  /** 끝난 세션(로그아웃·종료되었거나 비활동·최대 수명이 지남)을 끝난 뒤 정한 시간이 지나면 지운다. */
  private sessions(): Promise<number> {
    const c = this.config;
    return this.batched(
      `DELETE FROM sessions WHERE id_hash IN (
         SELECT id_hash FROM sessions
          WHERE coalesce(revoked_at, least(created_at + make_interval(secs => $1), last_active_at + make_interval(secs => $2)))
                < now() - make_interval(hours => $3)
          LIMIT $4)`,
      [c.sessionAbsoluteSeconds, c.sessionIdleSeconds, c.cleanup.sessionKeepHours],
    );
  }

  /**
   * 로그인 시도 기록. 잠긴 행(연속 실패 잠금)은 로컬 재설정 전까지 지우지 않는다. 연속 실패 수가 남은 행은 창이 지나도 이어
   * 세야 하므로 마지막 시도 뒤 오래(시제품 90일) 남긴다. 나머지는 막힘이 풀리고 정한 시간이 지나면 지운다.
   */
  private throttle(): Promise<number> {
    const k = this.config.cleanup;
    return this.batched(
      `DELETE FROM login_throttle WHERE key_hash IN (
         SELECT key_hash FROM login_throttle
          WHERE locked_at IS NULL
            AND (blocked_until IS NULL OR blocked_until < now())
            AND CASE WHEN consecutive_failures > 0
                     THEN updated_at < now() - make_interval(days => $1)
                     ELSE updated_at < now() - make_interval(hours => $2) END
          LIMIT $3)`,
      [k.throttleCountKeepDays, k.throttleKeepHours],
    );
  }

  /** 중복 요청 키는 정한 시간만 둔다(4.1절 중복 요청 방지). 그 뒤 같은 키가 오면 새 요청으로 처리된다. */
  private idempotency(): Promise<number> {
    return this.batched(
      `DELETE FROM idempotency_keys WHERE (account_id, idem_key) IN (
         SELECT account_id, idem_key FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1) LIMIT $2)`,
      [this.config.cleanup.idempotencyKeepHours],
    );
  }

  /**
   * 감사는 90일이 목표다. 저장 상한(시제품 행 수)이 우선이라 넘으면 90일 전이라도 오래된 행부터 지운다. 지운 구간은
   * `audit_cleanups`에 남겨(일찍 지웠으면 `early`) 화면이 조회 가능 시작과 조기 정리 구간을 보인다(UI-15).
   */
  private async audit(): Promise<number> {
    const k = this.config.cleanup;
    let removed = await this.removeAudit('logged_at < now() - make_interval(days => $1)', [k.auditRetentionDays], false);
    const total = (await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;
    if (total > k.auditMaxRows) {
      const cut = (
        await this.db.query<{ at: string; id: string }>(
          `SELECT ${utc('logged_at')} AS at, id::text FROM audit_log ORDER BY logged_at, id OFFSET $1 LIMIT 1`,
          [total - k.auditMaxRows - 1],
        )
      ).rows[0];
      removed += await this.removeAudit('(logged_at, id) <= ($1::timestamptz, $2::bigint)', [cut.at, cut.id], true);
    }
    return removed;
  }

  private async removeAudit(where: string, values: unknown[], early: boolean): Promise<number> {
    return this.db.tx(async (c) => {
      const r = (
        await c.query<{ n: number; from: string | null; to: string | null }>(
          `WITH gone AS (DELETE FROM audit_log WHERE ${where} RETURNING logged_at)
           SELECT count(*)::int AS n, min(logged_at)::text AS from, max(logged_at)::text AS to FROM gone`,
          values,
        )
      ).rows[0];
      if (r.n > 0) {
        await c.query(
          `INSERT INTO audit_cleanups (removed_from, removed_to, removed_rows, early) VALUES ($1::timestamptz, $2::timestamptz, $3, $4)`,
          [r.from, r.to, r.n, early],
        );
      }
      return r.n;
    });
  }

  /** 끝난 감사 공백 구간은 감사 보관 기간이 지나면 지운다. 열린 공백은 남긴다. */
  private async auditGaps(): Promise<number> {
    const r = await this.db.query(`DELETE FROM audit_gaps WHERE ended_at < now() - make_interval(days => $1)`, [this.config.cleanup.auditRetentionDays]);
    return r.rowCount ?? 0;
  }

  /**
   * 알림 이력은 로그 보관 기간과 같이 둔다(Q12-14). 닫힌 사건과 그 메일 작업, 끝난 운영 메일의 일과 묶음, 미평가·건너뜀 회차를
   * 그 기간 뒤 지운다. 충족·미달 회차는 더 짧게(시제품 7일) 둔다. 지운 규칙은 사건이 모두 정리되면 행을 지운다(UI-07).
   */
  private async alertHistory(): Promise<number> {
    const months = this.config.logRetentionMonths;
    return this.db.tx(async (c) => {
      let n = 0;
      const del = async (sql: string, values: unknown[] = []) => {
        n += (await c.query(sql, values)).rowCount ?? 0;
      };
      await del(
        `DELETE FROM mail_jobs WHERE kind = 'alert' AND incident_id IN (
           SELECT id FROM alert_incidents WHERE closed_at IS NOT NULL AND fired_at < now() - make_interval(months => $1))`,
        [months],
      );
      await del(`DELETE FROM alert_incidents WHERE closed_at IS NOT NULL AND fired_at < now() - make_interval(months => $1)`, [months]);
      await del(`DELETE FROM mail_jobs WHERE kind IN ('ops', 'test') AND created_at < now() - make_interval(months => $1)`, [months]);
      await del(`DELETE FROM ops_episodes WHERE ended_at < now() - make_interval(months => $1)`, [months]);
      await del(
        `DELETE FROM ops_mail_batches b WHERE created_at < now() - make_interval(months => $1)
            AND NOT EXISTS (SELECT 1 FROM ops_episodes e WHERE e.ops_batch_id = b.id)
            AND NOT EXISTS (SELECT 1 FROM mail_jobs j WHERE j.ops_batch_id = b.id)`,
        [months],
      );
      await del(
        `DELETE FROM alert_evaluations
          WHERE (status IN ('met', 'below') AND window_end < now() - make_interval(days => $1))
             OR window_end < now() - make_interval(months => $2)`,
        [this.config.cleanup.evalRoundKeepDays, months],
      );
      const gone = `SELECT id FROM alert_rules r WHERE deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM alert_incidents i WHERE i.rule_id = r.id)`;
      await del(`DELETE FROM alert_evaluations WHERE rule_id IN (${gone})`);
      await del(`DELETE FROM alert_rule_recipients WHERE rule_id IN (${gone})`);
      await del(`DELETE FROM alert_rules WHERE id IN (${gone})`);
      return n;
    });
  }

  /** 상태 변화 이력은 정한 날 수(Q14의 `N`, 시제품 30일)만 둔다. */
  private statusHistory(): Promise<number> {
    return this.batched(
      `DELETE FROM status_history WHERE id IN (
         SELECT id FROM status_history WHERE reported_at < now() - make_interval(days => $1) LIMIT $2)`,
      [this.config.cleanup.statusHistoryKeepDays],
    );
  }

  /** 조기 삭제 기록은 최근 보관 기간 안을 보이므로 보관 기간만큼 둔다(WQ-72). */
  private async earlyDeletions(): Promise<number> {
    const r = await this.db.query(`DELETE FROM early_deletions WHERE happened_at < now() - make_interval(months => $1)`, [this.config.logRetentionMonths]);
    return r.rowCount ?? 0;
  }

  /** 내려간(풀렸거나 확인한) 배너는 정한 날 수 뒤 지운다. 떠 있는 배너는 남긴다. */
  private async notices(): Promise<number> {
    const r = await this.db.query(
      `DELETE FROM notices WHERE coalesce(cleared_at, acknowledged_at) < now() - make_interval(days => $1)`,
      [this.config.cleanup.noticeKeepDays],
    );
    return r.rowCount ?? 0;
  }

  /** `LIMIT $마지막`이 붙은 DELETE를 지울 것이 없을 때까지 되풀이한다. 한 번에 잡는 행 수를 묶어 긴 잠금을 피한다. */
  private async batched(sql: string, values: unknown[]): Promise<number> {
    const size = this.config.cleanup.batchRows;
    let total = 0;
    for (;;) {
      const n = (await this.db.query(sql, [...values, size])).rowCount ?? 0;
      total += n;
      if (n < size) return total;
    }
  }
}
