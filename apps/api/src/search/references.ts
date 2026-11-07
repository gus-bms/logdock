// 조건이 가리키는 서비스·서버·수집 연결의 지금 이름과 상태(저장 검색·알림 규칙 공용, 계약 4.3절). 조건에는 ID만 두므로
// 이름을 바꿔도 대상이 그대로이고(SD-11), 화면은 여기서 받은 지금 이름으로 조건 요약을 만든다. 보관된 대상을 가리키면
// `references_archived`로 알린다(Q11 설계 기본값, UI-05).
import { decodeConnectionId, encodeConnectionId } from '../connections/public-id.js';
import type { Queryable } from '../db/database.js';
import type { Condition } from './condition.js';

export interface ConnectionRef {
  id: string;
  server_display_name: string | null;
  target: { type: string; path: string | null; kind: string | null; name: string | null };
  management_state: string;
}

export interface ReferenceMaps {
  services: Map<number, { id: number; name: string; state: string }>;
  servers: Map<number, { id: number; display_name: string }>;
  connections: Map<number, ConnectionRef>;
}

export interface ResolvedReferences {
  services: { id: number; name: string; state: string }[];
  servers: { id: number; display_name: string }[];
  connections: ConnectionRef[];
}

/** 예전에 저장한 조건에 빠진 항목이 있어도 빈 목록으로 읽는다. */
export function sourcesOf(cond: Condition): Condition['sources'] {
  const s = cond.sources ?? ({} as Partial<Condition['sources']>);
  return { service_ids: s.service_ids ?? [], server_ids: s.server_ids ?? [], environments: s.environments ?? [], connection_ids: s.connection_ids ?? [] };
}

/** 여러 조건이 가리키는 대상을 모아 세 번의 질의로 읽는다(목록 한 쪽을 한 번에). */
export async function loadReferences(c: Queryable, conditions: Condition[]): Promise<ReferenceMaps> {
  const services = new Set<number>();
  const servers = new Set<number>();
  const connections = new Set<number>();
  for (const cond of conditions) {
    const s = sourcesOf(cond);
    s.service_ids.forEach((id) => services.add(id));
    s.server_ids.forEach((id) => id !== null && servers.add(id));
    s.connection_ids.forEach((pid) => {
      const id = decodeConnectionId(pid);
      if (id !== null) connections.add(id);
    });
  }
  const refs: ReferenceMaps = { services: new Map(), servers: new Map(), connections: new Map() };
  if (services.size) {
    const r = await c.query<{ id: number; name: string; state: string }>('SELECT id, name, state FROM services WHERE id = ANY($1)', [[...services]]);
    r.rows.forEach((x) => refs.services.set(x.id, x));
  }
  if (servers.size) {
    const r = await c.query<{ id: number; display_name: string }>('SELECT id, display_name FROM servers WHERE id = ANY($1)', [[...servers]]);
    r.rows.forEach((x) => refs.servers.set(x.id, x));
  }
  if (connections.size) {
    const r = await c.query<{
      id: number;
      display_name: string | null;
      target_type: string;
      target_path: string | null;
      journald_kind: string | null;
      journald_name: string | null;
      management_state: string;
    }>(
      `SELECT c.id, s.display_name, c.target_type, c.target_path, c.journald_kind, c.journald_name, c.management_state
         FROM connections c LEFT JOIN servers s ON s.id = c.server_id WHERE c.id = ANY($1)`,
      [[...connections]],
    );
    r.rows.forEach((x) =>
      refs.connections.set(x.id, {
        id: encodeConnectionId(x.id),
        server_display_name: x.display_name,
        target: { type: x.target_type, path: x.target_path, kind: x.journald_kind, name: x.journald_name },
        management_state: x.management_state,
      }),
    );
  }
  return refs;
}

/** 조건 하나의 대상을 조건에 적힌 순서대로 풀고, 보관된 서비스·연결을 가리키는지 함께 준다. */
export function resolveReferences(cond: Condition, refs: ReferenceMaps): { references: ResolvedReferences; references_archived: boolean } {
  const s = sourcesOf(cond);
  const services = s.service_ids.flatMap((id) => refs.services.get(id) ?? []);
  const servers = s.server_ids.flatMap((id) => (id === null ? [] : (refs.servers.get(id) ?? [])));
  const connections = s.connection_ids.flatMap((pid) => {
    const id = decodeConnectionId(pid);
    return id === null ? [] : (refs.connections.get(id) ?? []);
  });
  return {
    references: { services, servers, connections },
    references_archived: services.some((x) => x.state === 'archived') || connections.some((x) => x.management_state === 'archived'),
  };
}
