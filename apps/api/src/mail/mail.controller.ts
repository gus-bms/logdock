import { Body, Controller, Get, HttpCode, Post, Put, Req, Res } from '@nestjs/common';

import { type ApiRequest, type ApiResponse, header } from '../common/http.js';
import { idempotencyKey } from '../common/idempotency.js';
import { parse } from '../common/validate.js';
import { ConfirmBody, MailService, OpsRecipientsBody, RuleTestMailBody, TestMailBody } from './mail.service.js';

/** 메일 상태·테스트 발송·운영 수신 주소(계약 4.3절, UI-14)와 규칙 편집의 테스트 메일(UI-07). */
@Controller('v1')
export class MailController {
  constructor(private readonly mail: MailService) {}

  @Get('mail')
  async status() {
    return this.mail.status();
  }

  /** 테스트 발송. Idempotency-Key가 필요하다. 끝나면 200, 같은 키로 다시 물었는데 아직 보내는 중이면 202다. */
  @Post('mail/test')
  async test(@Body() body: unknown, @Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const key = idempotencyKey(header(req, 'idempotency-key'));
    const r = await this.mail.testOne(parse(TestMailBody, body), key, req.session!.accountId);
    res.statusCode = r.status;
    return r.body;
  }

  /** 규칙의 테스트 메일. 저장 전 주소도 보낸다(WQ-41). 주소마다 결과를 준다. */
  @Post('alert-rules/test-mail')
  async ruleTest(@Body() body: unknown, @Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const key = idempotencyKey(header(req, 'idempotency-key'));
    const r = await this.mail.testRule(parse(RuleTestMailBody, body), key, req.session!.accountId);
    res.statusCode = r.status;
    return r.body;
  }

  @Get('mail/ops-recipients')
  async opsRecipients() {
    return this.mail.opsRecipients();
  }

  @Put('mail/ops-recipients')
  async putOpsRecipients(@Body() body: unknown, @Req() req: ApiRequest) {
    return this.mail.putOpsRecipients(parse(OpsRecipientsBody, body), req.session!.accountId);
  }

  @Post('mail/ops-recipients/confirm')
  @HttpCode(200)
  async confirmOps(@Body() body: unknown, @Req() req: ApiRequest) {
    return this.mail.confirmOps(parse(ConfirmBody, body).address, req.session!.accountId);
  }
}
