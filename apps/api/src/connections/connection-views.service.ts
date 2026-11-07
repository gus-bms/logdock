import { Inject, Injectable } from '@nestjs/common';

import { errors } from '../common/api-error.js';
import { type AppConfig } from '../config.js';
import { Database, utc } from '../db/database.js';
import { APP_CONFIG } from '../tokens.js';
import { decodeConnectionId, encodeConnectionId } from './public-id.js';

/**
 * CM-05 관측 상태 코드. 수신 서버가 상태 보고(2.7절)로 계산해 connection_status.observed_states에 넣고, API는 보관·첫 보고 전·
 * 보고 끊김만 직접 판정한다.
 */
export const OBSERVATION_STATES = [
  'awaiting_connection', // 연결 대기: 첫 보고 전
  'observed_no_logs', // 관측됨·무로그
  'collecting', // 수집/전송 진행
  'read_paused', // 읽기 일시정지(D01)
  'needs_check', // 설정/복구 확인 필요
  'disk_unavailable', // 디스크 사용 불가(D05)
  'events_rejected', // 이벤트 거부 관측
  'send_error', // 전송 오류/보류
  'recovering', // 복구 중
  'stale', // 관측 오래됨/미확인
  'clock_check', // 시각 확인 필요
  'stopped', // 중단/보관
] as const;
export type ObservationState = (typeof OBSERVATION_STATES)[number];

export interface ListQuery {
  archived: boolean;
  observation?: ObservationState;
  needsAction?: boolean;
  serviceId?: number;
  limit: number;
  cursor?: string;
}

/**
 * 연결마다 관측 상태와 조치 필요를 한 번 계산하는 SQL(4.4절, 메뉴와 목록이 같이 쓴다). 보관된 연결은 `중단/보관`이고 세지 않는다.
 * 키 교체 중(유효 키 2개)은 정상 진행이라 세지 않는다. 인증 오류는 키가 무효·폐기된 전송 보류다.
 */
export const CONNECTION_ROWS = `
  WITH rows AS (
    SELECT c.id, c.service_id, s.name AS service_name, s.state AS service_state, c.server_id, v.display_name,
           c.environment, c.target_type, c.target_path, c.journald_kind, c.journald_name, c.management_state,
           c.config_version, ${utc('c.created_at')} AS created_at, c.updated_at, ${utc('c.archived_at')} AS archived_at,
           c.archived_with_service, ${utc('st.last_report_at')} AS last_report_at, st.report,
           (SELECT count(*)::int FROM ingest_keys k WHERE k.connection_id = c.id AND k.state = 'valid') AS valid_keys,
           CASE
             WHEN c.management_state = 'archived' THEN ARRAY['stopped']
             WHEN st.connection_id IS NULL THEN ARRAY['awaiting_connection']
             WHEN st.last_report_at < now() - make_interval(secs => $1) THEN ARRAY['stale']
             ELSE st.observed_states
           END AS observation
      FROM connections c
      JOIN services s ON s.id = c.service_id
      LEFT JOIN servers v ON v.id = c.server_id
      LEFT JOIN connection_status st ON st.connection_id = c.id
  )
  SELECT *, (management_state <> 'archived' AND (
           management_state = 'blocked'
        OR observation && ARRAY['needs_check', 'disk_unavailable', 'clock_check', 'stale', 'events_rejected']
        OR ('send_error' = ANY(observation) AND report #>> '{send,reason}' IN ('key_invalid', 'key_revoked'))
        OR (management_state = 'pending' AND updated_at < now() - make_interval(secs => $2))
      )) AS needs_action
    FROM rows`;

/** CONNECTION_ROWS의 $1·$2(보고 끊김 판정·연결 대기 판정 기준 초)다. */
export function observationParams(config: AppConfig): unknown[] {
  return [config.observation.staleSeconds, config.observation.pendingSeconds];
}

interface Row {
  id: number;
  service_id: number;
  service_name: string;
  service_state: string;
  server_id: number | null;
  display_name: string | null;
  environment: string | null;
  target_type: string;
  target_path: string | null;
  journald_kind: string | null;
  journald_name: string | null;
  management_state: string;
  config_version: number;
  created_at: string;
  archived_at: string | null;
  archived_with_service: boolean;
  last_report_at: string | null;
  report: Record<string, any> | null;
  valid_keys: number;
  observation: string[];
  needs_action: boolean;
}

function cursorOf(r: Row): string {
  return Buffer.from(JSON.stringify([r.service_name.toLowerCase(), r.service_id, r.id])).toString('base64url');
}

function parseCursor(s: string): [string, number, number] {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 3 && typeof v[0] === 'string' && Number.isInteger(v[1]) && Number.isInteger(v[2])) {
      return v as [string, number, number];
    }
  } catch {
    // 아래에서 입력 오류로 돌려준다
  }
  throw errors.validation([{ path: 'cursor', reason: 'invalid' }]);
}

function listItem(r: Row) {
  return {
    id: encodeConnectionId(r.id),
    service: { id: r.service_id, name: r.service_name, state: r.service_state },
    server: r.server_id === null ? null : { id: r.server_id, display_name: r.display_name },
    environment: r.environment,
    target: { type: r.target_type, path: r.target_path, kind: r.journald_kind, name: r.journald_name },
    management_state: r.management_state,
    observation: { states: r.observation, last_report_at: r.last_report_at },
    // 대기량은 보고에서 온 값이라 받은 시각(last_report_at)을 기준으로 보인다. 보고가 없으면 모른다(null).
    queue: r.report?.queue ? { records: r.report.queue.records ?? null, bytes: r.report.queue.bytes ?? null, oldest_observed_at: r.report.queue.oldest_observed_at ?? null } : null,
    valid_keys: r.valid_keys,
    needs_action: r.needs_action,
    created_at: r.created_at,
  };
}

/** 수집 연결 목록·상세·조치 필요 수(계약 4.3·4.4절, UI-10·UI-12). 읽기만 한다. */
@Injectable()
export class ConnectionViewsService {
  constructor(
    private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private params(): unknown[] {
    return observationParams(this.config);
  }

  /** 서비스 이름순(대소문자 무시), 같으면 서비스 ID·연결 ID 순이다. 불투명한 cursor로 나눠 받는다(4.1절 목록 나누기). */
  async list(q: ListQuery) {
    const where: string[] = [q.archived ? `management_state = 'archived'` : `management_state <> 'archived'`];
    const values = this.params();
    const add = (sql: string, v: unknown) => {
      values.push(v);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (q.observation) add('? = ANY(observation)', q.observation);
    if (q.needsAction) where.push('needs_action');
    if (q.serviceId !== undefined) add('service_id = ?', q.serviceId);
    if (q.cursor) {
      const [name, sid, cid] = parseCursor(q.cursor);
      values.push(name, sid, cid);
      where.push(`(lower(service_name), service_id, id) > ($${values.length - 2}, $${values.length - 1}, $${values.length})`);
    }
    values.push(q.limit + 1);
    const r = await this.db.query<Row>(
      `SELECT * FROM (${CONNECTION_ROWS}) x WHERE ${where.join(' AND ')}
        ORDER BY lower(service_name), service_id, id LIMIT $${values.length}`,
      values,
    );
    const rows = r.rows.slice(0, q.limit);
    return { items: rows.map(listItem), next_cursor: r.rows.length > q.limit ? cursorOf(rows[rows.length - 1]) : null };
  }

  /** 메뉴(CM-01)와 목록(UI-10)이 같이 쓰는 조치 필요 수. 보관된 연결은 세지 않는다. */
  async summary() {
    const r = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${CONNECTION_ROWS}) x WHERE needs_action`, this.params());
    return { needs_action: r.rows[0].n };
  }

  /** 상세(4.3절 연결 상세 항목). 로그 저장소(ClickHouse)에서 세는 값은 아직 없어 null이다. */
  async detail(publicId: string) {
    const id = decodeConnectionId(publicId);
    if (id === null) throw errors.notFound();
    const values = [...this.params(), id];
    const row = (await this.db.query<Row>(`SELECT * FROM (${CONNECTION_ROWS}) x WHERE id = $3`, values)).rows[0];
    if (!row) throw errors.notFound();
    const extra = (
      await this.db.query<{
        format_type: string;
        event_start_pattern: string | null;
        log_timezone: string | null;
        max_event_bytes: number;
        version: number;
        config_issued_at: string | null;
        agent_applied_at: string | null;
        first_read_at: string | null;
        first_received_at: string | null;
        first_searchable_at: string | null;
        agent_instance_id: string | null;
      }>(
        `SELECT format_type, event_start_pattern, log_timezone, max_event_bytes, version, agent_instance_id,
                ${utc('config_issued_at')} AS config_issued_at, ${utc('agent_applied_at')} AS agent_applied_at,
                ${utc('first_read_at')} AS first_read_at, ${utc('first_received_at')} AS first_received_at,
                ${utc('first_searchable_at')} AS first_searchable_at
           FROM connections WHERE id = $1`,
        [id],
      )
    ).rows[0];
    const keys = (
      await this.db.query(
        `SELECT key_id, state, slot, issued_as, ${utc('issued_at')} AS issued_at, ${utc('revoke_requested_at')} AS revoke_requested_at,
                ${utc('revoked_at')} AS revoked_at, ${utc('revoke_observed_at')} AS revoke_observed_at,
                ${utc('invalidated_at')} AS invalidated_at
           FROM ingest_keys WHERE connection_id = $1 ORDER BY issued_at DESC, key_id`,
        [id],
      )
    ).rows;
    const ack = (
      await this.db.query<{ generation: number; acked_through: string; at: string }>(
        `SELECT generation, (next_seq - 1)::text AS acked_through, ${utc('updated_at')} AS at
           FROM ingest_progress WHERE connection_id = $1 ORDER BY generation DESC LIMIT 1`,
        [id],
      )
    ).rows[0];
    const history = (
      await this.db.query(
        `SELECT ${utc('reported_at')} AS reported_at, changes, diag_write_error
           FROM status_history WHERE connection_id = $1 ORDER BY reported_at DESC LIMIT 20`,
        [id],
      )
    ).rows;
    const report = row.report;
    return {
      ...listItem(row),
      format: {
        type: extra.format_type,
        event_start: extra.event_start_pattern,
        log_timezone: extra.log_timezone,
        max_event_bytes: extra.max_event_bytes,
      },
      config_version: row.config_version,
      applied_config_version: report?.config?.version ?? null,
      archived_at: row.archived_at,
      archived_with_service: row.archived_with_service,
      agent_instance_id: extra.agent_instance_id,
      // 상태 보고에서 온 값. 받은 시각은 observation.last_report_at이다(미관측 때 `마지막 보고 기준`으로 보인다).
      report: report
        ? {
            agent: report.agent ?? null,
            read: report.read ?? null,
            send: report.send ?? null,
            loss: report.loss ?? [],
            resources: report.resources ?? null,
            diag_write_error: report.diag_write_error ?? null,
          }
        : null,
      central_ack: ack ? { generation: ack.generation, acked_through: Number(ack.acked_through), at: ack.at } : null,
      // 로그 저장소에서 최근 N시간을 세는 값(크기 초과 거부·해석 실패)은 ClickHouse 연동 때 채운다.
      rejected_recent: null,
      parse_failed_recent: null,
      registration: {
        registered_at: row.created_at,
        config_issued_at: extra.config_issued_at,
        agent_applied_at: extra.agent_applied_at,
        first_read_at: extra.first_read_at,
        first_received_at: extra.first_received_at,
        first_searchable_at: extra.first_searchable_at,
      },
      keys,
      diagnostics: history,
      version: extra.version,
    };
  }
}
