import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { z } from 'zod';

import { RequireReauth } from '../auth/auth.guard.js';
import { type ApiRequest, type ApiResponse, header } from '../common/http.js';
import { idempotencyKey } from '../common/idempotency.js';
import { parse } from '../common/validate.js';
import { ArchiveService } from './archive.service.js';
import { ConnectionEditService, PlacementBody, SettingsBody } from './connection-edit.service.js';
import { ConnectionBody } from './connection-input.js';
import { ConnectionViewsService, OBSERVATION_STATES } from './connection-views.service.js';
import { ConnectionsService } from './connections.service.js';
import { KeysService } from './keys.service.js';

const Flag = z.enum(['true', 'false']);
const ListParams = z.object({
  archived: Flag.optional(),
  observation: z.enum(OBSERVATION_STATES).optional(),
  needs_action: Flag.optional(),
  service_id: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(512).optional(),
});

/** 수집 연결(계약 4.3·5.1절). */
@Controller('v1/connections')
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly views: ConnectionViewsService,
    private readonly keys: KeysService,
    private readonly archives: ArchiveService,
    private readonly edits: ConnectionEditService,
  ) {}

  /** 서비스별 연결 목록(UI-10). 기본은 보관되지 않은 연결이고 `archived=true`면 보관된 연결이다. */
  @Get()
  async list(@Query() query: unknown) {
    const p = parse(ListParams, query);
    return this.views.list({
      archived: p.archived === 'true',
      observation: p.observation,
      needsAction: p.needs_action === 'true',
      serviceId: p.service_id,
      limit: p.limit ?? 50,
      cursor: p.cursor,
    });
  }

  /** 조치 필요 수(4.4절). 메뉴(CM-01)와 목록이 같은 계산을 쓴다. `/{id}`보다 먼저 둔다. */
  @Get('summary')
  async summary() {
    return this.views.summary();
  }

  /** 연결 상세(UI-12, 4.3절 연결 상세 항목). */
  @Get(':id')
  async detail(@Param('id') id: string) {
    return this.views.detail(id);
  }

  /**
   * 설정 수정(WQ-62). 형식·새 이벤트 시작 규칙·로그 시간대·이벤트 크기 상한·같은 폴더 안의 파일명 규칙을 고친다.
   * 새 설정 버전과 설정 파일을 돌려주며 에이전트에 다시 적용해야 한다. 최근 재확인이 필요하다.
   */
  @Patch(':id')
  @RequireReauth()
  async updateSettings(@Param('id') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    return this.edits.updateSettings(id, parse(SettingsBody, body), req.session!.accountId);
  }

  /** 환경 태그·서버 바꾸기(WQ-63). 중앙 표시 정보라 설정 버전을 만들지 않고 재확인 없이 감사에 남긴다. */
  @Patch(':id/placement')
  async updatePlacement(@Param('id') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    return this.edits.updatePlacement(id, parse(PlacementBody, body), req.session!.accountId);
  }

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

  /** 연결 보관(CM-07). 새 수신을 막고 유효 키를 모두 무효로 한다. 남은 대기는 에이전트에 보존한다(WQ-53). */
  @Post(':id/archive')
  @HttpCode(200)
  @RequireReauth()
  async archive(@Param('id') id: string, @Req() req: ApiRequest) {
    return this.archives.archiveConnection(id, req.session!.accountId);
  }

  /** 연결 재활성(CM-07). `등록·연결 대기`로 돌아가며 새 키를 받아야 한다(WQ-56). */
  @Post(':id/reactivate')
  @HttpCode(200)
  @RequireReauth()
  async reactivate(@Param('id') id: string, @Req() req: ApiRequest) {
    return this.archives.reactivateConnection(id, req.session!.accountId);
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
