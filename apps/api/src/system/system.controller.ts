import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';

import { AuditSearchBody, AuditSearchService } from '../audit/audit-search.service.js';
import { errors } from '../common/api-error.js';
import { parse } from '../common/validate.js';
import { SystemService } from './system.service.js';

/** 화면용 설정값·전역 배너·조건 값 목록·감사 이력(계약 4.2·4.3·4.4절). */
@Controller('v1')
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly audit: AuditSearchService,
  ) {}

  @Get('settings')
  settings() {
    return this.system.settings();
  }

  @Get('notices')
  async notices() {
    return this.system.notices();
  }

  /** `지나간 일` 배너 확인. 저장된 배너의 ID만 받는다. */
  @Post('notices/:id/ack')
  @HttpCode(200)
  async ackNotice(@Param('id') id: string) {
    if (!/^[1-9][0-9]{0,18}$/.test(id)) throw errors.notFound();
    return this.system.ackNotice(id);
  }

  @Get('sources')
  async sources() {
    return this.system.sources();
  }

  /** 감사 이력. 거르는 값이 많아 본문으로 받는다. */
  @Post('audit/search')
  @HttpCode(200)
  async auditSearch(@Body() body: unknown) {
    return this.audit.search(parse(AuditSearchBody, body));
  }
}
