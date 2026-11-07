// 로그 행 표시(계약 4.2절 rows, SD-34, CM-06). 검색 목록·판정 불가 보기·주변 로그가 같은 꼴을 쓴다. 서비스·서버 이름은
// 지금 이름이다.
import { Injectable } from '@nestjs/common';

import { fromChTime } from '../clickhouse/clickhouse.js';
import { encodeConnectionId } from '../connections/public-id.js';
import { Database } from '../db/database.js';

export interface ListRow {
  connection_id: number;
  generation: number;
  seq: string;
  kind?: 'event' | 'rejected' | 'boundary';
  received_at: string;
  ref_time: string;
  occurred_at: string | null;
  ref_time_source: 'body' | 'envelope' | 'observed';
  time_flags: number;
  service_id: number;
  server_id: number | null;
  environment: string;
  level: string;
  level_raw: string;
  body: string;
  body_truncated: number | boolean;
  body_is_base64: boolean;
  parse_status: 'none' | 'ok' | 'partial' | 'failed';
  fields_truncated: boolean;
  reject_reason?: string;
  reject_limit_bytes?: string | null;
  boundary_kind?: string;
  boundary_detail?: string;
}

/** 목록 행에 읽는 열. 본문은 앞의 정한 글자 수만 읽는다(`chars`는 바인딩 자리). */
export function listColumns(chars: string): string {
  return `connection_id, generation, seq, received_at, ref_time, occurred_at, ref_time_source, time_flags,
       service_id, server_id, environment, toString(level) AS level, level_raw,
       substringUTF8(body, 1, ${chars}) AS body, lengthUTF8(body) > ${chars} AS body_truncated, body_is_base64,
       toString(parse_status) AS parse_status, fields_truncated`;
}

/** 이벤트 참조(4.2절). 연결·세대·순번과 수신일(UTC)을 담은 불투명한 값이다. 수신일은 일 파티션을 바로 찾는 데 쓴다. */
export function eventRef(c: number, g: number, s: string, receivedAt: string): string {
  return Buffer.from(`e1.${c}.${g}.${s}.${receivedAt.slice(0, 10).replace(/-/g, '')}`).toString('base64url');
}

export function parseEventRef(ref: string): { c: number; g: number; s: string; day: string } | null {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(ref)) return null;
  const m = /^e1\.(\d{1,10})\.(\d{1,5})\.(\d{1,20})\.(\d{8})$/.exec(Buffer.from(ref, 'base64url').toString());
  if (!m) return null;
  const [c, g] = [Number(m[1]), Number(m[2])];
  if (c > 4294967295 || g > 65535 || BigInt(m[3]) > 2n ** 64n - 1n) return null;
  return { c, g, s: m[3], day: `${m[4].slice(0, 4)}-${m[4].slice(4, 6)}-${m[4].slice(6)}` };
}

/** 시각·품질 표시(CM-06). 시각 대체·시각 의심·시간대 추정·해석 실패·필드 일부 생략. */
export function flagsOf(r: Pick<ListRow, 'ref_time_source' | 'time_flags' | 'parse_status' | 'fields_truncated'>): string[] {
  const flags: string[] = [];
  if (r.ref_time_source === 'observed') flags.push('time_substituted');
  if (r.time_flags & 1) flags.push('time_suspect');
  if (r.time_flags & 2) flags.push('timezone_guessed');
  if (r.parse_status === 'failed') flags.push('parse_failed');
  if (r.fields_truncated) flags.push('fields_truncated');
  return flags;
}

export interface Names {
  services: Map<number, { name: string; archived: boolean }>;
  servers: Map<number, string>;
}

@Injectable()
export class RowPresenter {
  constructor(private readonly db: Database) {}

  async names(serviceIds: number[], serverIds: number[]): Promise<Names> {
    const services = new Map<number, { name: string; archived: boolean }>();
    const servers = new Map<number, string>();
    if (serviceIds.length) {
      const r = await this.db.query<{ id: number; name: string; archived: boolean }>(
        `SELECT id, name, state = 'archived' AS archived FROM services WHERE id = ANY($1)`,
        [serviceIds],
      );
      for (const x of r.rows) services.set(x.id, { name: x.name, archived: x.archived });
    }
    if (serverIds.length) {
      const r = await this.db.query<{ id: number; display_name: string }>('SELECT id, display_name FROM servers WHERE id = ANY($1)', [serverIds]);
      for (const x of r.rows) servers.set(x.id, x.display_name);
    }
    return { services, servers };
  }

  /** 목록 행을 응답 꼴로 바꾼다. 거부·경계 기록(주변 로그)은 종류와 사유를 함께 준다. */
  async present(rows: ListRow[]) {
    const names = await this.names(
      [...new Set(rows.map((r) => r.service_id))],
      [...new Set(rows.map((r) => r.server_id).filter((x): x is number => x !== null))],
    );
    return rows.map((r) => ({
      event_ref: eventRef(r.connection_id, r.generation, r.seq, r.received_at),
      ...(r.kind && r.kind !== 'event'
        ? {
            kind: r.kind,
            ...(r.kind === 'rejected'
              ? { reject_reason: r.reject_reason, reject_limit_bytes: r.reject_limit_bytes ?? null }
              : { boundary_kind: r.boundary_kind, boundary_detail: r.boundary_detail || null }),
          }
        : r.kind
          ? { kind: r.kind }
          : {}),
      ref_time: fromChTime(r.ref_time),
      received_at: fromChTime(r.received_at),
      occurred_at: r.occurred_at === null ? null : fromChTime(r.occurred_at),
      time_source: r.ref_time_source,
      service: { id: r.service_id, name: names.services.get(r.service_id)?.name ?? null },
      server: r.server_id === null ? null : { id: r.server_id, name: names.servers.get(r.server_id) ?? null },
      environment: r.environment === '' ? null : r.environment,
      connection_id: encodeConnectionId(r.connection_id),
      level: r.level,
      level_raw: r.level_raw,
      body: r.body,
      body_truncated: Boolean(r.body_truncated),
      body_encoding: r.body_is_base64 ? 'base64' : 'utf8',
      flags: flagsOf(r),
    }));
  }
}
