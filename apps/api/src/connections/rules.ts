// 수집 대상·형식 검사(계약 2.8절)를 에이전트와 같은 Go 코드로 한다. agent/internal/rules를 WebAssembly로 빌드한
// apps/api/wasm/rules.wasm을 처음 한 번 불러 두고 함수처럼 부른다(npm run build:wasm). 정규식은 Go(RE2) 문법으로
// 컴파일하므로, 화면에서 통과한 새 이벤트 시작 규칙을 에이전트가 거부하는 일이 없다.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RuleTarget {
  type: string;
  path: string;
  kind: string;
  name: string;
}

export interface RuleProblem {
  /** 설정 파일의 키이자 요청 본문의 경로(target.path 등). */
  field: string;
  code: string;
  message: string;
  /** 정규식 오류가 난 부분. */
  expr?: string;
}

type CheckFn = (request: string) => string;

// 이 앱의 TypeScript 설정은 DOM 타입을 넣지 않아 WebAssembly 전역 타입이 없다. 쓰는 만큼만 적는다.
interface GoRuntime {
  importObject: object;
  run(instance: object): Promise<void>;
}
interface WasmGlobals {
  WebAssembly: { instantiate(bytes: Uint8Array, imports: object): Promise<{ instance: object }> };
  Go: new () => GoRuntime;
  logdockCheckConnection?: CheckFn;
}
const globals = globalThis as unknown as WasmGlobals;

let check: CheckFn | undefined;
let loading: Promise<void> | undefined;

function wasmDir(): string {
  for (let dir = __dirname; ; ) {
    const candidate = join(dir, 'wasm');
    if (existsSync(join(candidate, 'rules.wasm'))) return candidate;
    const up = dirname(dir);
    if (up === dir) throw new Error(`wasm/rules.wasm not found above ${__dirname}; run npm run build:wasm`);
    dir = up;
  }
}

/** WebAssembly를 불러 둔다. 여러 번 불러도 한 번만 읽는다. */
export function loadRules(): Promise<void> {
  loading ??= (async () => {
    const dir = wasmDir();
    // Go 배포본의 실행 도구가 전역 Go 클래스를 만든다.
    require(join(dir, 'wasm_exec.js'));
    const go = new globals.Go();
    const { instance } = await globals.WebAssembly.instantiate(readFileSync(join(dir, 'rules.wasm')), go.importObject);
    // Go 프로그램은 select{}로 살아 있으며 끝나지 않는다. 내보낸 함수가 준비된 뒤 돌아온다.
    void go.run(instance);
    const fn = globals.logdockCheckConnection;
    if (typeof fn !== 'function') throw new Error('rules.wasm did not export logdockCheckConnection');
    check = fn;
  })();
  return loading;
}

/** 수집 대상과 형식을 검사한다. unit 이름에 종류 접미사를 붙이는 등 맞춘 대상과 문제 목록을 돌려준다. */
export function checkTargetAndFormat(
  target: { type: string; path?: string | null; kind?: string | null; name?: string | null },
  format: { type: string; event_start?: string | null },
): { target: RuleTarget; problems: RuleProblem[] } {
  if (!check) throw new Error('rules are not loaded; call loadRules() first');
  const request = {
    target: { type: target.type, path: target.path ?? '', kind: target.kind ?? '', name: target.name ?? '' },
    format: { type: format.type, event_start: format.event_start ?? '' },
  };
  const out = JSON.parse(check(JSON.stringify(request))) as { target: RuleTarget; problems: RuleProblem[] | null; error?: string };
  if (out.error) throw new Error(`rules.wasm: ${out.error}`);
  return { target: out.target, problems: out.problems ?? [] };
}
