import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 무작위 32바이트. 세션 ID와 CSRF 토큰에 쓴다(계약 4.1절 비밀 저장). */
export function newToken(): Buffer {
  return randomBytes(32);
}

export function toBase64Url(b: Buffer): string {
  return b.toString('base64url');
}

/** base64url 토큰을 읽는다. 32바이트가 아니면 null이다. */
export function fromBase64Url(s: string | undefined): Buffer | null {
  if (!s || !/^[A-Za-z0-9_-]{43}$/.test(s)) return null;
  const b = Buffer.from(s, 'base64url');
  return b.length === 32 ? b : null;
}

/** 단방향 해시. 무작위 값이라 느린 해시가 필요 없다. */
export function sha256(...parts: (string | Buffer)[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(p);
    h.update('\0');
  }
  return h.digest();
}

/** 같은 길이일 때 일정 시간으로 비교한다. */
export function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
