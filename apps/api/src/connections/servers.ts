import type { Queryable } from '../db/database.js';

/** 서버 표시명은 이름 목록의 한 항목이다. 같은 이름(대소문자 무시)이면 같은 서버로 묶고 없으면 만든다(SD-11). */
export async function findOrCreateServer(c: Queryable, displayName: string): Promise<number> {
  await c.query('INSERT INTO servers (display_name) VALUES ($1) ON CONFLICT ((lower(display_name))) DO NOTHING', [displayName]);
  return (await c.query<{ id: number }>('SELECT id FROM servers WHERE lower(display_name) = lower($1)', [displayName])).rows[0].id;
}

/** 같은 서버·같은 대상의 보관되지 않은 다른 연결(Q07-06). 없으면 null이다. */
export async function activeDuplicate(c: Queryable, serverId: number, identity: string, exceptId: number | null): Promise<number | null> {
  const r = await c.query<{ id: number }>(
    `SELECT id FROM connections
      WHERE server_id = $1 AND target_identity = $2 AND management_state <> 'archived' AND id IS DISTINCT FROM $3
      ORDER BY id LIMIT 1`,
    [serverId, identity, exceptId],
  );
  return r.rows[0]?.id ?? null;
}
