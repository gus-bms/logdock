import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { type ApiRequest, header } from '../common/http.js';
import { idempotencyKey } from '../common/idempotency.js';
import { idParam, parse } from '../common/validate.js';
import { CreateBody, SavedSearchesService, UpdateBody } from './saved-searches.service.js';

const ListParams = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(512).optional(),
});

/** 저장 검색(계약 4.3절, UI-05). 재확인과 감사 없이 쓴다(5.6절). */
@Controller('v1/saved-searches')
export class SavedSearchesController {
  constructor(private readonly searches: SavedSearchesService) {}

  @Get()
  async list(@Query() query: unknown, @Req() req: ApiRequest) {
    const p = parse(ListParams, query);
    return this.searches.list(req.session!.accountId, { limit: p.limit ?? 50, cursor: p.cursor });
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: ApiRequest) {
    return this.searches.get(req.session!.accountId, idParam(id));
  }

  /** 만들기. Idempotency-Key가 필요하다. 같은 키로 다시 받은 응답도 201이다. */
  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() req: ApiRequest) {
    const key = idempotencyKey(header(req, 'idempotency-key'));
    return this.searches.create(parse(CreateBody, body), key, req.session!.accountId);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const n = idParam(id);
    return this.searches.update(n, parse(UpdateBody, body), req.session!.accountId);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() req: ApiRequest) {
    await this.searches.remove(idParam(id), req.session!.accountId);
  }
}
