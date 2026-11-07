// 수집 대상·형식 검사(agent/internal/rules)를 WebAssembly로 빌드해 apps/api/wasm/에 둔다. 조회·관리 API의 등록과
// 사전 검사가 에이전트와 같은 Go 코드로 규칙을 검사하게 한다(계약 2.8절). Go(고정 버전 1.27)가 필요하다.
// 결과물은 빌드 산출물이라 저장소에 두지 않는다(.gitignore).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const agentDir = join(apiDir, '..', '..', 'agent');
const outDir = join(apiDir, 'wasm');

mkdirSync(outDir, { recursive: true });
execFileSync(
  'go',
  ['build', '-trimpath', '-ldflags=-s -w', '-o', join(outDir, 'rules.wasm'), './cmd/logdock-rules'],
  { cwd: agentDir, env: { ...process.env, GOOS: 'js', GOARCH: 'wasm' }, stdio: 'inherit' },
);
// Go 배포본에 든 실행 도구. Go 프로그램이 기대하는 전역(Go 클래스)을 만든다.
const goroot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
copyFileSync(join(goroot, 'lib', 'wasm', 'wasm_exec.js'), join(outDir, 'wasm_exec.js'));
