import { createApp } from './app.js';
import { loadConfig } from './config.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  // 연결 설정 파일에 넣을 수신 서버 주소가 없으면 시작하지 않는다(계약 8.1절: 설정이 틀리면 시작하지 않는다).
  if (!config.ingestUrl) throw new Error('LOGDOCK_INGEST_URL is required (the https address agents send to)');
  const app = await createApp(config);
  await app.listen(3001, '127.0.0.1');
}

bootstrap().catch((error: unknown) => {
  console.error('LogDock API를 시작하지 못했습니다.', error);
  process.exitCode = 1;
});
