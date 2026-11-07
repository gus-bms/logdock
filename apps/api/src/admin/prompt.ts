// 로컬 명령의 비밀번호 입력. 명령 인자로는 받지 않는다. 프로세스 목록과 셸 기록에 남기 때문이다.
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

/** 사용자가 고칠 수 있는 입력 오류. 실행 파일이 종료 코드 2로 끝낸다. */
export class UsageError extends Error {}

/**
 * 새 비밀번호를 받는다. 터미널이면 화면에 보이지 않게 두 번 받아 맞춰 보고, 아니면 표준 입력의 첫 줄을 받는다.
 * 줄 끝(\n, \r\n)만 떼고 앞뒤 공백은 비밀번호의 일부로 둔다.
 */
export async function readNewPassword(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  if (input.isTTY) {
    const first = await askHidden('새 비밀번호: ', input, output);
    const second = await askHidden('새 비밀번호 확인: ', input, output);
    if (first !== second) throw new UsageError('두 번 입력한 비밀번호가 다릅니다.');
    return first;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  const line = Buffer.concat(chunks).toString('utf8').split(/\r?\n/u)[0];
  if (line === '') throw new UsageError('표준 입력의 첫 줄에 비밀번호가 없습니다.');
  return line;
}

async function askHidden(question: string, input: NodeJS.ReadStream, output: NodeJS.WritableStream): Promise<string> {
  let muted = false;
  // 질문은 보이고 입력한 글자는 화면에 되풀이되지 않게 한다.
  const sink = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input, output: sink, terminal: true });
  try {
    const answer = rl.question(question);
    muted = true;
    return await answer;
  } finally {
    rl.close();
    output.write('\n');
  }
}
