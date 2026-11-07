import { createApp } from './app.js';
import { loadConfig } from './config.js';

async function bootstrap(): Promise<void> {
  const app = await createApp(loadConfig());
  await app.listen(3001, '127.0.0.1');
}

bootstrap().catch((error: unknown) => {
  console.error('LogDock API를 시작하지 못했습니다.', error);
  process.exitCode = 1;
});
