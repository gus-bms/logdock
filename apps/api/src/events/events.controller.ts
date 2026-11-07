import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';

import type { ApiRequest } from '../common/http.js';
import { parse } from '../common/validate.js';
import { EventsService, NearbyBody } from './events.service.js';

/** 이벤트 상세와 주변 로그(계약 4.2절, UI-03·UI-04). */
@Controller('v1/events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get(':ref')
  async detail(@Param('ref') ref: string, @Req() req: ApiRequest) {
    return this.events.detail(req.session!, ref);
  }

  @Post(':ref/nearby')
  @HttpCode(200)
  async nearby(@Param('ref') ref: string, @Body() body: unknown, @Req() req: ApiRequest) {
    return this.events.nearby(req.session!, ref, parse(NearbyBody, body));
  }
}
