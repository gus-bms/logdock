import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';

import { type AppConfig } from '../config.js';
import { APP_CONFIG } from '../tokens.js';

export type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * 관리 DB(PostgreSQL). 스키마는 db/postgres/migrations가 기준이다.
 * 연결마다 search_path를 logdock으로, 시간대를 UTC로 둔다(계약 3.4절 설계 메모 DB 조건).
 */
@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool: pg.Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const { host, port, user, database, password, max } = config.db;
    this.pool = new pg.Pool({
      host,
      port,
      user,
      database,
      password,
      max,
      options: '-c search_path=logdock -c TimeZone=UTC',
    });
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, values);
  }

  /** 한 트랜잭션에서 fn을 돌린다. fn이 던지면 되돌린다. */
  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

/** savepoint 안에서 fn을 돌리고 실패하면 그 부분만 되돌린다. 트랜잭션 전체는 이어 간다. */
export async function trySavepoint(c: Queryable, name: string, fn: () => Promise<void>): Promise<boolean> {
  await c.query(`SAVEPOINT ${name}`);
  try {
    await fn();
    await c.query(`RELEASE SAVEPOINT ${name}`);
    return true;
  } catch {
    await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return false;
  }
}

/** timestamptz를 UTC RFC 3339 마이크로초 문자열로 바꾸는 SQL 식(계약 4.1절 값 표기). */
export function utc(expr: string): string {
  return `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
