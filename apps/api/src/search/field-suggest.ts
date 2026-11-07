// 필드 이름 후보(계약 4.2절 `POST /api/v1/fields/suggest`, SD-25). 최근 정한 시간 동안 수신한 로그의 `field_paths`에서 고른
// 출처에 나온 경로를 많이 나온 순서로 준다. 입력한 글자가 있으면 대소문자 없이 그 글자를 담은 경로만 준다.
import { Body, Controller, HttpCode, Inject, Injectable, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import type { SessionInfo } from '../auth/session.service.js';
import { errors } from '../common/api-error.js';
import type { ApiRequest } from '../common/http.js';
import { parse } from '../common/validate.js';
import type { AppConfig } from '../config.js';
import { decodeConnectionId } from '../connections/public-id.js';
import { Database } from '../db/database.js';
import { APP_CONFIG } from '../tokens.js';
import { ChRunner, Stop } from './ch-runner.js';
import { ConditionSchema, checkCondition, checkConditionReferences } from './condition.js';
import { rfcOf, usOf } from './run-time.js';
import { loadLimits } from './scope.js';
import { Params, buildFilter } from './search-sql.js';

export const SuggestBody = z
  .object({
    sources: ConditionSchema.shape.sources,
    query: z.string().max(256).optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

@Injectable()
export class FieldSuggestService {
  constructor(
    private readonly db: Database,
    private readonly runner: ChRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async suggest(session: SessionInfo, body: z.infer<typeof SuggestBody>) {
    const cfg = this.config.searchRun;
    const limit = body.limit ?? cfg.suggestLimit;
    if (limit > cfg.suggestLimit) throw errors.validation([{ path: 'limit', reason: 'too_big' }]);
    const checked = checkCondition({ sources: body.sources }, this.config, 'sources_check');
    if (!checked.ok) throw errors.conditionInvalid(checked.problems.map((x) => ({ ...x, path: x.path.replace(/^sources_check\.sources/, 'sources') })));
    const cond = checked.condition;
    const refs = await this.db.tx((c) => checkConditionReferences(c, cond, 'x'));
    if (refs.length) throw errors.conditionInvalid(refs.map((x) => ({ ...x, path: x.path.replace(/^x\.sources/, 'sources') })));
    return this.runner.gate(session.idHash.toString('hex'), async (budget, track) => {
      const limits = await loadLimits(this.db, this.config);
      const since = rfcOf(limits.now - BigInt(cfg.suggestHours) * 3_600_000_000n);
      const from = usOf(since) > usOf(limits.availableFrom) ? since : limits.availableFrom;
      const p = new Params();
      const f = buildFilter(cond, {
        basis: 'received',
        from,
        to: limits.receivedThrough,
        receivedThrough: limits.receivedThrough,
        availableFrom: limits.availableFrom,
        connectionIds: cond.sources.connection_ids.map((x) => decodeConnectionId(x)!),
        blocks: [],
      }, p);
      const where = [f.where];
      if (body.query) where.push(`positionCaseInsensitiveUTF8(path, ${p.add('String', body.query)}) > 0`);
      const sql = `SELECT path, count() AS n
FROM ${this.runner.ch.logs} ARRAY JOIN field_paths AS path
WHERE ${where.join('\n  AND ')}
GROUP BY path
ORDER BY n DESC, path
LIMIT ${p.add('UInt32', limit)}`;
      try {
        const rows = await this.runner.query<{ path: string; n: string }>(sql, p, budget, track);
        return { fields: rows.map((r) => ({ path: r.path, count: Number(r.n) })), since: from, received_through: limits.receivedThrough };
      } catch (e) {
        if (e instanceof Stop) throw errors.searchTimeout();
        throw e;
      }
    });
  }
}

@Controller('v1/fields')
export class FieldSuggestController {
  constructor(private readonly fields: FieldSuggestService) {}

  @Post('suggest')
  @HttpCode(200)
  async suggest(@Body() body: unknown, @Req() req: ApiRequest) {
    return this.fields.suggest(req.session!, parse(SuggestBody, body));
  }
}
