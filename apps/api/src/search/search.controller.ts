import { Body, Controller, Delete, HttpCode, Param, Post, Req } from '@nestjs/common';

import { errors } from '../common/api-error.js';
import type { ApiRequest } from '../common/http.js';
import { parse } from '../common/validate.js';
import { EmptyBody, PageBody, SearchBody, UnknownBody } from './search-input.js';
import { SearchService } from './search.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 경로의 실행 ID. 꼴이 틀리면 그런 실행이 없는 것과 같이 `410 run_expired`다. */
function runId(raw: string): string {
  if (!UUID.test(raw)) throw errors.runExpired();
  return raw.toLowerCase();
}

/** 검색 요청 본문. 조건·시간 칸의 꼴 오류는 `condition_invalid`, 나머지 칸은 `validation_failed`다(4.5절). */
function parseSearch(body: unknown): SearchBody {
  const r = SearchBody.safeParse(body ?? {});
  if (r.success) return { ...r.data, run_id: r.data.run_id.toLowerCase() };
  const fields = r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), reason: i.code }));
  if (fields.every((f) => f.path.startsWith('condition') || f.path.startsWith('time'))) throw errors.conditionInvalid(fields);
  throw errors.validation(fields);
}

/** 검색과 판정 불가 보기·발생량·분포·취소(계약 4.2절). 실행 기준은 세션에 묶인다. */
@Controller('v1/search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Post()
  @HttpCode(200)
  async start(@Body() body: unknown, @Req() req: ApiRequest) {
    return this.search.start(req.session!, parseSearch(body));
  }

  @Post(':runId/page')
  @HttpCode(200)
  async page(@Param('runId') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const run = runId(id);
    return this.search.page(req.session!, run, parse(PageBody, body).cursor);
  }

  @Post(':runId/unknown')
  @HttpCode(200)
  async unknown(@Param('runId') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const run = runId(id);
    return this.search.unknown(req.session!, run, parse(UnknownBody, body).cursor);
  }

  @Post(':runId/histogram')
  @HttpCode(200)
  async histogram(@Param('runId') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const run = runId(id);
    parse(EmptyBody, body);
    return this.search.histogram(req.session!, run);
  }

  @Post(':runId/distribution')
  @HttpCode(200)
  async distribution(@Param('runId') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const run = runId(id);
    parse(EmptyBody, body);
    return this.search.distribution(req.session!, run);
  }

  @Delete(':runId')
  @HttpCode(200)
  async cancel(@Param('runId') id: string, @Req() req: ApiRequest) {
    return this.search.cancel(req.session!, runId(id));
  }
}
