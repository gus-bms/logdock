// 중복 요청 방지(계약 4.1절). 무언가를 새로 만드는 요청은 화면이 만든 Idempotency-Key 헤더를 단다.
// 키 행을 작업과 같은 트랜잭션의 처음에 넣어 유일 제약이 두 번째 실행을 막는다. 같은 키의 앞 요청이 아직 처리 중이면
// PostgreSQL이 그 트랜잭션이 끝날 때까지 이 INSERT를 기다리게 하므로, 뒤 요청은 앞 요청의 결과를 받는다.
// 실행 전에 거절한 응답(재확인 필요·입력 오류·감사 장애 보류)은 트랜잭션과 함께 되돌려져 남지 않아 같은 키로 다시 보낼 수 있다.
// 결과에는 대상 ID만 두고 비밀 값은 두지 않는다(3.4절).
import type { Queryable } from '../db/database.js';
import { errors } from './api-error.js';

export type Claim = { kind: 'new' } | { kind: 'replay'; status: number; result: Record<string, unknown> };

/** 헤더 값을 검사한다. UUID 같은 8~128자의 영문자·숫자·`-`·`_`만 받는다. */
export function idempotencyKey(raw: string | undefined): string {
  if (raw === undefined || raw === '') throw errors.validation([{ path: 'Idempotency-Key', reason: 'required' }]);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(raw)) throw errors.validation([{ path: 'Idempotency-Key', reason: 'invalid' }]);
  return raw;
}

/** 키를 잡는다. 처음이면 new, 같은 요청이 이미 끝났으면 그 결과(replay), 내용이 다르면 409 idempotency_key_reused다. */
export async function claimIdempotency(
  c: Queryable,
  accountId: number,
  key: string,
  kind: string,
  requestHash: Buffer,
): Promise<Claim> {
  const inserted = await c.query(
    `INSERT INTO idempotency_keys (account_id, idem_key, request_kind, request_hash, status_code, result)
     VALUES ($1, $2, $3, $4, 0, '{}') ON CONFLICT (account_id, idem_key) DO NOTHING`,
    [accountId, key, kind, requestHash],
  );
  if (inserted.rowCount) return { kind: 'new' };
  const row = (
    await c.query<{ request_kind: string; request_hash: Buffer; status_code: number; result: Record<string, unknown> }>(
      'SELECT request_kind, request_hash, status_code, result FROM idempotency_keys WHERE account_id = $1 AND idem_key = $2',
      [accountId, key],
    )
  ).rows[0];
  if (!row || row.request_kind !== kind || !row.request_hash.equals(requestHash)) throw errors.idempotencyKeyReused();
  return { kind: 'replay', status: row.status_code, result: row.result };
}

/** 작업이 끝나면 같은 트랜잭션에서 결과를 남긴다. */
export async function completeIdempotency(
  c: Queryable,
  accountId: number,
  key: string,
  status: number,
  result: Record<string, unknown>,
): Promise<void> {
  await c.query('UPDATE idempotency_keys SET status_code = $3, result = $4 WHERE account_id = $1 AND idem_key = $2', [
    accountId,
    key,
    status,
    result,
  ]);
}
