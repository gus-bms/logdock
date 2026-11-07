// 새 비밀번호 규칙(Q10-03, 계약 4.3절 `비밀번호 규칙`). 웹의 비밀번호 변경과 로컬 명령(set-password·reset-password)이
// 같이 쓴다. NIST SP 800-63B-4를 따른다: 단일 요소 비밀번호는 15자 이상이고 글자 수는 유니코드 코드 포인트로 센다.
// 새 비밀번호는 흔하거나 예상되거나 유출된 값의 목록과 비밀번호 전체를 비교한다. 들어 있는 낱말(부분 문자열)로는
// 막지 않는다. 글자 종류를 섞으라는 조합 규칙은 두지 않는다.
import { COMMON_PASSWORDS } from './common-passwords.js';
import { MAX_PASSWORD_LENGTH } from './password.js';

export const MIN_PASSWORD_CODE_POINTS = 15;
/** 서비스 이름. 계정 이름과 함께 이 서비스에 맞춰 예상되는 값을 막는 데 쓴다. */
const SERVICE_NAME = 'logdock';

export type PasswordProblem = 'password_too_short' | 'password_too_long' | 'password_common';

/**
 * 차단 목록과 비교하는 형태. 호환 문자를 펴고(NFKC, 전각 숫자 → 반각 등) 소문자로 바꾸고 공백을 뺀다.
 * 해시에 쓰는 형태(NFC, password.ts)와 다르며 비교에만 쓴다. scripts/build-common-passwords.mjs와 같아야 한다.
 */
export function blocklistKey(password: string): string {
  return password.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

const BLOCKED: ReadonlySet<string> = new Set(COMMON_PASSWORDS);

/** 새 비밀번호의 문제를 하나 돌려준다. 문제가 없으면 null. accountName은 이 서비스에 맞춰 예상되는 값을 막는 데 쓴다. */
export function checkNewPassword(password: string, accountName: string): PasswordProblem | null {
  // 로그인이 받는 길이(UTF-16 단위)를 넘으면 다른 검사 전에 돌려보낸다.
  if (password.length > MAX_PASSWORD_LENGTH) return 'password_too_long';
  // 해시하는 형태(NFC)의 코드 포인트로 센다. 조합형 한글은 NFC에서 완성형 한 글자가 된다.
  if ([...password.normalize('NFC')].length < MIN_PASSWORD_CODE_POINTS) return 'password_too_short';
  const key = blocklistKey(password);
  if (BLOCKED.has(key) || onlyContextWords(key, accountName) || repeats(key) || sequential(key)) {
    return 'password_common';
  }
  return null;
}

/**
 * 비밀번호 전체가 서비스 이름·계정 이름에 숫자·기호만 더한 값인지(예: `LogDock-2026-logdock`).
 * NIST가 목록에 넣으라고 한 서비스 이름·계정 이름과 그 변형이다. 이 낱말이 들어 있기만 한 비밀번호와,
 * 이 낱말 없이 숫자만으로 된 비밀번호는 막지 않는다(글자 종류 조합 규칙이 되지 않게).
 */
function onlyContextWords(key: string, accountName: string): boolean {
  const words = [SERVICE_NAME, blocklistKey(accountName)]
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length > 0)
    .sort((a, b) => b.length - a.length);
  let rest = key.replace(/[^\p{L}\p{N}]/gu, '');
  let found = false;
  for (const w of words) {
    const parts = rest.split(w);
    if (parts.length > 1) found = true;
    rest = parts.join('');
  }
  return found && rest.replace(/\p{N}/gu, '').length === 0;
}

/** 짧은 덩어리를 되풀이한 값(예: `aaaaaaaaaaaaaaa`, `passwordpassword`). 마지막 덩어리는 잘려도 된다. */
function repeats(key: string): boolean {
  const cps = [...key];
  const n = cps.length;
  // 공백을 빼면 한 글자 이하만 남는 값도 여기서 막는다.
  if (n <= 1) return true;
  for (let p = 1; p <= n / 2; p++) {
    let periodic = true;
    for (let i = p; i < n && periodic; i++) periodic = cps[i] === cps[i - p];
    if (periodic) return true;
  }
  return false;
}

/** 숫자·알파벳·자판 줄을 한 방향으로 이어 친 값(예: `123456789012345`, `qwertyuiopasdfgh`). 끝에서 처음으로 넘어가도 잇는다. */
const SEQUENCES = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm'];

function sequential(key: string): boolean {
  const cps = [...key];
  for (const alphabet of SEQUENCES) {
    const at = cps.map((ch) => alphabet.indexOf(ch));
    if (at.some((i) => i < 0)) continue;
    const n = alphabet.length;
    for (const step of [1, n - 1]) {
      if (at.every((v, i) => i === 0 || v === (at[i - 1] + step) % n)) return true;
    }
  }
  return false;
}
