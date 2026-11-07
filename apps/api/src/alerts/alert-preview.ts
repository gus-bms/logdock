// 알림 규칙 건수 미리보기(계약 4.3절 `POST /api/v1/alert-rules/preview`, TD-05). 평가와 같은 수신 시각 창과 세는 방법으로
// 가장 최근 창의 건수를 보여 준다. 검색과 같은 동시 실행 상한·실행 예산을 쓴다.
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { SessionInfo } from '../auth/session.service.js';
import { errors } from '../common/api-error.js';
import type { AppConfig } from '../config.js';
import { decodeConnectionId } from '../connections/public-id.js';
import { Database } from '../db/database.js';
import { ChRunner } from '../search/ch-runner.js';
import { ConditionSchema, checkCondition, checkConditionReferences } from '../search/condition.js';
import { rfcOf, usOf } from '../search/run-time.js';
import { loadBlocks, loadLimits } from '../search/scope.js';
import { APP_CONFIG } from '../tokens.js';
import { countWindow } from './alert-count.js';
import { loadTargets, qualityOf } from './targets.js';

export const PreviewBody = z
  .object({
    condition: ConditionSchema,
    window_minutes: z.number().int().min(1).max(1440),
    threshold: z.number().int().min(1).optional(),
  })
  .strict();

@Injectable()
export class AlertPreviewService {
  constructor(
    private readonly db: Database,
    private readonly runner: ChRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async preview(session: SessionInfo, body: z.infer<typeof PreviewBody>) {
    const checked = checkCondition(body.condition, this.config);
    if (!checked.ok) throw errors.conditionInvalid(checked.problems);
    const cond = checked.condition;
    const refs = await this.db.tx((c) => checkConditionReferences(c, cond));
    if (refs.length) throw errors.conditionInvalid(refs);
    return this.runner.gate(session.idHash.toString('hex'), async (budget, track) => {
      const limits = await loadLimits(this.db, this.config);
      const step = BigInt(this.config.alertEval.intervalSeconds) * 1_000_000n;
      const end = (usOf(limits.receivedThrough) / step) * step;
      const win = { from: end - BigInt(body.window_minutes) * 60_000_000n, to: end };
      const connectionIds = cond.sources.connection_ids.map((x) => decodeConnectionId(x)!);
      const count = await countWindow(
        this.runner.ch.logs,
        cond,
        win,
        {
          availableFrom: limits.availableFrom,
          connectionIds,
          blocks: await loadBlocks(this.db, connectionIds, null),
          firstSliceUs: BigInt(this.config.searchRun.firstSliceMinutes) * 60_000_000n,
        },
        (sql, p) => this.runner.query(sql, p, budget, track),
      );
      const targets = await loadTargets(this.db, cond, this.config);
      const t = body.threshold ?? null;
      return {
        window: { from: rfcOf(win.from), to: rfcOf(win.to), basis: 'received' },
        received_through: limits.receivedThrough,
        matched_count: count.matched,
        unknown_count: count.partial ? null : count.unknown,
        partial: count.partial,
        threshold: t,
        // 부분 건수가 이미 임계 이상이면 충족이고, 임계 미만의 부분 결과는 판정하지 않는다(TD-13).
        would_fire: t === null ? null : count.matched >= t ? true : count.partial ? null : false,
        quality: qualityOf(targets),
        target_count: targets.length,
      };
    });
  }
}
