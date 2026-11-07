// 알림 조사 모드(계약 4.2절 `GET /api/v1/incidents/{id}/investigation`, Q12 5절, UI-02 알림 조사, WQ-13·WQ-14). 사건 당시의
// 조건과 수신 시각 평가 구간을 고정해 지금 건수를 다시 세고, 당시 건수와 차이 사유별 해당 여부를 준다. 규칙이 그 뒤 바뀌었거나
// 지워졌으면 `rule_status`로 알리고, 서비스·서버는 지금 이름으로 준다. 사건이 없거나 알림 이력 보관 기간이 지나 지워졌으면 404다.
import { Inject, Injectable } from '@nestjs/common';

import type { SessionInfo } from '../auth/session.service.js';
import { errors } from '../common/api-error.js';
import type { AppConfig } from '../config.js';
import { decodeConnectionId } from '../connections/public-id.js';
import { Database, utc } from '../db/database.js';
import { ChRunner, Stop } from '../search/ch-runner.js';
import type { Condition } from '../search/condition.js';
import { loadReferences, resolveReferences } from '../search/references.js';
import { usOf } from '../search/run-time.js';
import { loadBlocks, loadLimits } from '../search/scope.js';
import { APP_CONFIG } from '../tokens.js';
import { countWindow } from './alert-count.js';
import { loadTargets } from './targets.js';

interface IncidentRow {
  public_ref: string;
  rule_id: number;
  rule_name: string;
  condition: Condition;
  condition_version: number;
  window_minutes: number;
  threshold: number;
  window_start: string;
  window_end: string;
  fired_at: string;
  matched_count: string;
  unknown_count: string | null;
  partial: boolean;
  quality: string;
  closed_at: string | null;
  close_reason: string | null;
  rule_deleted: boolean | null;
  rule_version: number | null;
  rule_current_name: string | null;
}

type Applies = 'yes' | 'no' | 'unknown';

@Injectable()
export class InvestigationService {
  constructor(
    private readonly db: Database,
    private readonly runner: ChRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async investigate(session: SessionInfo, ref: string) {
    const inc = (
      await this.db.query<IncidentRow>(
        `SELECT i.public_ref, i.rule_id, i.rule_name, i.condition, i.condition_version, i.window_minutes, i.threshold,
                ${utc('i.window_start')} AS window_start, ${utc('i.window_end')} AS window_end, ${utc('i.fired_at')} AS fired_at,
                i.matched_count::text, i.unknown_count::text, i.partial, i.quality, ${utc('i.closed_at')} AS closed_at, i.close_reason,
                r.deleted_at IS NOT NULL AS rule_deleted, r.condition_version AS rule_version, r.name AS rule_current_name
           FROM alert_incidents i LEFT JOIN alert_rules r ON r.id = i.rule_id
          WHERE i.public_ref = $1`,
        [ref],
      )
    ).rows[0];
    if (!inc) throw errors.notFound();
    const cond = inc.condition;
    const refs = resolveReferences(cond, await this.db.tx((c) => loadReferences(c, [cond])));
    const connectionIds = cond.sources.connection_ids.map((x) => decodeConnectionId(x)).filter((x): x is number => x !== null);
    return this.runner.gate(session.idHash.toString('hex'), async (budget, track) => {
      const limits = await loadLimits(this.db, this.config);
      let now: { matched_count: number; unknown_count: number | null; partial: boolean } | null = null;
      try {
        const c = await countWindow(
          this.runner.ch.logs,
          cond,
          { from: usOf(inc.window_start), to: usOf(inc.window_end) },
          {
            availableFrom: limits.availableFrom,
            connectionIds,
            blocks: await loadBlocks(this.db, connectionIds, null),
            firstSliceUs: BigInt(this.config.searchRun.firstSliceMinutes) * 60_000_000n,
          },
          (sql, p) => this.runner.query(sql, p, budget, track),
        );
        now = { matched_count: c.matched, unknown_count: c.partial ? null : c.unknown, partial: c.partial };
      } catch (e) {
        if (!(e instanceof Stop)) throw e;
      }
      const targets = (await loadTargets(this.db, cond, this.config)).map((t) => t.id);
      const flags = (
        await this.db.query<{ early: boolean; manual: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM early_deletions WHERE received_from < $2::timestamptz AND received_to > $1::timestamptz) AS early,
                  EXISTS (SELECT 1 FROM deletion_blocks WHERE requested_at >= $3::timestamptz
                            AND (cardinality($4::int[]) = 0 OR connection_id = ANY($4))) AS manual`,
          [inc.window_start, inc.window_end, inc.fired_at, connectionIds.length ? connectionIds : targets],
        )
      ).rows[0];
      const thenUnknown = inc.unknown_count === null ? null : Number(inc.unknown_count);
      const yn = (b: boolean): Applies => (b ? 'yes' : 'no');
      const reasons: { kind: string; applies: Applies }[] = [
        { kind: 'retention', applies: yn(usOf(inc.window_start) < usOf(limits.retentionFrom)) },
        { kind: 'early_deletion', applies: yn(flags.early) },
        { kind: 'manual_deletion', applies: yn(flags.manual) },
        {
          kind: 'undecided',
          applies: thenUnknown === null || now?.unknown_count == null ? 'unknown' : yn(thenUnknown > 0 || (now.unknown_count ?? 0) > 0),
        },
        { kind: 'partial', applies: yn(inc.partial) },
        // 늦게 반영된 로그는 따로 기록하지 않아 해당 여부를 알 수 없다(WQ-13).
        { kind: 'late', applies: 'unknown' },
      ];
      return {
        incident: {
          ref: inc.public_ref,
          rule_id: inc.rule_id,
          rule_name: inc.rule_name,
          rule_status: inc.rule_deleted === null || inc.rule_deleted ? 'deleted' : inc.rule_version !== inc.condition_version ? 'changed' : 'same',
          rule_current_name: inc.rule_deleted ? null : inc.rule_current_name,
          fired_at: inc.fired_at,
          closed_at: inc.closed_at,
          close_reason: inc.close_reason,
          quality: inc.quality,
          window_minutes: inc.window_minutes,
          threshold: inc.threshold,
        },
        condition: cond,
        ...refs,
        window: { from: inc.window_start, to: inc.window_end, basis: 'received' },
        then: { matched_count: Number(inc.matched_count), unknown_count: thenUnknown, partial: inc.partial },
        now,
        available_from: limits.availableFrom,
        received_through: limits.receivedThrough,
        reasons,
      };
    });
  }
}
