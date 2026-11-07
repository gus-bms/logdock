import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type pg from 'pg';

import { AuditService } from '../audit/audit.service.js';
import { sha256 } from '../auth/tokens.js';
import { SERVICE_COLUMNS, type ServiceView } from '../catalog/catalog.service.js';
import { errors } from '../common/api-error.js';
import { claimIdempotency, completeIdempotency } from '../common/idempotency.js';
import { type AppConfig } from '../config.js';
import { Database, type Queryable, utc } from '../db/database.js';
import { APP_CONFIG } from '../tokens.js';
import { type ConfigContent, configContent, renderToml } from './config-file.js';
import { checkConnectionInput, type ConnectionBody, type ConnectionInput, type ServiceChoice, targetIdentity } from './connection-input.js';
import { newIngestKey } from './keys.js';
import { decodeConnectionId, encodeConnectionId } from './public-id.js';
import { loadRules } from './rules.js';

export interface ValidatedConnection {
  valid: true;
  service: { id: number | null; name: string; new: boolean };
  server_display_name: string | null;
  environment: string | null;
  target: { type: string; path: string | null; kind: string | null; name: string | null };
  format: { type: string; event_start: string | null; log_timezone: string | null; max_event_bytes: number };
}

export interface ConfigFileView {
  file_name: string;
  key_file_name: string;
  config_version: number;
  content: string;
}

export interface RegisteredConnection {
  connection: {
    id: string;
    service: { id: number; name: string };
    server: { id: number; display_name: string } | null;
    environment: string | null;
    management_state: string;
    config_version: number;
    created_at: string;
  };
  /** 키 원문은 처음 응답에만 있다. 같은 Idempotency-Key로 다시 받은 응답은 null이고 secret_unavailable이 참이다. */
  key: { key_id: string; key: string | null; issued_as: 'register' };
  secret_unavailable: boolean;
  config: ConfigFileView;
}

/**
 * 수집 연결(계약 4.3·5.1절). 사전 검사와 등록 확정은 입력 규칙 → 서비스 상태 → 같은 대상 순서로 본다.
 * 등록 확정은 서비스(새로 만든 경우 포함)·서버 이름·연결·설정 버전 1·키를 한 트랜잭션으로 만들고, 하나라도 실패하면
 * 아무것도 만들지 않는다(5.1절 등록 확정).
 */
@Injectable()
export class ConnectionsService implements OnModuleInit {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 수집 대상·형식 검사(WebAssembly)를 시작할 때 불러 둔다. 없으면 앱이 뜨지 않는다. */
  async onModuleInit(): Promise<void> {
    await loadRules();
  }

  private checkInput(body: ConnectionBody): ConnectionInput {
    const checked = checkConnectionInput(body, this.config);
    if (!checked.ok) throw errors.validation(checked.problems);
    return checked.input;
  }

  /** 등록 전 사전 검사. 아무것도 만들지 않는다. 통과하면 저장할 형태로 맞춘 값을 돌려준다. */
  async validate(body: ConnectionBody): Promise<ValidatedConnection> {
    const input = this.checkInput(body);
    // 서비스와 같은 대상을 한 트랜잭션에서 읽어 서로 맞는 상태로 본다. 아무것도 쓰지 않는다.
    const service = await this.db.tx(async (c) => {
      const s = await this.checkService(c, input.service);
      await this.checkDuplicate(c, input);
      return s;
    });
    return {
      valid: true,
      service: { id: service.id, name: service.name, new: service.id === null },
      server_display_name: input.serverDisplayName,
      environment: input.environment,
      target:
        input.target.type === 'journald'
          ? { type: input.target.type, path: null, kind: input.target.kind, name: input.target.name }
          : { type: input.target.type, path: input.target.path, kind: null, name: null },
      format: {
        type: input.format.type,
        event_start: input.format.eventStart,
        log_timezone: input.format.logTimezone,
        max_event_bytes: input.format.maxEventBytes,
      },
    };
  }

  /**
   * 등록 확정(5.1절). 재확인은 검사 지점이 먼저 보았다. 같은 Idempotency-Key의 두 번째 요청은 다시 만들지 않고 처음
   * 결과를 키 원문 없이 돌려준다. 감사를 쓸 수 없으면 아무것도 만들지 않는다(409 held_audit_unavailable).
   */
  async register(body: ConnectionBody, idemKey: string, accountId: number): Promise<{ status: number; body: RegisteredConnection }> {
    const input = this.checkInput(body);
    const ingestUrl = this.config.ingestUrl;
    if (!ingestUrl) throw new Error('ingestUrl is not configured');
    const requestHash = sha256('connection.register', JSON.stringify(input));
    try {
      return await this.db.tx(async (c) => {
        const claim = await claimIdempotency(c, accountId, idemKey, 'connection.register', requestHash);
        if (claim.kind === 'replay') {
          const id = Number(claim.result.connection_id);
          return { status: claim.status, body: await this.registrationView(c, id, String(claim.result.key_id), null) };
        }
        const service = await this.lockOrCreateService(c, input.service);
        const serverId = input.serverDisplayName ? await this.findOrCreateServer(c, input.serverDisplayName) : null;
        await this.checkDuplicate(c, input);
        const t = input.target;
        const journald = t.type === 'journald';
        const id = (
          await c.query<{ id: number }>(
            `INSERT INTO connections (service_id, server_id, environment, target_type, target_path, journald_kind, journald_name,
                                      format_type, event_start_pattern, log_timezone, max_event_bytes, config_issued_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
             RETURNING id`,
            [
              service.id,
              serverId,
              input.environment,
              t.type,
              journald ? null : t.path,
              journald ? t.kind : null,
              journald ? t.name : null,
              input.format.type,
              input.format.eventStart,
              input.format.logTimezone,
              input.format.maxEventBytes,
            ],
          )
        ).rows[0].id;
        const publicId = encodeConnectionId(id);
        await c.query('INSERT INTO connection_configs (connection_id, version, content) VALUES ($1, 1, $2)', [
          id,
          configContent(publicId, 1, ingestUrl, input),
        ]);
        const key = newIngestKey();
        await c.query(
          `INSERT INTO ingest_keys (key_id, connection_id, secret_hash, slot, issued_as) VALUES ($1, $2, $3, 1, 'register')`,
          [key.keyId, id, key.secretHash],
        );
        await this.audit.writeOrHold(c, { action: 'connection.register', result: 'success', accountId, targetType: 'connection', targetRef: publicId });
        await this.audit.writeOrHold(c, { action: 'key.issue', result: 'success', accountId, targetType: 'key', targetRef: key.keyId });
        await completeIdempotency(c, accountId, idemKey, 201, { connection_id: id, key_id: key.keyId });
        return { status: 201, body: await this.registrationView(c, id, key.keyId, key.key) };
      });
    } catch (err) {
      // 확인과 저장 사이에 다른 요청이 같은 새 서비스 이름이나 같은 서버·같은 대상을 먼저 만든 경우(유일 색인).
      const e = err as pg.DatabaseError;
      if (e?.code === '23505' && e.constraint === 'services_name_uq') throw errors.nameTaken('service.name');
      if (e?.code === '23505' && e.constraint === 'connections_same_target_uq') {
        await this.db.tx((c) => this.checkDuplicate(c, input));
      }
      throw err;
    }
  }

  /** 설정 내려받기(WQ-64). 키는 담지 않는다. 보관된 연결도 내려받을 수 있다(5.1절 상태별 동작). */
  async configFile(publicId: string): Promise<ConfigFileView> {
    const id = decodeConnectionId(publicId);
    if (id === null) throw errors.notFound();
    const view = await this.db.tx((c) => this.latestConfig(c, id));
    if (!view) throw errors.notFound();
    return view;
  }

  private async latestConfig(c: Queryable, id: number): Promise<ConfigFileView | null> {
    const row = (
      await c.query<{ version: number; content: ConfigContent }>(
        'SELECT version, content FROM connection_configs WHERE connection_id = $1 ORDER BY version DESC LIMIT 1',
        [id],
      )
    ).rows[0];
    if (!row) return null;
    const publicId = encodeConnectionId(id);
    return { file_name: `${publicId}.toml`, key_file_name: `${publicId}.key`, config_version: row.version, content: renderToml(row.content) };
  }

  private async registrationView(c: Queryable, id: number, keyId: string, key: string | null): Promise<RegisteredConnection> {
    const row = (
      await c.query<{
        service_id: number;
        service_name: string;
        server_id: number | null;
        display_name: string | null;
        environment: string | null;
        management_state: string;
        config_version: number;
        created_at: string;
      }>(
        `SELECT c.service_id, s.name AS service_name, c.server_id, v.display_name, c.environment, c.management_state,
                c.config_version, ${utc('c.created_at')} AS created_at
           FROM connections c JOIN services s ON s.id = c.service_id LEFT JOIN servers v ON v.id = c.server_id
          WHERE c.id = $1`,
        [id],
      )
    ).rows[0];
    const config = await this.latestConfig(c, id);
    return {
      connection: {
        id: encodeConnectionId(id),
        service: { id: row.service_id, name: row.service_name },
        server: row.server_id === null ? null : { id: row.server_id, display_name: row.display_name! },
        environment: row.environment,
        management_state: row.management_state,
        config_version: row.config_version,
        created_at: row.created_at,
      },
      key: { key_id: keyId, key, issued_as: 'register' },
      secret_unavailable: key === null,
      config: config!,
    };
  }

  /**
   * 고른 서비스를 본다(5.1절 등록 충돌, WQ-54·57). 기존 서비스는 있고 보관되지 않았으며 읽을 때의 version과 같아야 한다.
   * 새 이름은 보관된 서비스까지 대소문자를 가리지 않고 겹치지 않아야 한다.
   */
  private async checkService(c: Queryable, s: ServiceChoice, lock = ''): Promise<{ id: number | null; name: string }> {
    if (s.kind === 'existing') {
      const row = (await c.query<ServiceView>(`SELECT ${SERVICE_COLUMNS} FROM services WHERE id = $1 ${lock}`, [s.id])).rows[0];
      if (!row) throw errors.validation([{ path: 'service.id', reason: 'not_found' }]);
      if (row.state === 'archived') throw errors.targetArchived();
      if (row.version !== s.version) throw errors.versionConflict({ ...row });
      return { id: row.id, name: row.name };
    }
    if ((await c.query('SELECT 1 FROM services WHERE lower(name) = lower($1)', [s.name])).rowCount) {
      throw errors.nameTaken('service.name');
    }
    return { id: null, name: s.name };
  }

  /** 등록 확정용: 기존 서비스는 끝날 때까지 이름 변경·보관과 겹치지 않게 잠그고, 새 이름이면 만든다. */
  private async lockOrCreateService(c: Queryable, s: ServiceChoice): Promise<{ id: number; name: string }> {
    const checked = await this.checkService(c, s, 'FOR SHARE');
    if (checked.id !== null) return { id: checked.id, name: checked.name };
    const created = (await c.query<{ id: number }>('INSERT INTO services (name) VALUES ($1) RETURNING id', [checked.name])).rows[0];
    return { id: created.id, name: checked.name };
  }

  /** 서버 표시명은 이름 목록의 한 항목이다. 같은 이름이면 같은 서버로 묶는다(SD-11). */
  private async findOrCreateServer(c: Queryable, displayName: string): Promise<number> {
    await c.query('INSERT INTO servers (display_name) VALUES ($1) ON CONFLICT ((lower(display_name))) DO NOTHING', [displayName]);
    return (await c.query<{ id: number }>('SELECT id FROM servers WHERE lower(display_name) = lower($1)', [displayName])).rows[0].id;
  }

  /**
   * 같은 서버·같은 대상의 보관되지 않은 연결이 있으면 막는다(Q07-06). 서버 표시명이 없으면 여기서는 알 수 없고
   * 에이전트가 적용할 때 같은 인스턴스·같은 대상으로 확인한다(5.1절, 2.7절).
   */
  private async checkDuplicate(c: Queryable, input: ConnectionInput): Promise<void> {
    if (!input.serverDisplayName) return;
    const r = await c.query<{ id: number }>(
      `SELECT c.id FROM connections c JOIN servers s ON s.id = c.server_id
        WHERE lower(s.display_name) = lower($1) AND c.target_identity = $2 AND c.management_state <> 'archived'
        LIMIT 1`,
      [input.serverDisplayName, targetIdentity(input.target)],
    );
    if (r.rows[0]) throw errors.duplicateConnection(encodeConnectionId(r.rows[0].id));
  }
}
