import { Inject, Injectable, Logger } from '@nestjs/common';

import { type AppConfig } from '../config.js';
import { type Queryable, trySavepoint } from '../db/database.js';
import { APP_CONFIG } from '../tokens.js';

export interface AuditEntry {
  action: string; // 5.6절 동작 코드(auth.login 등)
  result: 'success' | 'failure' | 'partial';
  actorType?: 'shared_account' | 'local_operator' | 'system';
  accountId?: number | null;
  targetType?: string;
  targetRef?: string;
  /** 바뀐 항목의 이름만 남긴다. 값은 남기지 않는다(TD-17). */
  changedFields?: string[];
  reasonCode?: string;
  /** 에이전트에 닿는 작업의 진행 단계(WQ-85). 요청 접수·중앙 확정·에이전트 관측마다 행을 남긴다. */
  stage?: 'requested' | 'confirmed' | 'agent_observed';
}

/**
 * 감사를 남길 수 없어 변경을 적용하지 않았다(Q10-14 (4)). 트랜잭션 안에서 던지면 변경이 함께 되돌려지고,
 * 오류 필터가 409 held_audit_unavailable로 바꾼다.
 */
export class AuditUnavailableError extends Error {
  constructor() {
    super('audit storage unavailable');
  }
}

/**
 * 감사 기록(Q10-12~14, 계약 5.6절). 허용한 열만 쓰고 비밀번호·키·검색어·쿠키는 담지 않는다.
 * 감사 행은 바꾸는 트랜잭션 안에 함께 쓴다(T06).
 */
@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async write(c: Queryable, e: AuditEntry, aggregate = false): Promise<void> {
    if (aggregate) {
      // 짧은 시간에 몰린 같은 실패(동작·결과·계정·사유가 같은 것)는 한 행으로 묶어 건수를 남긴다(5.6절, 감사 폭주 방지).
      const r = await c.query(
        `UPDATE audit_log SET event_count = event_count + 1
          WHERE id = (SELECT id FROM audit_log
                       WHERE action = $1 AND result = $2 AND account_id IS NOT DISTINCT FROM $3
                         AND reason_code IS NOT DISTINCT FROM $5
                         AND logged_at > now() - make_interval(secs => $4)
                       ORDER BY logged_at DESC LIMIT 1)`,
        [e.action, e.result, e.accountId ?? null, this.config.auditAggregateSeconds, e.reasonCode ?? null],
      );
      if (r.rowCount) return;
    }
    await c.query(
      `INSERT INTO audit_log (actor_type, account_id, action, target_type, target_ref, result, changed_fields, reason_code, stage)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        e.actorType ?? 'shared_account',
        e.accountId ?? null,
        e.action,
        e.targetType ?? null,
        e.targetRef ?? null,
        e.result,
        e.changedFields ?? null,
        e.reasonCode ?? null,
        e.stage ?? null,
      ],
    );
  }

  /**
   * 감사가 남아야 적용하는 변경(민감 변경·이름 변경·알림 규칙 변경, Q10-14 (4))이 쓴다. 감사를 쓰지 못하면
   * AuditUnavailableError를 던져 트랜잭션 전체를 되돌린다. 요청은 저장하지 않고 사용자가 복구 뒤 다시 실행한다.
   */
  async writeOrHold(c: Queryable, e: AuditEntry): Promise<void> {
    if (!(await trySavepoint(c, 'audit_write', () => this.write(c, e)))) {
      this.log.warn(`audit write failed for ${e.action}; the change is held`);
      throw new AuditUnavailableError();
    }
  }

  /**
   * 감사를 쓸 수 없어도 진행하는 동작(로그인·로그아웃·실패 기록, Q10-14 (3))이 쓴다. 실패하면 그 부분만
   * 되돌리고 감사 공백을 남긴다. 공백도 쓸 수 없으면 자체 로그에만 남긴다. 감사가 남았는지 돌려준다.
   */
  async writeOrGap(c: Queryable, e: AuditEntry, aggregate = false): Promise<boolean> {
    if (await trySavepoint(c, 'audit_write', () => this.write(c, e, aggregate))) return true;
    this.log.warn(`audit write failed for ${e.action}; recording an audit gap`);
    await trySavepoint(c, 'audit_gap', async () => {
      // 공백이 새로 열릴 때만 audit_gap 배너를 올린다. 떠 있는 배너가 있으면 건수를 늘린다(notices_open_uq).
      await c.query(
        `WITH gap AS (
           INSERT INTO audit_gaps (started_at)
           SELECT now() WHERE NOT EXISTS (SELECT 1 FROM audit_gaps WHERE ended_at IS NULL)
           RETURNING id)
         INSERT INTO notices (kind, item_count) SELECT 'audit_gap', 1 FROM gap
         ON CONFLICT (kind) WHERE cleared_at IS NULL AND acknowledged_at IS NULL
         DO UPDATE SET item_count = coalesce(notices.item_count, 0) + 1`,
      );
    });
    return false;
  }
}
