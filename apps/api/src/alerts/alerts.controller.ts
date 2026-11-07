import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { type ApiRequest, header } from '../common/http.js';
import { idempotencyKey } from '../common/idempotency.js';
import { idParam, parse } from '../common/validate.js';
import { ConfirmRecipientBody, CreateRuleBody, UpdateRuleBody } from './alert-input.js';
import { AlertRulesService } from './alert-rules.service.js';
import { incidentRefParam, IncidentsService } from './incidents.service.js';

const Flag = z.enum(['true', 'false']);
const Page = {
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(512).optional(),
};
const ListParams = z.object({
  enabled: Flag.optional(),
  eval_state: z.enum(['normal', 'firing', 'resolving']).optional(),
  final_failure_unacked: Flag.optional(),
  ...Page,
});
const PageParams = z.object(Page);

/** 알림 규칙과 사건(계약 4.3·5.4절, UI-06~09). 재확인은 없고, 바꾸는 동작은 감사를 쓸 수 없으면 보류한다. */
@Controller('v1')
export class AlertsController {
  constructor(
    private readonly rules: AlertRulesService,
    private readonly incidents: IncidentsService,
  ) {}

  @Get('alert-rules')
  async list(@Query() query: unknown, @Req() req: ApiRequest) {
    const p = parse(ListParams, query);
    return this.rules.list(req.session!.accountId, {
      enabled: p.enabled === undefined ? undefined : p.enabled === 'true',
      evalState: p.eval_state,
      finalFailureUnacked: p.final_failure_unacked === 'true',
      limit: p.limit ?? 50,
      cursor: p.cursor,
    });
  }

  @Get('alert-rules/:id')
  async detail(@Param('id') id: string, @Req() req: ApiRequest) {
    return this.rules.detail(req.session!.accountId, idParam(id));
  }

  /** 만들기. Idempotency-Key가 필요하다. 같은 키로 다시 받은 응답도 201이다. */
  @Post('alert-rules')
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() req: ApiRequest) {
    const key = idempotencyKey(header(req, 'idempotency-key'));
    return this.rules.create(parse(CreateRuleBody, body), key, req.session!.accountId);
  }

  /** 수정과 켬/끔(`enabled`). */
  @Patch('alert-rules/:id')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const n = idParam(id);
    return this.rules.update(n, parse(UpdateRuleBody, body), req.session!.accountId);
  }

  @Delete('alert-rules/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() req: ApiRequest) {
    await this.rules.remove(idParam(id), req.session!.accountId);
  }

  /** 테스트 메일을 받은 주소에 `받았음`을 표시한다(WQ-42). */
  @Post('alert-rules/:id/recipients/confirm')
  @HttpCode(200)
  async confirmRecipient(@Param('id') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const n = idParam(id);
    return this.rules.confirmRecipient(n, parse(ConfirmRecipientBody, body).address, req.session!.accountId);
  }

  @Get('alert-rules/:id/incidents')
  async ruleIncidents(@Param('id') id: string, @Query() query: unknown, @Req() req: ApiRequest) {
    const n = idParam(id);
    const p = parse(PageParams, query);
    return this.incidents.listForRule(req.session!.accountId, n, { limit: p.limit ?? 50, cursor: p.cursor });
  }

  @Get('incidents/:ref')
  async incident(@Param('ref') ref: string, @Req() req: ApiRequest) {
    return this.incidents.detail(req.session!.accountId, incidentRefParam(ref));
  }

  /** 그 사건의 최종 실패를 확인했다(WQ-49). */
  @Post('incidents/:ref/ack-final-failures')
  @HttpCode(200)
  async ack(@Param('ref') ref: string, @Req() req: ApiRequest) {
    return this.incidents.ackFinalFailures(req.session!.accountId, incidentRefParam(ref));
  }
}
