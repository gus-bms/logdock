import { Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
import { z } from 'zod';

import { errors } from '../common/api-error.js';
import type { ApiRequest } from '../common/http.js';
import { parse } from '../common/validate.js';
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
  constructor(private readonly catalog: CatalogService) {}

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
