// 이벤트 상세와 주변 로그(계약 4.2절, UI-03·UI-04, Q09-01~03, WQ-18·WQ-27). 상세와 주변 로그도 보관·조기 삭제·차단 구간을
// 검색과 같이 적용해, 목록에 남은 행이 지금 조회 가능하다고 보이지 않게 한다.
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { SessionInfo } from '../auth/session.service.js';
import { fromChTime } from '../clickhouse/clickhouse.js';
import { errors } from '../common/api-error.js';
import type { AppConfig } from '../config.js';
import { encodeConnectionId } from '../connections/public-id.js';
import { Database } from '../db/database.js';
import { type Budget, ChRunner, type Track } from '../search/ch-runner.js';
import { type ListRow, RowPresenter, flagsOf, listColumns, parseEventRef } from '../search/rows.js';
import { rfcOf, usOf, usOfCh } from '../search/run-time.js';
import { type Limits, loadBlocks, loadLimits } from '../search/scope.js';
import { type Block, Params } from '../search/search-sql.js';
import { APP_CONFIG } from '../tokens.js';

export const NearbyBody = z
  .object({
    mode: z.enum(['stream', 'service_server']),
    direction: z.enum(['both', 'before', 'after']).optional(),
    limit: z.number().int().positive().optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

/** stack trace로 볼 필드 이름(WQ-18). Q08-07 내장 패턴과 함께 정하는 시제품 목록이다. 앞에 있는 것을 먼저 쓴다. */
const STACK_FIELDS = ['stack', 'stacktrace', 'stack_trace', 'err.stack', 'error.stack', 'error.stack_trace', 'exception.stacktrace', 'exception.stack_trace', 'exc_info'];

interface DetailRow extends ListRow {
  kind: 'event' | 'rejected' | 'boundary';
  stream_type: string;
  stream_id: string;
  stream_label: string;
  stream_offset: string | null;
  journald_cursor: string;
  observed_at: string;
  body_unescaped: string;
  parse_rule_version: number;
  fields_json: string;
  field_types: Record<string, string>;
  field_paths: string[];
}

interface Key {
  c: number;
  g: number;
  s: string;
  day: string;
}

type Side = 'before' | 'after';

/** 주변 로그 커서. 방향·조회 방식·기준 이벤트에 묶고 마지막 행 위치를 담는다. */
interface NearbyCursor {
  a: string;
  m: 'stream' | 'service_server';
  d: Side;
  t: string;
  c: number;
  g: number;
  s: string;
}

@Injectable()
export class EventsService {
  constructor(
    private readonly db: Database,
    private readonly runner: ChRunner,
    private readonly rowsOut: RowPresenter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 상세(UI-03). 출처, 세 시각과 시각 출처, 레벨 원본·정규화, 본문, 타입을 단 필드, 뽑은 stack trace, 표시를 준다. */
  async detail(session: SessionInfo, ref: string) {
    const key = parseEventRef(ref);
    if (!key) throw errors.notFound();
    return this.runner.gate(session.idHash.toString('hex'), async (budget, track) => {
      const limits = await loadLimits(this.db, this.config);
      const r = await this.load(key, limits, budget, track);
      const names = await this.rowsOut.names([r.service_id], r.server_id === null ? [] : [r.server_id]);
      const fields = fieldList(r.fields_json, r.field_types, r.field_paths);
      const svc = names.services.get(r.service_id);
      return {
        event_ref: ref,
        kind: r.kind,
        source: {
          service: { id: r.service_id, name: svc?.name ?? null, archived: svc?.archived ?? false },
          server: r.server_id === null ? null : { id: r.server_id, name: names.servers.get(r.server_id) ?? null },
          environment: r.environment === '' ? null : r.environment,
          connection_id: encodeConnectionId(r.connection_id),
        },
        stream: {
          type: r.stream_type,
          id: r.stream_id,
          label: r.stream_label,
          offset: r.stream_offset,
          journald_cursor: r.journald_cursor || null,
          generation: r.generation,
          seq: r.seq,
        },
        times: {
          ref_time: fromChTime(r.ref_time),
          time_source: r.ref_time_source,
          occurred_at: r.occurred_at === null ? null : fromChTime(r.occurred_at),
          observed_at: fromChTime(r.observed_at),
          received_at: fromChTime(r.received_at),
        },
        level: { normalized: r.level, raw: r.level_raw },
        body: r.body,
        body_encoding: r.body_is_base64 ? 'base64' : 'utf8',
        body_unescaped: r.body_unescaped === '' ? null : r.body_unescaped,
        parse: { status: r.parse_status, rule_version: r.parse_rule_version },
        fields,
        fields_truncated: r.fields_truncated,
        stack_trace: stackTrace(fields, r),
        flags: flagsOf(r),
        ...(r.kind === 'rejected' ? { reject_reason: r.reject_reason, reject_limit_bytes: r.reject_limit_bytes ?? null } : {}),
        ...(r.kind === 'boundary' ? { boundary_kind: r.boundary_kind, boundary_detail: r.boundary_detail || null } : {}),
      };
    });
  }

  /**
   * 주변 로그(Q09-01~03, UI-04). `stream`은 같은 흐름의 앞뒤를 세대·순번(원본 순서)으로, `service_server`는 같은 서비스·서버의
   * 다른 흐름까지 시간순(시간상 근접)으로 준다. 레벨·본문·필드·시간 조건은 풀고 차단 구간·보관·검색 가능 시각은 그대로 둔다.
   * 방향마다 건수와 기준 시각 앞뒤 시간 폭을 함께 제한하고, 더 갈 수 없으면 이유를 준다.
   */
  async nearby(session: SessionInfo, ref: string, body: z.infer<typeof NearbyBody>) {
    const key = parseEventRef(ref);
    if (!key) throw errors.notFound();
    const cfg = this.config.searchRun;
    const n = body.limit ?? cfg.nearbyPageDefault;
    if (n > cfg.nearbyPageMax) throw errors.validation([{ path: 'limit', reason: 'too_big' }]);
    const direction = body.direction ?? 'both';
    if (body.cursor && direction === 'both') throw errors.validation([{ path: 'cursor', reason: 'direction_required' }]);
    const cursor = body.cursor ? decodeCursor(body.cursor, ref, body.mode, direction as Side) : null;
    return this.runner.gate(session.idHash.toString('hex'), async (budget, track) => {
      const limits = await loadLimits(this.db, this.config);
      const anchor = await this.load(key, limits, budget, track);
      const t = usOfCh(anchor.ref_time);
      const w = BigInt(cfg.nearbyWindowMinutes) * 60_000_000n;
      const window = { from: t - w, to: t + w + 1n };
      const blocks = await loadBlocks(this.db, body.mode === 'stream' ? [anchor.connection_id] : await this.serviceConnections(anchor), {
        from: rfcOf(window.from),
        to: rfcOf(window.to),
      });
      const sides: Side[] = direction === 'both' ? ['before', 'after'] : [direction];
      const out: Record<string, unknown> = {};
      for (const side of sides) out[side] = await this.side(ref, body.mode, side, anchor, cursor, n, window, limits, blocks, budget, track);
      return {
        anchor: (await this.rowsOut.present([anchor]))[0],
        mode: body.mode,
        order: body.mode === 'stream' ? 'stream_order' : 'time',
        window: { from: rfcOf(window.from), to: rfcOf(window.to - 1n) },
        gaps: blocks.map((b) => ({ kind: 'manual_deletion', connection_id: encodeConnectionId(b.connectionId), from: b.from, to: b.to })),
        ...out,
      };
    });
  }

  private async serviceConnections(anchor: DetailRow): Promise<number[]> {
    const r = await this.db.query<{ id: number }>('SELECT id FROM connections WHERE service_id = $1', [anchor.service_id]);
    return r.rows.map((x) => x.id);
  }

  private async side(
    ref: string,
    mode: 'stream' | 'service_server',
    side: Side,
    anchor: DetailRow,
    cursor: NearbyCursor | null,
    n: number,
    window: { from: bigint; to: bigint },
    limits: Limits,
    blocks: Block[],
    budget: Budget,
    track: Track,
  ) {
    const p = new Params();
    const pos = cursor ?? { t: anchor.ref_time, c: anchor.connection_id, g: anchor.generation, s: anchor.seq };
    const cmp = side === 'before' ? '<' : '>';
    const dir = side === 'before' ? 'DESC' : 'ASC';
    const where = [
      `service_id = ${p.add('UInt32', anchor.service_id)}`,
      `ref_time >= ${p.time(rfcOf(window.from))}`,
      `ref_time < ${p.time(rfcOf(window.to))}`,
      `received_at >= ${p.time(limits.availableFrom)}`,
      `received_at < ${p.time(limits.receivedThrough)}`,
      ...blocks.map(
        (b) => `NOT (connection_id = ${p.add('UInt32', b.connectionId)} AND ref_time >= ${p.time(b.from)} AND ref_time < ${p.time(b.to)})`,
      ),
    ];
    let order: string;
    if (mode === 'stream') {
      where.push(`connection_id = ${p.add('UInt32', anchor.connection_id)}`, `stream_id = ${p.add('String', anchor.stream_id)}`);
      where.push(`(generation, seq) ${cmp} (${p.add('UInt16', pos.g)}, ${p.add('UInt64', pos.s)})`);
      order = `generation ${dir}, seq ${dir}`;
    } else {
      where.push(anchor.server_id === null ? 'server_id IS NULL' : `server_id = ${p.add('UInt32', anchor.server_id)}`, `kind = 'event'`);
      const tuple = `(${p.add("DateTime64(6, 'UTC')", pos.t)}, ${p.add('UInt32', pos.c)}, ${p.add('UInt16', pos.g)}, ${p.add('UInt64', pos.s)})`;
      where.push(`(ref_time, connection_id, generation, seq) ${cmp} ${tuple}`);
      order = ['ref_time', 'connection_id', 'generation', 'seq'].map((c) => `${c} ${dir}`).join(', ');
    }
    const chars = p.add('UInt32', this.config.searchRun.bodySummaryChars);
    const sql = `SELECT ${listColumns(chars)}, toString(kind) AS kind, reject_reason, reject_limit_bytes, boundary_kind, boundary_detail
FROM ${this.runner.ch.logs}
WHERE ${where.join('\n  AND ')}
ORDER BY ${order}
LIMIT ${p.add('UInt32', n + 1)}`;
    const rows = await this.runner.query<ListRow>(sql, p, budget, track);
    const page = rows.slice(0, n);
    let endReason: string | null = null;
    let next: string | null = null;
    if (rows.length > n) {
      const last = page[page.length - 1];
      next = encodeCursor({ a: ref.slice(0, 16), m: mode, d: side, t: last.ref_time, c: last.connection_id, g: last.generation, s: last.seq });
    } else if (side === 'before') {
      const edge = page.length ? page[page.length - 1] : cursor ? null : anchor;
      if (mode === 'stream' && edge?.kind === 'boundary' && ['initial_tail', 'new_file_head', 'new_file_tail'].includes(edge.boundary_kind ?? '')) {
        endReason = 'stream_start';
      } else if (mode === 'stream' && edge?.kind === 'boundary' && edge.boundary_kind === 'rotated') {
        // 시제품은 회전 경계 너머를 이어 붙이지 않는다(순서 확인된 회전을 따라가는 것은 남은 일).
        endReason = 'order_unknown';
      } else if (window.from < usOf(limits.availableFrom)) {
        endReason = 'retention';
      } else {
        endReason = 'limit';
      }
    } else {
      endReason = window.to > usOf(limits.receivedThrough) ? 'unobserved' : 'limit';
    }
    const shown = await this.rowsOut.present(side === 'before' ? [...page].reverse() : page);
    return { rows: shown, end_reason: endReason, next_cursor: next };
  }

  /**
   * 이벤트 하나를 읽는다. 없거나 보관 기간·조기 삭제·차단 구간에 걸리면 `410 event_unavailable`과 가능한 사유를 준다. 이유를
   * 하나도 댈 수 없으면 그런 이벤트가 없는 것(404)이다.
   */
  private async load(key: Key, limits: Limits, budget: Budget, track: Track): Promise<DetailRow> {
    const p = new Params();
    const sql = `SELECT ${listColumns(p.add('UInt32', 1_000_000_000))}, toString(kind) AS kind, toString(stream_type) AS stream_type, stream_id, stream_label,
       stream_offset, journald_cursor, observed_at, body_unescaped, parse_rule_version,
       toJSONString(fields) AS fields_json, JSONAllPathsWithTypes(fields) AS field_types, field_paths,
       reject_reason, reject_limit_bytes, boundary_kind, boundary_detail
FROM ${this.runner.ch.logs}
WHERE toDate(received_at) = ${p.add('Date', key.day)}
  AND connection_id = ${p.add('UInt32', key.c)} AND generation = ${p.add('UInt16', key.g)} AND seq = ${p.add('UInt64', key.s)}
LIMIT 1`;
    const [r] = await this.runner.query<DetailRow>(sql, p, budget, track);
    if (!r) throw await this.unavailable(key, limits);
    const received = usOfCh(r.received_at);
    if (received < usOf(limits.availableFrom)) {
      throw errors.eventUnavailable([received < usOf(limits.retentionFrom) ? 'retention' : 'early_deletion']);
    }
    const blocked = await this.db.query(
      `SELECT 1 FROM deletion_blocks WHERE connection_id = $1 AND ref_time_from <= $2::timestamptz AND ref_time_to > $2::timestamptz LIMIT 1`,
      [r.connection_id, fromChTime(r.ref_time)],
    );
    if (blocked.rowCount) throw errors.eventUnavailable(['manual_deletion']);
    return r;
  }

  private async unavailable(key: Key, limits: Limits) {
    const dayStart = `${key.day}T00:00:00.000000Z`;
    const dayEnd = rfcOf(usOf(dayStart) + 86_400_000_000n);
    const reasons: string[] = [];
    if (usOf(dayEnd) <= usOf(limits.retentionFrom)) reasons.push('retention');
    const r = (
      await this.db.query<{ early: boolean; manual: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM early_deletions WHERE received_from < $2::timestamptz AND received_to > $1::timestamptz) AS early,
                EXISTS (SELECT 1 FROM deletion_blocks WHERE connection_id = $3) AS manual`,
        [dayStart, dayEnd, key.c],
      )
    ).rows[0];
    if (r.early) reasons.push('early_deletion');
    if (r.manual) reasons.push('manual_deletion');
    return reasons.length ? errors.eventUnavailable(reasons) : errors.notFound();
  }
}

/**
 * 필드를 타입과 함께 준다(4.2절, SD-07·SD-21). 2^53을 넘는 정수는 문자열로 보내 정밀도를 잃지 않는다. 값이 null인 키는
 * `field_paths`에만 있으므로 거기서 찾는다. 객체를 담은 중간 키는 아래 경로로 드러나므로 따로 넣지 않는다.
 */
export function fieldList(json: string, types: Record<string, string>, paths: string[]) {
  const root = JSON.parse(json || '{}') as Record<string, unknown>;
  const valueAt = (path: string): unknown => {
    let cur: unknown = root;
    for (const seg of path.split('.')) {
      if (cur === null || typeof cur !== 'object' || !(seg in (cur as object))) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
  };
  const all = new Set([...Object.keys(types), ...paths]);
  const leaves = [...all].filter((p) => types[p] !== undefined || ![...all].some((q) => q.startsWith(p + '.')));
  return leaves.sort().map((path) => {
    const type = types[path];
    const v = valueAt(path);
    if (type === undefined || v === undefined || v === null) return { path, type: 'null', value: null };
    if (/^U?Int\d+$/.test(type)) {
      const text = String(v);
      return { path, type: 'number', value: Number.isSafeInteger(Number(text)) ? Number(text) : text };
    }
    if (/^Float\d+$/.test(type)) return { path, type: 'number', value: Number(v) };
    if (type === 'Bool') return { path, type: 'boolean', value: v === true || v === 'true' };
    if (type.startsWith('Array(')) return { path, type: 'array', value: v };
    return { path, type: 'string', value: typeof v === 'string' ? v : JSON.stringify(v) };
  });
}

/** stack trace(WQ-18). 따로 저장하지 않고 상세 조회 때 내장 필드 이름 목록에 맞는 필드나 여러 줄 이벤트의 이어진 줄에서 뽑는다. */
function stackTrace(fields: ReturnType<typeof fieldList>, r: DetailRow) {
  for (const name of STACK_FIELDS) {
    const f = fields.find((x) => x.path === name && x.type === 'string' && x.value);
    if (f) return { source: 'field', path: f.path, text: f.value as string };
  }
  if (!r.body_is_base64) {
    const lines = r.body.split('\n');
    if (lines.length > 1 && lines.slice(1).some((l) => l.trim() !== '')) return { source: 'body', path: null, text: lines.slice(1).join('\n') };
  }
  return null;
}

function encodeCursor(c: NearbyCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(raw: string, ref: string, mode: NearbyCursor['m'], side: Side): NearbyCursor {
  let c: NearbyCursor;
  try {
    c = JSON.parse(Buffer.from(raw, 'base64url').toString()) as NearbyCursor;
  } catch {
    throw errors.validation([{ path: 'cursor', reason: 'cursor_invalid' }]);
  }
  const ok =
    c && c.a === ref.slice(0, 16) && c.m === mode && c.d === side && typeof c.t === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(c.t) &&
    Number.isInteger(c.c) && Number.isInteger(c.g) && typeof c.s === 'string' && /^\d{1,20}$/.test(c.s);
  if (!ok) throw errors.validation([{ path: 'cursor', reason: 'cursor_invalid' }]);
  return c;
}

