// 수집 키(계약 2.2절): `ldk_<키 ID>_<비밀 값>`. 키 ID는 비밀이 아니며 화면의 키 메타데이터와 감사에 쓴다. 비밀 값은
// 무작위 32바이트(base64url 43자)이고 중앙은 해시만 둔다. 원문은 발급·교체 응답에서 한 번만 준다(Q10-08).
import { randomBytes } from 'node:crypto';

import { sha256 } from '../auth/tokens.js';

export interface NewIngestKey {
  keyId: string;
  /** 원문. 응답에 한 번만 담고 어디에도 저장하지 않는다. */
  key: string;
  secretHash: Buffer;
}

/**
 * 비밀 값의 해시. 수신 서버도 같은 식으로 맞춘다: SHA-256("ingest_key" 0x00 비밀 32바이트 0x00).
 * 세션 ID와 같은 도구를 쓰며 무작위 값이라 느린 해시가 필요 없다(4.1절 비밀 저장).
 */
export function ingestKeyHash(secret: Buffer): Buffer {
  return sha256('ingest_key', secret);
}

export function newIngestKey(): NewIngestKey {
  const keyId = randomBytes(8).toString('hex');
  const secret = randomBytes(32);
  return { keyId, key: `ldk_${keyId}_${secret.toString('base64url')}`, secretHash: ingestKeyHash(secret) };
}

/** 키 원문을 키 ID와 비밀 값으로 나눈다. 꼴이 다르면 null이다. 비밀 값에는 `_`가 들어갈 수 있다. */
export function parseIngestKey(key: string): { keyId: string; secret: Buffer } | null {
  const m = /^ldk_([a-z0-9]+)_([A-Za-z0-9_-]{43})$/.exec(key);
  if (!m) return null;
  const secret = Buffer.from(m[2], 'base64url');
  return secret.length === 32 ? { keyId: m[1], secret } : null;
}
