// 구간 로그 삭제(계약 3.3절 구간 삭제, 4.3절 `POST /api/v1/connections/{id}/deletions`, Q13-03, WQ-69). 연결과 검색 기준 시각
// 구간을 `deletion_blocks`에 `requested`로 남기고 바로 응답한다. 그때부터 검색·알림 평가·주변 로그·상세는 그 구간을 빼고,
// 실제 ClickHouse 삭제와 `confirmed`·`failed` 기록은 수신 서버가 한다. 최근 재확인·Idempotency-Key·감사(보류)가 필요하다.
import { Body, Controller, HttpCode, Injectable, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { RequireReauth } from '../auth/auth.guard.js';
import { sha256 } from '../auth/tokens.js';
import { errors } from '../common/api-error.js';
import { type ApiRequest, header } from '../common/http.js';
import { claimIdempotency, completeIdempotency, idempotencyKey } from '../common/idempotency.js';
import { parse } from '../common/validate.js';
import { Database, type Queryable, utc } from '../db/database.js';
import { isRfc3339 } from '../search/condition.js';
import { decodeConnectionId, encodeConnectionId } from './public-id.js';

export const DeletionBody = z.object({ from: z.string().max(64), to: z.string().max(64) }).strict();

@Injectable()
export class DeletionsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async request(publicId: string, body: z.infer<typeof DeletionBody>, idemKey: string, accountId: number) {
    const id = decodeConnectionId(publicId);
    if (id === null) throw errors.notFound();
    const problems = (['from', 'to'] as const).filter((k) => !isRfc3339(body[k])).map((k) => ({ path: k, reason: 'time_invalid' }));
    if (problems.length) throw errors.validation(problems);
    return this.db.tx(async (c) => {
      const claim = await claimIdempotency(c, accountId, idemKey, 'connection.delete_range', sha256('connection.delete_range', JSON.stringify([publicId, body.from, body.to])));
      if (claim.kind === 'replay') return this.view(c, String(claim.result.id));
      const conn = (await c.query('SELECT 1 FROM connections WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!conn) throw errors.notFound();
      const ordered = (await c.query<{ ok: boolean }>('SELECT $1::timestamptz < $2::timestamptz AS ok', [body.from, body.to])).rows[0].ok;
      if (!ordered) throw errors.validation([{ path: 'to', reason: 'not_after_from' }]);
      const block = (
        await c.query<{ id: string }>(
          `INSERT INTO deletion_blocks (connection_id, ref_time_from, ref_time_to) VALUES ($1, $2::timestamptz, $3::timestamptz) RETURNING id::text`,
          [id, body.from, body.to],
        )
      ).rows[0];
      await this.audit.writeOrHold(c, {
        action: 'connection.delete_range',
        result: 'success',
        accountId,
        targetType: 'connection',
        targetRef: publicId,
        stage: 'requested',
      });
      await completeIdempotency(c, accountId, idemKey, 201, { id: block.id });
      return this.view(c, block.id);
    });
  }

  private async view(c: Queryable, id: string) {
    const r = (
      await c.query<{ id: string; connection_id: number; from: string; to: string; state: string; requested_at: string; confirmed_at: string | null }>(
        `SELECT id::text, connection_id, ${utc('ref_time_from')} AS from, ${utc('ref_time_to')} AS to, state,
                ${utc('requested_at')} AS requested_at, ${utc('confirmed_at')} AS confirmed_at
           FROM deletion_blocks WHERE id = $1::bigint`,
        [id],
      )
    ).rows[0];
    return {
      id: r.id,
      connection_id: encodeConnectionId(r.connection_id),
      range: { from: r.from, to: r.to, basis: 'occurred' },
      state: r.state,
      requested_at: r.requested_at,
      confirmed_at: r.confirmed_at,
    };
  }
}

@Controller('v1/connections')
export class DeletionsController {
  constructor(private readonly deletions: DeletionsService) {}

  /** 구간 로그 삭제 요청. 같은 키로 다시 받은 응답도 201이다. */
  @Post(':id/deletions')
  @HttpCode(201)
  @RequireReauth()
  async request(@Param('id') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const key = idempotencyKey(header(req, 'idempotency-key'));
    return this.deletions.request(id, parse(DeletionBody, body), key, req.session!.accountId);
  }
}
