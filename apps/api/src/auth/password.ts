// 계정 비밀번호 해시(계약 4.1절 비밀 저장, T04).
// Node 내장 Argon2id에 OWASP 비밀번호 저장 지침의 최소 설정(메모리 19456KiB, 반복 2, 병렬 1)을 쓴다.
// 저장 형식은 비용 값이 함께 든 PHC 문자열이다: $argon2id$m=19456,t=2,p=1$<salt>$<hash> (base64, 끝 = 없음).
// 비용 값을 올리면 verify가 needsRehash를 알려 다음 로그인 때 새 값으로 다시 해시한다.
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Argon2Params {
  memory: number; // KiB
  passes: number;
  parallelism: number;
}

export const CURRENT: Argon2Params = { memory: 19456, passes: 2, parallelism: 1 };
const SALT_BYTES = 16;
const HASH_BYTES = 32;
/** 비교 비용을 묶으려고 이보다 긴 비밀번호는 받지 않는다. */
export const MAX_PASSWORD_LENGTH = 1024;

function derive(password: string, salt: Buffer, p: Argon2Params, tagLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      { message: normalize(password), nonce: salt, parallelism: p.parallelism, tagLength, memory: p.memory, passes: p.passes },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** 같은 글자가 조합형·완성형으로 달리 들어와도 맞도록 NFC로 맞춘다. */
function normalize(password: string): string {
  return password.normalize('NFC');
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string, p: Argon2Params = CURRENT): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, p, HASH_BYTES);
  return `$argon2id$m=${p.memory},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(hash)}`;
}

const PHC = /^\$argon2id\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** 저장한 해시와 맞는지 본다. 형식이 깨졌으면 맞지 않은 것으로 본다. */
export async function verifyPassword(password: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
  const m = PHC.exec(stored);
  if (!m) return { ok: false, needsRehash: false };
  const p: Argon2Params = { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) };
  const salt = Buffer.from(m[4], 'base64');
  const want = Buffer.from(m[5], 'base64');
  const got = await derive(password, salt, p, want.length);
  const ok = got.length === want.length && timingSafeEqual(got, want);
  const needsRehash =
    p.memory !== CURRENT.memory || p.passes !== CURRENT.passes || p.parallelism !== CURRENT.parallelism;
  return { ok, needsRehash: ok && needsRehash };
}
