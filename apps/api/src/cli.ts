// 중앙 로컬 명령의 실행 파일(계약 8.2절). 지금은 빌드한 뒤 `node dist/cli.js admin set-password --name admin`처럼
// 부른다. 설치 때 `logdock` 명령으로 묶는 방식은 배포 방식과 함께 정한다. DB 접속은 API와 같은 LOGDOCK_DB_* 설정이다.
import { parseArgs } from 'node:util';

import { AdminCommands } from './admin/admin.js';
import { readNewPassword, UsageError } from './admin/prompt.js';
import type { PasswordProblem } from './auth/password-policy.js';
import { MAX_PASSWORD_LENGTH } from './auth/password.js';
import { loadConfig } from './config.js';
import { Database } from './db/database.js';

const USAGE = `사용법:
  logdock admin set-password --name 계정이름     설치 때 공용 계정과 초기 비밀번호를 만든다
  logdock admin reset-password [--name 계정이름]  분실·잠금 때 비밀번호를 다시 정하고 모든 웹 세션을 끝낸다
비밀번호는 터미널에서 두 번 입력하거나 표준 입력의 첫 줄로 넘긴다. 명령 인자로는 받지 않는다.`;

const PROBLEMS: Record<PasswordProblem, string> = {
  password_too_short: '비밀번호는 15자 이상이어야 합니다.',
  password_too_long: `비밀번호가 너무 깁니다(최대 ${MAX_PASSWORD_LENGTH}자).`,
  password_common:
    '흔하거나 예측하기 쉬운 비밀번호입니다(유출 목록의 값, 되풀이·연속 문자, 서비스·계정 이름에 숫자만 더한 값). 다른 비밀번호를 정하세요.',
};

/** 명령을 실행하고 종료 코드를 돌려준다. 0 성공, 1 실행 오류, 2 사용법·입력 오류. */
export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: { input?: NodeJS.ReadStream; out?: NodeJS.WritableStream; err?: NodeJS.WritableStream } = {},
): Promise<number> {
  const out = io.out ?? process.stdout;
  const err = io.err ?? process.stderr;
  const say = (s: string) => out.write(`${s}\n`);
  const fail = (s: string, code = 2) => {
    err.write(`${s}\n`);
    return code;
  };

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { name: { type: 'string' } }, allowPositionals: true, strict: true });
  } catch (e) {
    return fail(`${(e as Error).message}\n${USAGE}`);
  }
  const [group, command, ...rest] = parsed.positionals;
  const name = parsed.values.name;
  if (group !== 'admin' || rest.length > 0 || (command !== 'set-password' && command !== 'reset-password')) {
    return fail(USAGE);
  }
  if (command === 'set-password' && name === undefined) return fail(`set-password에는 --name이 필요합니다.\n${USAGE}`);

  const config = loadConfig(env);
  const db = new Database(config);
  try {
    const password = await readNewPassword(io.input ?? process.stdin, err);
    const admin = new AdminCommands(db, config);
    if (command === 'set-password') {
      const r = await admin.setPassword(name!, password);
      switch (r.kind) {
        case 'exists':
          return fail('계정이 이미 있어 바꾸지 않았습니다. 분실·잠금에는 reset-password를 쓰세요.');
        case 'bad_name':
          return fail(`계정 이름은 앞뒤 공백을 뺀 1~${config.nameMaxLength}자이고 제어 문자를 쓸 수 없습니다.`);
        case 'invalid':
          return fail(PROBLEMS[r.reason]);
      }
      say(`계정 '${r.accountName}'을 만들고 초기 비밀번호를 정했습니다.`);
      if (r.auditGap) say('감사 기록을 남기지 못해 감사 공백으로 남겼습니다.');
      return 0;
    }
    const r = await admin.resetPassword(name, password);
    switch (r.kind) {
      case 'not_found':
        return fail(name === undefined ? '계정이 없습니다. 설치 때 set-password로 먼저 만드세요.' : `계정 '${name}'이 없습니다.`);
      case 'ambiguous':
        return fail('계정이 둘 이상입니다. --name으로 계정을 고르세요.');
      case 'invalid':
        return fail(PROBLEMS[r.reason]);
    }
    say(`계정 '${r.accountName}'의 비밀번호를 바꿨습니다. 웹 세션 ${r.terminated}개를 끝내고 로그인 시도 제한과 잠금을 풀었습니다.`);
    if (r.auditGap) say('감사 기록을 남기지 못해 감사 공백으로 남겼습니다.');
    return 0;
  } catch (e) {
    if (e instanceof UsageError) return fail(e.message);
    // 비밀번호는 오류 문구에 담기지 않는다. DB 접속 오류 등은 원인 문구만 보인다.
    return fail(`실행하지 못했습니다: ${(e as Error).message}`, 1);
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
