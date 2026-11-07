import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { SERVICE_COLUMNS, type ServiceView } from '../catalog/catalog.service.js';
import { errors } from '../common/api-error.js';
import { Database, type Queryable, utc } from '../db/database.js';
import { decodeConnectionId, encodeConnectionId } from './public-id.js';

interface Stages {
  requested: string;
  confirmed: string;
  agent_observed: null;
}

/**
 * 수집 연결·서비스 보관과 재활성(계약 5.1·5.3절, WQ-53~56). 보관은 중앙 새 수신을 막고 유효 키를 모두 무효로 하며, 남은 대기는
 * 에이전트에 보존한다. 과거 로그는 보관 기간까지 검색된다. 재활성은 같은 등록으로 돌아가되 옛 키는 살아나지 않아 새 키를 받는다.
 * 모두 최근 재확인이 필요하고(CM-07), 감사를 쓸 수 없으면 보류한다(Q10-14 (4)).
 */
@Injectable()
export class ArchiveService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** 연결 보관. 요청 접수와 중앙 확정(관리 상태 보관·새 수신 거부·유효 키 무효)이 이 트랜잭션에서 함께 일어난다. */
  async archiveConnection(publicId: string, accountId: number) {
    const id = this.connectionId(publicId);
    return this.db.tx(async (c) => {
      const row = (await c.query<{ management_state: string }>('SELECT management_state FROM connections WHERE id = $1 FOR UPDATE', [id]))
        .rows[0];
      if (!row) throw errors.notFound();
      if (row.management_state === 'archived') throw errors.targetArchived();
      const { at, invalidated } = await this.archiveRows(c, [id], false);
      await this.audit.writeOrHold(c, this.entry('connection.archive', accountId, publicId));
      return { connection: { id: publicId, management_state: 'archived', archived_at: at }, invalidated_keys: invalidated, stages: stages(at) };
    });
  }

  /**
   * 연결 재활성(WQ-56·67). `등록·연결 대기`로 돌아가고 유효 키가 없으므로 키 발급으로 새 키를 받는다. 서비스가 보관돼 있으면
   * 서비스를 먼저 재활성해야 한다. 같은 서버·같은 대상의 다른 연결이 그 사이 등록됐으면 409 duplicate_connection이다.
   */
  async reactivateConnection(publicId: string, accountId: number) {
    const id = this.connectionId(publicId);
    return this.db.tx(async (c) => {
      const row = (
        await c.query<{ management_state: string; service_state: string }>(
          `SELECT c.management_state, s.state AS service_state FROM connections c JOIN services s ON s.id = c.service_id
            WHERE c.id = $1 FOR UPDATE OF c`,
          [id],
        )
      ).rows[0];
      if (!row) throw errors.notFound();
      if (row.management_state !== 'archived') throw errors.invalidState({ management_state: row.management_state });
      if (row.service_state === 'archived') throw errors.targetArchived();
      await this.refuseDuplicates(c, [id]);
      const at = await this.reactivateRows(c, [id]);
      await this.audit.writeOrHold(c, this.entry('connection.reactivate', accountId, publicId));
      return { connection: { id: publicId, management_state: 'pending' }, stages: stages(at) };
    });
  }

  /**
   * 서비스 보관 전 영향(UI-10 상태 7): 하위 연결의 수신 차단과 보고된 대기, 이 서비스나 그 연결을 대상으로 쓰는 저장 검색과
   * 알림 규칙. 대기는 상태 보고에서 온 값이라 보고가 없는 연결은 모른다(null).
   */
  async serviceImpact(serviceId: number) {
    const service = (await this.db.query<ServiceView>(`SELECT ${SERVICE_COLUMNS} FROM services WHERE id = $1`, [serviceId])).rows[0];
    if (!service) throw errors.notFound();
    const conns = (
      await this.db.query<{ id: number; management_state: string; queue: { records?: number; bytes?: number; oldest_observed_at?: string } | null; reported_at: string | null }>(
        `SELECT c.id, c.management_state, st.report -> 'queue' AS queue, ${utc('st.last_report_at')} AS reported_at
           FROM connections c LEFT JOIN connection_status st ON st.connection_id = c.id
          WHERE c.service_id = $1 AND c.management_state <> 'archived' ORDER BY c.id`,
        [serviceId],
      )
    ).rows;
    const publicIds = conns.map((r) => encodeConnectionId(r.id));
    const uses = `(condition #> '{sources,service_ids}' @> to_jsonb($1::int) OR condition #> '{sources,connection_ids}' ?| $2::text[])`;
    const searches = (await this.db.query(`SELECT id, name FROM saved_searches WHERE ${uses} ORDER BY id`, [serviceId, publicIds])).rows;
    const rules = (
      await this.db.query(`SELECT id, name, enabled FROM alert_rules WHERE deleted_at IS NULL AND ${uses} ORDER BY id`, [serviceId, publicIds])
    ).rows;
    return {
      service,
      connections: conns.map((r) => ({
        id: encodeConnectionId(r.id),
        management_state: r.management_state,
        queue: r.queue ? { records: r.queue.records ?? null, bytes: r.queue.bytes ?? null, oldest_observed_at: r.queue.oldest_observed_at ?? null } : null,
        reported_at: r.reported_at,
      })),
      saved_searches: searches,
      alert_rules: rules,
    };
  }

  /** 서비스 보관(5.3절). 보관되지 않은 하위 연결을 모두 보관하고 `서비스와 함께 보관` 표시를 남긴다. */
  async archiveService(serviceId: number, accountId: number) {
    return this.db.tx(async (c) => {
      const service = (await c.query<ServiceView>(`SELECT ${SERVICE_COLUMNS} FROM services WHERE id = $1 FOR UPDATE`, [serviceId])).rows[0];
      if (!service) throw errors.notFound();
      if (service.state === 'archived') throw errors.targetArchived();
      const ids = (
        await c.query<{ id: number }>(`SELECT id FROM connections WHERE service_id = $1 AND management_state <> 'archived' ORDER BY id FOR UPDATE`, [
          serviceId,
        ])
      ).rows.map((r) => r.id);
      const { invalidated } = await this.archiveRows(c, ids, true);
      const updated = (
        await c.query<ServiceView>(
          `UPDATE services SET state = 'archived', archived_at = now(), version = version + 1, updated_at = now() WHERE id = $1
           RETURNING ${SERVICE_COLUMNS}`,
          [serviceId],
        )
      ).rows[0];
      await this.audit.writeOrHold(c, { action: 'service.archive', result: 'success', accountId, targetType: 'service', targetRef: String(serviceId) });
      for (const id of ids) await this.audit.writeOrHold(c, this.entry('connection.archive', accountId, encodeConnectionId(id), 'with_service'));
      return { service: updated, archived_connections: ids.map(encodeConnectionId), invalidated_keys: invalidated };
    });
  }

  /** 서비스 재활성(WQ-55). 서비스와 함께 보관된 연결만 `등록·연결 대기`로 되살리고, 그 전에 따로 보관한 연결은 그대로 둔다. */
  async reactivateService(serviceId: number, accountId: number) {
    return this.db.tx(async (c) => {
      const service = (await c.query<ServiceView>(`SELECT ${SERVICE_COLUMNS} FROM services WHERE id = $1 FOR UPDATE`, [serviceId])).rows[0];
      if (!service) throw errors.notFound();
      if (service.state !== 'archived') throw errors.invalidState({ state: service.state });
      const ids = (
        await c.query<{ id: number }>(`SELECT id FROM connections WHERE service_id = $1 AND archived_with_service ORDER BY id FOR UPDATE`, [serviceId])
      ).rows.map((r) => r.id);
      await this.refuseDuplicates(c, ids);
      await this.reactivateRows(c, ids);
      const updated = (
        await c.query<ServiceView>(
          `UPDATE services SET state = 'active', archived_at = NULL, version = version + 1, updated_at = now() WHERE id = $1
           RETURNING ${SERVICE_COLUMNS}`,
          [serviceId],
        )
      ).rows[0];
      await this.audit.writeOrHold(c, { action: 'service.reactivate', result: 'success', accountId, targetType: 'service', targetRef: String(serviceId) });
      for (const id of ids) await this.audit.writeOrHold(c, this.entry('connection.reactivate', accountId, encodeConnectionId(id), 'with_service'));
      return { service: updated, reactivated_connections: ids.map(encodeConnectionId) };
    });
  }

  private connectionId(publicId: string): number {
    const id = decodeConnectionId(publicId);
    if (id === null) throw errors.notFound();
    return id;
  }

  /** 에이전트에 닿는 작업이라 단계를 남긴다(WQ-85). 중앙 확정이 이 트랜잭션에서 일어나 `confirmed`로 남긴다. */
  private entry(action: string, accountId: number, publicId: string, reasonCode?: string) {
    return { action, result: 'success' as const, accountId, targetType: 'connection', targetRef: publicId, stage: 'confirmed' as const, reasonCode };
  }

  private async archiveRows(c: Queryable, ids: number[], withService: boolean): Promise<{ at: string; invalidated: number }> {
    const at = (await c.query<{ at: string }>(`SELECT ${utc('now()')} AS at`)).rows[0].at;
    if (ids.length === 0) return { at, invalidated: 0 };
    await c.query(
      `UPDATE connections SET management_state = 'archived', archived_at = now(), archived_with_service = $2,
              version = version + 1, updated_at = now()
        WHERE id = ANY($1)`,
      [ids, withService],
    );
    // 유효 키를 모두 무효로 한다. 재활성해도 살아나지 않는다(Q07-07). 폐기 요청 중인 키는 수신 서버가 확정한다.
    const r = await c.query(
      `UPDATE ingest_keys SET state = 'invalidated', slot = NULL, invalidated_at = now() WHERE connection_id = ANY($1) AND state = 'valid'`,
      [ids],
    );
    return { at, invalidated: r.rowCount ?? 0 };
  }

  private async reactivateRows(c: Queryable, ids: number[]): Promise<string> {
    if (ids.length > 0) {
      await c.query(
        `UPDATE connections SET management_state = 'pending', archived_at = NULL, archived_with_service = false,
                version = version + 1, updated_at = now()
          WHERE id = ANY($1)`,
        [ids],
      );
    }
    return (await c.query<{ at: string }>(`SELECT ${utc('now()')} AS at`)).rows[0].at;
  }

  /** 되살릴 연결과 같은 서버·같은 대상의 보관되지 않은 다른 연결이 있으면 막는다(Q07-06). 그 연결의 외부 ID를 준다. */
  private async refuseDuplicates(c: Queryable, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const r = await c.query<{ id: number }>(
      `SELECT o.id FROM connections a
         JOIN connections o ON o.server_id = a.server_id AND o.target_identity = a.target_identity AND o.id <> a.id
        WHERE a.id = ANY($1) AND a.server_id IS NOT NULL AND o.management_state <> 'archived'
        ORDER BY o.id LIMIT 1`,
      [ids],
    );
    if (r.rows[0]) throw errors.duplicateConnection(encodeConnectionId(r.rows[0].id));
  }
}

function stages(at: string): Stages {
  return { requested: at, confirmed: at, agent_observed: null };
}
