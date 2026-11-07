import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { sha256 } from '../auth/tokens.js';
import { errors } from '../common/api-error.js';
import { claimIdempotency, completeIdempotency } from '../common/idempotency.js';
import { Database, type Queryable, utc } from '../db/database.js';
import { newIngestKey } from './keys.js';
import { decodeConnectionId, encodeConnectionId } from './public-id.js';

/** 키 발급·교체를 받는 관리 상태(5.1절 상태별 동작). 발급은 유효 키 0개, 교체는 1개일 때다. */
const ISSUE_STATES = new Set(['pending', 'blocked']);
const ROTATE_STATES = new Set(['pending', 'active', 'stopping']);
const REVOKE_STATES = new Set(['pending', 'active', 'stopping']);

export interface IssuedKey {
  /** slot은 유효 키의 자리(1·2)다. 다시 받은 응답에서 그 키가 그 사이 폐기됐으면 null이다. */
  key: { key_id: string; key: string | null; issued_as: 'issue' | 'rotate'; slot: number | null; issued_at: string };
  connection: { id: string; management_state: string };
  /** 같은 Idempotency-Key로 다시 받은 응답이면 키 원문이 없다. 화면은 그 키를 폐기하고 다시 받으라고 안내한다(WQ-65). */
  secret_unavailable: boolean;
}

export interface KeyState {
  key_id: string;
  connection_id: string;
  state: string;
  issued_as: string;
  issued_at: string;
  revoke_requested_at: string | null;
  revoked_at: string | null;
  revoke_observed_at: string | null;
}

export interface RevokedKey {
  key: KeyState;
  /** CM-07 진행 단계: 요청 접수 → 중앙 확정(수신 서버가 하던 삽입을 마친 뒤) → 에이전트 관측. 아직이면 null이다. */
  stages: { requested: string | null; confirmed: string | null; agent_observed: string | null };
  audit_gap: boolean;
}

const KEY_COLUMNS = `k.key_id, k.connection_id, k.state, k.slot, k.issued_as, ${utc('k.issued_at')} AS issued_at,
  ${utc('k.revoke_requested_at')} AS revoke_requested_at, ${utc('k.revoked_at')} AS revoked_at,
  ${utc('k.revoke_observed_at')} AS revoke_observed_at`;

interface KeyRow {
  key_id: string;
  connection_id: number;
  state: string;
  slot: number | null;
  issued_as: string;
  issued_at: string;
  revoke_requested_at: string | null;
  revoked_at: string | null;
  revoke_observed_at: string | null;
}

function keyState(r: KeyRow): KeyState {
  return {
    key_id: r.key_id,
    connection_id: encodeConnectionId(r.connection_id),
    state: r.state,
    issued_as: r.issued_as,
    issued_at: r.issued_at,
    revoke_requested_at: r.revoke_requested_at,
    revoked_at: r.revoked_at,
    revoke_observed_at: r.revoke_observed_at,
  };
}

/**
 * 수집 키 발급·교체·폐기(계약 5.2절, Q10-07~11). 원문은 발급·교체 응답에 한 번만 준다. 폐기 요청 뒤 실제로 받지 않게 되는
 * 확정(`revoked`)과 에이전트 관측은 수신 서버가 기록한다.
 */
@Injectable()
export class KeysService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /**
   * 유효 키가 0개면 발급, 1개면 교체, 2개면 409 key_limit_reached다(WQ-66). 연결 행을 잠가 동시에 눌러도 유효 키가 둘을
   * 넘지 않는다(PT-10). 전송 차단 상태에서 발급하면 등록·연결 대기로 돌아간다. 감사를 쓸 수 없으면 보류한다(Q10-14).
   */
  async issueOrRotate(publicId: string, idemKey: string, accountId: number): Promise<IssuedKey> {
    const id = decodeConnectionId(publicId);
    if (id === null) throw errors.notFound();
    return this.db.tx(async (c) => {
      const claim = await claimIdempotency(c, accountId, idemKey, 'key.issue_or_rotate', sha256('key.issue_or_rotate', publicId));
      if (claim.kind === 'replay') return this.issuedView(c, String(claim.result.key_id), null);
      const conn = (await c.query<{ management_state: string }>('SELECT management_state FROM connections WHERE id = $1 FOR UPDATE', [id]))
        .rows[0];
      if (!conn) throw errors.notFound();
      if (conn.management_state === 'archived') throw errors.targetArchived();
      const slots = (await c.query<{ slot: number }>(`SELECT slot FROM ingest_keys WHERE connection_id = $1 AND state = 'valid'`, [id])).rows.map(
        (r) => r.slot,
      );
      if (slots.length >= 2) throw errors.keyLimitReached();
      const issuedAs = slots.length === 0 ? 'issue' : 'rotate';
      const allowed = issuedAs === 'issue' ? ISSUE_STATES : ROTATE_STATES;
      if (!allowed.has(conn.management_state)) throw errors.invalidState({ management_state: conn.management_state });
      const slot = slots.includes(1) ? 2 : 1;
      const key = newIngestKey();
      await c.query('INSERT INTO ingest_keys (key_id, connection_id, secret_hash, slot, issued_as) VALUES ($1, $2, $3, $4, $5)', [
        key.keyId,
        id,
        key.secretHash,
        slot,
        issuedAs,
      ]);
      // 전송 차단 → 등록·연결 대기(5.1절). 에이전트가 새 키로 보고하면 수신 서버가 사용으로 바꾼다.
      if (conn.management_state === 'blocked') {
        await c.query(`UPDATE connections SET management_state = 'pending', updated_at = now() WHERE id = $1`, [id]);
      }
      await this.audit.writeOrHold(c, {
        action: issuedAs === 'issue' ? 'key.issue' : 'key.rotate',
        result: 'success',
        accountId,
        targetType: 'key',
        targetRef: key.keyId,
      });
      await completeIdempotency(c, accountId, idemKey, 201, { key_id: key.keyId });
      return this.issuedView(c, key.keyId, key.key);
    });
  }

  /**
   * 키 폐기(Q10-11, 5.2절). 폐기 요청으로 바꾸면 수신 서버가 그 키의 새 요청을 바로 거부한다. 이미 폐기 요청·확정된 키는
   * 오류 없이 지금 상태를 준다. 긴급 예외라 감사를 쓸 수 없어도 차단 상태를 확정해 진행하고 공백으로 남긴다(Q10-14 (5)).
   */
  async revoke(keyId: string, accountId: number): Promise<RevokedKey> {
    if (!/^[a-z0-9]{1,64}$/.test(keyId)) throw errors.notFound();
    return this.db.tx(async (c) => {
      const row = (
        await c.query<KeyRow & { management_state: string }>(
          `SELECT ${KEY_COLUMNS}, c.management_state FROM ingest_keys k JOIN connections c ON c.id = k.connection_id
            WHERE k.key_id = $1 FOR UPDATE OF k, c`,
          [keyId],
        )
      ).rows[0];
      if (!row) throw errors.notFound();
      if (row.state === 'revoke_requested' || row.state === 'revoked') return this.revokedView(row, false);
      if (row.management_state === 'archived' || row.state === 'invalidated') throw errors.targetArchived();
      if (!REVOKE_STATES.has(row.management_state)) throw errors.invalidState({ management_state: row.management_state });
      const updated = (
        await c.query<KeyRow>(
          `UPDATE ingest_keys k SET state = 'revoke_requested', slot = NULL, revoke_requested_at = now()
            WHERE key_id = $1 RETURNING ${KEY_COLUMNS}`,
          [keyId],
        )
      ).rows[0];
      // 에이전트에 닿는 작업이라 단계마다 행을 남긴다(WQ-85). 확정·관측 단계는 수신 서버가 더한다.
      const audited = await this.audit.writeOrGap(c, {
        action: 'key.revoke',
        result: 'success',
        accountId,
        targetType: 'key',
        targetRef: keyId,
        stage: 'requested',
      });
      return this.revokedView(updated, !audited);
    });
  }

  private async issuedView(c: Queryable, keyId: string, key: string | null): Promise<IssuedKey> {
    const r = (
      await c.query<KeyRow & { management_state: string }>(
        `SELECT ${KEY_COLUMNS}, c.management_state FROM ingest_keys k JOIN connections c ON c.id = k.connection_id WHERE k.key_id = $1`,
        [keyId],
      )
    ).rows[0];
    return {
      key: { key_id: r.key_id, key, issued_as: r.issued_as as 'issue' | 'rotate', slot: r.slot, issued_at: r.issued_at },
      connection: { id: encodeConnectionId(r.connection_id), management_state: r.management_state },
      secret_unavailable: key === null,
    };
  }

  private revokedView(r: KeyRow, auditGap: boolean): RevokedKey {
    return {
      key: keyState(r),
      stages: { requested: r.revoke_requested_at, confirmed: r.revoked_at, agent_observed: r.revoke_observed_at },
      audit_gap: auditGap,
    };
  }
}
