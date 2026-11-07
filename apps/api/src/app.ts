import 'reflect-metadata';

import { type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';

import { AppModule } from './app.module.js';
import { ApiErrorFilter } from './common/error.filter.js';
import type { ApiRequest, ApiResponse } from './common/http.js';
import { type AppConfig } from './config.js';

/** 앱을 만든다. 실행 파일과 시험이 함께 쓴다. */
export async function createApp(config: AppConfig, logger: LogLevel[] | false = ['error', 'warn', 'log']) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    // JSON 본문만 받는다. 다른 사이트의 폼 전송(urlencoded)이 본문으로 읽히지 않게 한다.
    bodyParser: false,
    logger,
  });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use((req: ApiRequest, res: ApiResponse, next: () => void) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  });
  app.useBodyParser('json', { limit: config.bodyLimit });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiErrorFilter());
  app.enableShutdownHooks();
  return app;
}
