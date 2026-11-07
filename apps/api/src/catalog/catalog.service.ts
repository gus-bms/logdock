import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';

import { AuditService } from '../audit/audit.service.js';
import { ApiError, errors } from '../common/api-error.js';
import { checkName } from '../common/names.js';
import { type AppConfig } from '../config.js';
import { Database, utc } from '../db/database.js';
import { APP_CONFIG } from '../tokens.js';

export interface ServiceView {
  id: number;
  name: string;
  state: 'active' | 'archived';
  archived_at: string | null;
  version: number;
}

export interface ServerView {
  id: number;
  display_name: string;
  version: number;
}

const SERVICE_COLUMNS = `id, name, state, ${utc('archived_at')} AS archived_at, version`;
const SERVER_COLUMNS = 'id, display_name, version';

/**
 * 서비스·서버 이름 목록과 이름 변경(계약 4.3·5.3절). 서비스와 서버는 수집 연결 등록 때 생기고, 이름을 바꿔도 ID가
 * 그대로라 기존 로그·저장 검색·알림 규칙의 대상이 바뀌지 않는다(Q07-03, SD-11). 이름 변경은 재확인 없이 감사에
 * 남기고, 감사를 쓸 수 없으면 바꾸지 않는다(WQ-52, Q10-14 (4)). 서비스 보관·재활성은 하위 수집 연결과 키를
 * 함께 바꾸므로 수집 연결과 같이 만든다.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 보관된 서비스도 함께 준다. 필터 값 목록에 보관된 서비스가 따로 나오고, 새 연결 등록은 화면이 고른다(WQ-57). */
  async listServices(): Promise<ServiceView[]> {
    const r = await this.db.query<ServiceView>(`SELECT ${SERVICE_COLUMNS} FROM services ORDER BY lower(name), id`);
    return r.rows;
  }

  async listServers(): Promise<ServerView[]> {
    const r = await this.db.query<ServerView>(`SELECT ${SERVER_COLUMNS} FROM servers ORDER BY lower(display_name), id`);
    return r.rows;
  }

  async renameService(id: number, rawName: string, version: number, accountId: number): Promise<ServiceView> {
    const name = this.name(rawName, 'name');
    return this.rename<ServiceView>({
      lock: `SELECT ${SERVICE_COLUMNS} FROM services WHERE id = $1 FOR UPDATE`,
      update: `UPDATE services SET name = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${SERVICE_COLUMNS}`,
      id,
      value: name,
      version,
      current: (row) => row.name,
      // 보관된 서비스는 이름을 바꿀 수 없다. 쓰려면 먼저 재활성한다(WQ-54).
      refuse: (row) => (row.state === 'archived' ? errors.targetArchived() : null),
      field: 'name',
      uniqueIndex: 'services_name_uq',
      audit: { action: 'service.rename', targetType: 'service', accountId },
    });
  }

  async renameServer(id: number, rawName: string, version: number, accountId: number): Promise<ServerView> {
    const name = this.name(rawName, 'display_name');
    return this.rename<ServerView>({
      lock: `SELECT ${SERVER_COLUMNS} FROM servers WHERE id = $1 FOR UPDATE`,
      update: `UPDATE servers SET display_name = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${SERVER_COLUMNS}`,
      id,
      value: name,
      version,
      current: (row) => row.display_name,
      refuse: () => null,
      field: 'display_name',
      uniqueIndex: 'servers_display_name_uq',
      audit: { action: 'server.rename', targetType: 'server', accountId },
    });
  }

  private name(raw: string, path: string): string {
    const c = checkName(raw, this.config.nameMaxLength);
    if (!c.ok) throw errors.validation([{ path, reason: c.reason }]);
    return c.value;
  }

  /**
   * 이름 변경의 공통 순서: 행 잠금 → 대상 상태 → version 비교 → 그대로면 바꾸지 않음 → 바꾸고 감사.
   * 이름이 겹치면(보관된 대상 포함, 대소문자 무시) 유일 색인이 막고 name_taken으로 답한다.
   */
  private async rename<T extends { id: number; version: number }>(o: {
    lock: string;
    update: string;
    id: number;
    value: string;
    version: number;
    current: (row: T) => string;
    refuse: (row: T) => ApiError | null;
    field: string;
    uniqueIndex: string;
    audit: { action: string; targetType: string; accountId: number };
  }): Promise<T> {
    try {
      return await this.db.tx(async (c) => {
        const row = (await c.query<T>(o.lock, [o.id])).rows[0];
        if (!row) throw errors.notFound();
        const refused = o.refuse(row);
        if (refused) throw refused;
        if (row.version !== o.version) throw errors.versionConflict(row);
        // 같은 이름(대소문자까지 같음)이면 바꾸지 않고 감사도 남기지 않는다.
        if (o.current(row) === o.value) return row;
        const updated = (await c.query<T>(o.update, [o.id, o.value])).rows[0];
        await this.audit.writeOrHold(c, {
          action: o.audit.action,
          result: 'success',
          accountId: o.audit.accountId,
          targetType: o.audit.targetType,
          targetRef: String(o.id),
          changedFields: [o.field],
        });
        return updated;
      });
    } catch (err) {
      const e = err as pg.DatabaseError;
      if (e?.code === '23505' && e.constraint === o.uniqueIndex) throw errors.nameTaken(o.field);
      throw err;
    }
  }
}
