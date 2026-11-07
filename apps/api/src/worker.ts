// logdock-worker 진입점. API와 같은 설정을 읽고, 알림·운영 메일 같은 백그라운드 작업을 돌린다(2026-11-07 A안).
// 실행: node dist/worker.js (npm run start:worker). SIGTERM·SIGINT에서 도는 회차를 끝내고 멈춘다.
import 'reflect-metadata';

import { Logger } from '@nestjs/common';

import { loadConfig } from './config.js';
import { Database } from './db/database.js';
import { Worker } from './worker/worker.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database(config);
  const worker = new Worker(db, config);
  await worker.start();
  const log = new Logger('Worker');
  log.log('logdock-worker started');
  const shutdown = async () => {
    log.log('stopping');
    await worker.stop();
    await db.onModuleDestroy();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  new Logger('Worker').error(`failed to start: ${(err as Error)?.message ?? 'unknown error'}`);
  process.exit(1);
});
