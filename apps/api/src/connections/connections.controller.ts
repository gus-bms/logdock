import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';

import { RequireReauth } from '../auth/auth.guard.js';
import { type ApiRequest, type ApiResponse, header } from '../common/http.js';
import { idempotencyKey } from '../common/idempotency.js';
import { parse } from '../common/validate.js';
import { ConnectionBody } from './connection-input.js';
import { ConnectionsService } from './connections.service.js';
import { KeysService } from './keys.service.js';

/** 수집 연결(계약 4.3·5.1절). */
@Controller('v1/connections')
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly keys: KeysService,
  ) {}

  /** 등록 전 사전 검사(중복·형식). 아무것도 만들지 않는다. 통과하면 저장할 형태로 맞춘 값을 돌려준다. */
  @Post('validate')
  @HttpCode(200)
  async validate(@Body() body: unknown) {
    return this.connections.validate(parse(ConnectionBody, body));
  }

  /**
   * 등록 확정. 최근 재확인과 Idempotency-Key가 필요하다. 응답에 키 원문(한 번)과 설정 파일을 준다.
   * 같은 키로 다시 받은 응답은 키 원문 없이 처음 결과를 준다.
   */
  @Post()
  @HttpCode(201)
  @RequireReauth()
  async register(@Body() body: unknown, @Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const key = idempotencyKey(header(req, 'idempotency-key'));
    // 처음 응답과 같은 키로 다시 받은 응답 모두 201이다(저장한 결과의 상태 코드도 201).
    const r = await this.connections.register(parse(ConnectionBody, body), key, req.session!.accountId);
    res.setHeader('Cache-Control', 'no-store');
    return r.body;
  }

  /** 설정 내려받기. 키는 담지 않는다(WQ-64). */
  @Get(':id/config')
  async config(@Param('id') id: string) {
    return this.connections.configFile(id);
  }

  /**
   * 유효 키가 0개면 발급, 1개면 교체, 2개면 409 key_limit_reached(WQ-66). 최근 재확인과 Idempotency-Key가 필요하다.
   * 응답에 키 원문(한 번)과 어느 쪽인지(`issued_as`)를 준다.
   */
  @Post(':id/keys')
  @HttpCode(201)
  @RequireReauth()
  async issueKey(@Param('id') id: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const key = idempotencyKey(header(req, 'idempotency-key'));
    const r = await this.keys.issueOrRotate(id, key, req.session!.accountId);
    res.setHeader('Cache-Control', 'no-store');
    return r;
  }
}

/** 키 폐기(계약 5.2절). 요청 접수·중앙 확정 단계를 따로 돌려준다. */
@Controller('v1/keys')
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  @Post(':keyId/revoke')
  @HttpCode(200)
  @RequireReauth()
  async revoke(@Param('keyId') keyId: string, @Req() req: ApiRequest) {
    return this.keys.revoke(keyId, req.session!.accountId);
  }
}
