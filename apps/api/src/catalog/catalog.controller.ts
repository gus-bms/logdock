import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequireReauth } from '../auth/auth.guard.js';
import { errors } from '../common/api-error.js';
import type { ApiRequest } from '../common/http.js';
import { parse } from '../common/validate.js';
import { ArchiveService } from '../connections/archive.service.js';
import { CatalogService } from './catalog.service.js';

const Version = z.number().int().positive();
const ServiceRename = z.object({ name: z.string(), version: Version });
const ServerRename = z.object({ display_name: z.string(), version: Version });

/** 경로의 정수 ID. 정수가 아니면 그런 대상이 없는 것으로 본다. */
function idParam(raw: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw errors.notFound();
  const id = Number(raw);
  if (id > 2147483647) throw errors.notFound();
  return id;
}

/** 서비스·서버 목록과 이름 변경(계약 4.3·5.3절). 재확인 없이 감사에 남기고 감사 장애 때 보류한다(WQ-52). */
@Controller('v1')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly archives: ArchiveService,
  ) {}

  /** 서비스 보관 전 영향(UI-10 상태 7): 하위 연결의 수신 차단과 대기, 이 서비스를 쓰는 저장 검색·알림 규칙. */
  @Get('services/:id/archive-impact')
  async archiveImpact(@Param('id') id: string) {
    return this.archives.serviceImpact(idParam(id));
  }

  /** 서비스 보관(CM-07). 보관되지 않은 하위 연결을 모두 보관하고 `서비스와 함께 보관` 표시를 남긴다. */
  @Post('services/:id/archive')
  @HttpCode(200)
  @RequireReauth()
  async archiveService(@Param('id') id: string, @Req() req: ApiRequest) {
    return this.archives.archiveService(idParam(id), req.session!.accountId);
  }

  /** 서비스 재활성(CM-07). 서비스와 함께 보관된 연결만 되살린다(WQ-55). */
  @Post('services/:id/reactivate')
  @HttpCode(200)
  @RequireReauth()
  async reactivateService(@Param('id') id: string, @Req() req: ApiRequest) {
    return this.archives.reactivateService(idParam(id), req.session!.accountId);
  }

  @Get('services')
  async services() {
    return { items: await this.catalog.listServices() };
  }

  @Patch('services/:id')
  async renameService(@Param('id') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const serviceId = idParam(id);
    const input = parse(ServiceRename, body);
    return this.catalog.renameService(serviceId, input.name, input.version, req.session!.accountId);
  }

  @Get('servers')
  async servers() {
    return { items: await this.catalog.listServers() };
  }

  @Patch('servers/:id')
  async renameServer(@Param('id') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const serverId = idParam(id);
    const input = parse(ServerRename, body);
    return this.catalog.renameServer(serverId, input.display_name, input.version, req.session!.accountId);
  }
}
