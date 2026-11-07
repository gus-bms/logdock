// 시험 도구: 임시 PostgreSQL(db/postgres/ephemeral.mjs)을 띄우고 앱을 루프백 주소에 붙인다.
// DB는 이 PC의 임시 폴더 소켓으로만 접속하는 시험용이다(AGENTS.md DB 안전 규칙 예외). 합성 데이터만 쓴다.
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

import { createApp } from '../app.js';
import { type AppConfig, DEFAULTS } from '../config.js';

export interface EphemeralPostgres {
  host: string;
  port: number;
  user: string;
  database: string;
  run(sql: string): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  stop(): Promise<void>;
}

function findHarness(): string {
  for (let dir = __dirname; ; ) {
    const p = join(dir, 'db', 'postgres', 'ephemeral.mjs');
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) throw new Error('db/postgres/ephemeral.mjs not found above ' + __dirname);
    dir = up;
  }
}

export async function startPostgres(): Promise<EphemeralPostgres> {
  const mod = (await import(pathToFileURL(findHarness()).href)) as {
    startEphemeralPostgres: () => Promise<EphemeralPostgres>;
  };
  return mod.startEphemeralPostgres();
}

export interface Api {
  base: string;
  /** 시험이 직접 쓰는 DB 연결(시각 조작·확인용). */
  db: pg.Pool;
  config: AppConfig;
  close(): Promise<void>;
}

export async function startApi(pgi: EphemeralPostgres, overrides: Partial<AppConfig> = {}): Promise<Api> {
  const config: AppConfig = {
    ...DEFAULTS,
    // 합성 주소. 시험은 설정 파일 내용만 보고 이 주소로 보내지 않는다.
    ingestUrl: 'https://ingest.logdock.example:8443/ingest/v1',
    db: { host: pgi.host, port: pgi.port, user: pgi.user, database: pgi.database, max: 4 },
    ...overrides,
  };
  const app = await createApp(config, false);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  const db = new pg.Pool({
    host: pgi.host,
    port: pgi.port,
    user: pgi.user,
    database: pgi.database,
    max: 2,
    options: '-c search_path=logdock -c TimeZone=UTC',
  });
  return {
    base: `http://127.0.0.1:${port}`,
    db,
    config,
    async close() {
      await db.end();
      await app.close();
    },
  };
}

export interface Reply {
  status: number;
  headers: Headers;
  body: any;
  setCookies: string[];
}

/** 쿠키를 들고 다니는 HTTP 시험 클라이언트. 상태를 바꾸는 요청에는 받은 CSRF 토큰을 단다. */
export class Client {
  readonly cookies = new Map<string, string>();
  csrf?: string;

  constructor(private readonly base: string) {}

  async call(
    method: string,
    path: string,
    opts: { body?: unknown; raw?: string; headers?: Record<string, string>; csrf?: string | false } = {},
  ): Promise<Reply> {
    const headers: Record<string, string> = { ...opts.headers };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let body: string | undefined;
    if (opts.raw !== undefined || opts.body !== undefined) {
      headers['content-type'] ??= 'application/json';
      body = opts.raw ?? JSON.stringify(opts.body);
    }
    const csrf = opts.csrf === undefined ? this.csrf : opts.csrf;
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    const res = await fetch(this.base + path, { method, headers, body });
    const setCookies = res.headers.getSetCookie();
    for (const c of setCookies) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value === '' || /;\s*Max-Age=0\b/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined, setCookies };
  }

  async login(name: string, password: string): Promise<Reply> {
    const r = await this.call('POST', '/api/v1/auth/login', { body: { name, password } });
    if (r.status === 200) this.csrf = r.body.csrf_token;
    return r;
  }
}
