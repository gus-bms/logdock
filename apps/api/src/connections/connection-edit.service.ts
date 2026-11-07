import { posix } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import { errors } from '../common/api-error.js';
import { checkName } from '../common/names.js';
import { type AppConfig } from '../config.js';
import { Database, type Queryable } from '../db/database.js';
import { APP_CONFIG } from '../tokens.js';
import { type ConfigContent, configContent, renderToml } from './config-file.js';
import { type ConnectionInput, type FieldProblem, targetIdentity } from './connection-input.js';
import { decodeConnectionId, encodeConnectionId } from './public-id.js';
import { checkTargetAndFormat, type RuleTarget } from './rules.js';
import { activeDuplicate, findOrCreateServer } from './servers.js';

const OptionalText = z.string().nullish();

/** 설정 수정(WQ-62). 형식을 주면 형식 전체를 바꾸고, 이벤트 크기 상한을 빼면 지금 값을 둔다. */
export const SettingsBody = z.object({
  version: z.number().int().positive(),
  target: z.object({ path: z.string() }).optional(),
  format: z
    .object({
      type: z.string(),
      event_start: OptionalText,
      log_timezone: OptionalText,
      max_event_bytes: z.number().int().optional(),
    })
    .optional(),
  extraction_rule: z.unknown().optional(),
});
export type SettingsBody = z.infer<typeof SettingsBody>;

/** 환경 태그·서버 바꾸기(WQ-63). 준 칸만 바꾸고 null은 비운다. */
export const PlacementBody = z.object({
  version: z.number().int().positive(),
  server_display_name: OptionalText,
  environment: OptionalText,
});
export type PlacementBody = z.infer<typeof PlacementBody>;

interface ConnRow {
  id: number;
  server_id: number | null;
  environment: string | null;
  target_type: string;
  target_path: string | null;
  journald_kind: string | null;
  journald_name: string | null;
  format_type: string;
  event_start_pattern: string | null;
  log_timezone: string | null;
  max_event_bytes: number;
  config_version: number;
  management_state: string;
  version: number;
}

function validTimeZone(tz: string): boolean {
  if (tz === 'Local') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * 수집 연결 수정(계약 5.1절). 설정 수정은 새 설정 버전을 만들고 에이전트에 다시 적용해야 한다(Q16-05). 다른 폴더·다른 파일,
 * 파일과 journald 사이 변경, 다른 서버·서비스는 새 연결로 등록한다(Q07-04·05). 환경 태그·서버는 중앙 표시 정보라 설정 버전을
 * 만들지 않는다(WQ-63). 둘 다 감사를 쓸 수 없으면 보류한다.
 */
@Injectable()
export class ConnectionEditService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async updateSettings(publicId: string, body: SettingsBody, accountId: number) {
    const id = this.id(publicId);
    const ingestUrl = this.config.ingestUrl;
    if (!ingestUrl) throw new Error('ingestUrl is not configured');
    let claim: { serverId: number; identity: string } | null = null;
    try {
      return await this.db.tx(async (c) => {
        const row = await this.lock(c, id, body.version);
        const next = this.mergeSettings(row, body);
        const changed = changedSettings(row, next);
        if (changed.length === 0) return this.settingsView(c, row, [], null);
        const t = next.target;
        if (t.type !== 'journald' && t.path !== row.target_path && row.server_id !== null) {
          claim = { serverId: row.server_id, identity: targetIdentity(t) };
          await this.refuseDuplicate(c, id, claim.serverId, claim.identity);
        }
        const version = row.config_version + 1;
        await c.query(
          `UPDATE connections SET target_path = $2, format_type = $3, event_start_pattern = $4, log_timezone = $5, max_event_bytes = $6,
                  config_version = $7, version = version + 1, updated_at = now()
            WHERE id = $1`,
          [id, t.type === 'journald' ? null : t.path, next.format.type, next.format.eventStart, next.format.logTimezone, next.format.maxEventBytes, version],
        );
        const content = configContent(publicId, version, ingestUrl, next);
        await c.query('INSERT INTO connection_configs (connection_id, version, content) VALUES ($1, $2, $3)', [id, version, content]);
        await this.audit.writeOrHold(c, {
          action: 'connection.update',
          result: 'success',
          accountId,
          targetType: 'connection',
          targetRef: publicId,
          changedFields: changed,
        });
        const updated = (await c.query<ConnRow>(`SELECT ${CONN_COLUMNS} FROM connections WHERE id = $1`, [id])).rows[0];
        return this.settingsView(c, updated, changed, content);
      });
    } catch (err) {
      throw await this.mapUnique(err, id, claim);
    }
  }

  /** 환경 태그·서버 바꾸기. 새 서버 표시명은 같은 이름이면 같은 서버로 묶고 없으면 만든다(SD-11). */
  async updatePlacement(publicId: string, body: PlacementBody, accountId: number) {
    const id = this.id(publicId);
    const problems: FieldProblem[] = [];
    const name = (raw: string | null | undefined, path: string): string | null | undefined => {
      if (raw === undefined) return undefined;
      if (raw === null || raw.trim() === '') return null;
      const c = checkName(raw, this.config.nameMaxLength);
      if (!c.ok) {
        problems.push({ path, reason: c.reason });
        return undefined;
      }
      return c.value;
    };
    const server = name(body.server_display_name, 'server_display_name');
    const environment = name(body.environment, 'environment');
    if (problems.length) throw errors.validation(problems);
    let claim: { serverId: number; identity: string } | null = null;
    try {
      return await this.db.tx(async (c) => {
        const row = await this.lock(c, id, body.version);
        let serverId = row.server_id;
        if (server !== undefined) {
          serverId = server === null ? null : await findOrCreateServer(c, server);
        }
        const env = environment === undefined ? row.environment : environment;
        const changed: string[] = [];
        if (serverId !== row.server_id) changed.push('server');
        if (env !== row.environment) changed.push('environment');
        if (changed.length > 0) {
          if (serverId !== null && serverId !== row.server_id) {
            claim = { serverId, identity: targetIdentity(ruleTarget(row)) };
            await this.refuseDuplicate(c, id, claim.serverId, claim.identity);
          }
          await c.query('UPDATE connections SET server_id = $2, environment = $3, version = version + 1, updated_at = now() WHERE id = $1', [
            id,
            serverId,
            env,
          ]);
          await this.audit.writeOrHold(c, {
            action: 'connection.move',
            result: 'success',
            accountId,
            targetType: 'connection',
            targetRef: publicId,
            changedFields: changed,
          });
        }
        const v = (
          await c.query<{ server_id: number | null; display_name: string | null; environment: string | null; version: number }>(
            `SELECT c.server_id, s.display_name, c.environment, c.version FROM connections c LEFT JOIN servers s ON s.id = c.server_id WHERE c.id = $1`,
            [id],
          )
        ).rows[0];
        return {
          connection: {
            id: publicId,
            server: v.server_id === null ? null : { id: v.server_id, display_name: v.display_name },
            environment: v.environment,
            version: v.version,
          },
          changed_fields: changed,
        };
      });
    } catch (err) {
      throw await this.mapUnique(err, id, claim);
    }
  }

  private id(publicId: string): number {
    const id = decodeConnectionId(publicId);
    if (id === null) throw errors.notFound();
    return id;
  }

  /** 연결 행을 잠그고 상태와 version을 본다. 보관된 연결은 고칠 수 없다(WQ-68). */
  private async lock(c: Queryable, id: number, version: number): Promise<ConnRow> {
    const row = (await c.query<ConnRow>(`SELECT ${CONN_COLUMNS} FROM connections WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!row) throw errors.notFound();
    if (row.management_state === 'archived') throw errors.targetArchived();
    if (row.version !== version) {
      throw errors.versionConflict({ id: encodeConnectionId(id), version: row.version, config_version: row.config_version });
    }
    return row;
  }

  /** 지금 값에 고칠 값을 얹고 입력 규칙(에이전트와 같은 Go 코드)으로 본다. 문제가 있으면 모든 칸을 한 번에 돌려준다. */
  private mergeSettings(row: ConnRow, body: SettingsBody): Pick<ConnectionInput, 'target' | 'format'> {
    const problems: FieldProblem[] = [];
    const current = ruleTarget(row);
    let path = current.path;
    if (body.target !== undefined && body.target.path !== current.path) {
      // 같은 폴더 안의 파일명 규칙만 고칠 수 있다. 그 밖의 대상 변경은 새 연결로 등록한다(Q07-04·05).
      const sameFolder = current.type === 'file_pattern' && posix.dirname(body.target.path) === posix.dirname(current.path);
      if (sameFolder) path = body.target.path;
      else problems.push({ path: 'target.path', reason: 'new_connection_required' });
    }
    const f = body.format;
    const format = {
      type: f ? f.type : row.format_type,
      event_start: f ? (f.event_start ?? null) : row.event_start_pattern,
    };
    const rules = checkTargetAndFormat({ ...current, path }, format);
    for (const p of rules.problems) problems.push(p.expr ? { path: p.field, reason: p.code, expr: p.expr } : { path: p.field, reason: p.code });
    let logTimezone = row.log_timezone;
    let maxEventBytes = row.max_event_bytes;
    if (f) {
      const tz = f.log_timezone?.trim() ?? '';
      if (tz === '') logTimezone = null;
      else if (validTimeZone(tz)) logTimezone = tz;
      else problems.push({ path: 'format.log_timezone', reason: 'timezone_invalid' });
      if (f.max_event_bytes !== undefined) {
        if (f.max_event_bytes < 1) problems.push({ path: 'format.max_event_bytes', reason: 'too_small' });
        else if (f.max_event_bytes > this.config.maxEventBytes.max) problems.push({ path: 'format.max_event_bytes', reason: 'too_big' });
        else maxEventBytes = f.max_event_bytes;
      }
    }
    if (body.extraction_rule !== undefined && body.extraction_rule !== null) problems.push({ path: 'extraction_rule', reason: 'not_supported' });
    if (problems.length) throw errors.validation(problems);
    const eventStart = format.event_start ?? '';
    return {
      target: rules.target,
      format: { type: format.type, eventStart: eventStart === '' ? null : eventStart, logTimezone, maxEventBytes },
    };
  }

  /** 같은 서버·같은 대상의 보관되지 않은 다른 연결이 있으면 막는다(Q07-06). */
  private async refuseDuplicate(c: Queryable, id: number, serverId: number, identity: string): Promise<void> {
    const other = await activeDuplicate(c, serverId, identity, id);
    if (other !== null) throw errors.duplicateConnection(encodeConnectionId(other));
  }

  /** 확인과 저장 사이에 다른 요청이 같은 대상을 먼저 차지한 경우(유일 색인). 차지한 연결을 다시 찾아 알린다. */
  private async mapUnique(err: unknown, id: number, claim: { serverId: number; identity: string } | null): Promise<unknown> {
    const e = err as pg.DatabaseError;
    if (e?.code !== '23505' || e.constraint !== 'connections_same_target_uq' || !claim) return err;
    const other = await this.db.tx((c) => activeDuplicate(c, claim.serverId, claim.identity, id));
    return other === null ? err : errors.duplicateConnection(encodeConnectionId(other));
  }

  private async settingsView(c: Queryable, row: ConnRow, changed: string[], content: ConfigContent | null) {
    const publicId = encodeConnectionId(row.id);
    const latest =
      content ??
      (await c.query<{ content: ConfigContent }>('SELECT content FROM connection_configs WHERE connection_id = $1 ORDER BY version DESC LIMIT 1', [row.id]))
        .rows[0].content;
    return {
      connection: { id: publicId, config_version: row.config_version, version: row.version, management_state: row.management_state },
      changed_fields: changed,
      // 새 설정 버전은 에이전트에 다시 적용해야 한다. 키는 바뀌지 않아 담지 않는다.
      config: { file_name: `${publicId}.toml`, key_file_name: `${publicId}.key`, config_version: latest.config_version, content: renderToml(latest) },
    };
  }
}

const CONN_COLUMNS = `id, server_id, environment, target_type, target_path, journald_kind, journald_name, format_type, event_start_pattern,
  log_timezone, max_event_bytes, config_version, management_state, version`;

function ruleTarget(row: ConnRow): RuleTarget {
  return { type: row.target_type, path: row.target_path ?? '', kind: row.journald_kind ?? '', name: row.journald_name ?? '' };
}

/** 바뀐 설정 항목의 이름(감사 changed_fields). 값은 남기지 않는다. */
function changedSettings(row: ConnRow, next: Pick<ConnectionInput, 'target' | 'format'>): string[] {
  const out: string[] = [];
  if (next.target.type !== 'journald' && next.target.path !== row.target_path) out.push('target.path');
  if (next.format.type !== row.format_type) out.push('format.type');
  if (next.format.eventStart !== row.event_start_pattern) out.push('format.event_start');
  if (next.format.logTimezone !== row.log_timezone) out.push('format.log_timezone');
  if (next.format.maxEventBytes !== row.max_event_bytes) out.push('format.max_event_bytes');
  return out;
}

