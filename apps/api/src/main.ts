import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  await app.listen(3001, '127.0.0.1');
}

bootstrap().catch((error: unknown) => {
  console.error('LogDock API를 시작하지 못했습니다.', error);
  process.exitCode = 1;
});
