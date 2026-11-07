// ClickHouse HTTP 접속(계약 3.2절, 4.2절, 8.1절). 값은 모두 바인딩 파라미터(`{이름:형}`)로 보내고 SQL에 이어 붙이지
// 않는다(SD-15). 응답은 서버에서 다 만든 뒤 받아(`wait_end_of_query`) 중간 오류가 성공 응답 뒤에 숨지 않게 한다.
import { randomUUID } from 'node:crypto';

export interface ClickHouseConfig {
  /** HTTP 주소. 운영은 같은 서버의 127.0.0.1:8123이다. */
  url: string;
  database: string;
  /** 로그 테이블 이름. 시험은 실행마다 다른 이름을 쓴다. */
  table: string;
  user: string;
  password: string | null;
}

export type ParamValue = string | number | bigint | boolean;

export interface QueryOptions {
  params?: Record<string, ParamValue>;
  settings?: Record<string, string | number>;
  queryId?: string;
  signal?: AbortSignal;
  /** HTTP 응답을 기다리는 상한(밀리초). 서버 실행 상한은 `max_execution_time` 설정으로 따로 건다. */
  timeoutMs?: number;
}

/** ClickHouse가 돌려준 오류. 코드는 `X-ClickHouse-Exception-Code` 헤더 값이다. */
export class ClickHouseError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly status: number,
  ) {
    super(message);
  }

  /** 서버 실행 상한(`max_execution_time`)에 걸렸다(TIMEOUT_EXCEEDED). */
  get timedOut(): boolean {
    return this.code === 159;
  }

  /** KILL QUERY 등으로 서버에서 멈췄다(QUERY_WAS_CANCELLED). */
  get cancelled(): boolean {
    return this.code === 394;
  }
}

/** 요청을 보내기 전에 끊었거나(취소) HTTP 응답 대기 상한을 넘었다. 서버 쪽 질의는 따로 멈춰야 한다. */
export class ClickHouseAborted extends Error {
  constructor(readonly reason: 'aborted' | 'timeout') {
    super(`clickhouse request ${reason}`);
  }
}

/**
 * HTTP 파라미터 값은 ClickHouse의 Escaped(TSV) 텍스트 형식으로 읽힌다. 역슬래시와 제어 문자를 이스케이프하지 않으면
 * `\t`나 `\n`이 든 검색어가 다른 값으로 바뀐다.
 */
export function encodeParam(v: ParamValue): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('clickhouse parameter must be finite');
    return String(v);
  }
  if (typeof v === 'bigint') return v.toString();
  return v.replace(/[\\\t\n\r\b\f\0]/g, (c) => ESCAPES[c]);
}

const ESCAPES: Record<string, string> = { '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r', '\b': '\\b', '\f': '\\f', '\0': '\\0' };

/** 식별자(데이터베이스·테이블·JSON 경로 조각)를 역따옴표로 감싼다. 안의 역따옴표와 역슬래시는 이스케이프한다. */
export function quoteIdent(name: string): string {
  return '`' + name.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

/** API 표기(RFC 3339 UTC 마이크로초, `Z`)를 ClickHouse `DateTime64(6, 'UTC')` 파라미터 표기로 바꾼다. */
export function toChTime(rfc: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(rfc);
  if (!m) throw new Error(`not a UTC RFC 3339 time: ${rfc}`);
  return `${m[1]} ${m[2]}.${(m[3] ?? '').padEnd(6, '0')}`;
}

/** ClickHouse가 돌려준 `DateTime64(6, 'UTC')` 값을 API 표기로 바꾼다. */
export function fromChTime(ch: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(ch);
  if (!m) throw new Error(`not a ClickHouse time: ${ch}`);
  return `${m[1]}T${m[2]}.${(m[3] ?? '').padEnd(6, '0')}Z`;
}

/** JS 시각(밀리초)을 API 표기로 바꾼다. */
export function rfcFromDate(d: Date): string {
  return d.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

export class ClickHouse {
  constructor(readonly config: ClickHouseConfig) {}

  /** `데이터베이스.로그 테이블` 식별자. */
  get logs(): string {
    return `${quoteIdent(this.config.database)}.${quoteIdent(this.config.table)}`;
  }

  /**
   * 행을 돌려주는 질의. `FORMAT JSONEachRow`를 붙여 한 줄에 한 행씩 읽는다. 64비트 정수는 문자열로 받는다. 서버 기본값이
   * 버전마다 달라(26.8은 따옴표 없음) 설정을 늘 보낸다. 따옴표 없이 받으면 2^53을 넘는 순번·필드 값이 깎인다.
   */
  async rows<T>(sql: string, opts: QueryOptions = {}): Promise<T[]> {
    const text = await this.request(`${sql}\nFORMAT JSONEachRow`, {
      ...opts,
      settings: { output_format_json_quote_64bit_integers: 1, ...opts.settings },
    });
    const out: T[] = [];
    for (const line of text.split('\n')) if (line) out.push(JSON.parse(line) as T);
    return out;
  }

  /** 행을 돌려주지 않는 문장(DDL·INSERT·KILL). */
  async exec(sql: string, opts: QueryOptions = {}): Promise<void> {
    await this.request(sql, opts);
  }

  /** JSONEachRow 줄 묶음을 넣는다(시험용 합성 데이터). */
  async insert(table: string, rows: object[], opts: QueryOptions = {}): Promise<void> {
    if (rows.length === 0) return;
    const body = rows.map((r) => JSON.stringify(r)).join('\n');
    await this.request(body, { ...opts, settings: { ...opts.settings, query: `INSERT INTO ${table} FORMAT JSONEachRow` } }, true);
  }

  /**
   * 서버에서 질의를 멈춘다. 이미 끝났으면 멈춘 것으로 본다. 멈춤을 확인하지 못하면(권한·연결 문제) false다.
   * CM-04 취소의 `서버 중단 확인`에 쓴다.
   */
  async kill(queryId: string, timeoutMs = 3000): Promise<boolean> {
    try {
      const rows = await this.rows<{ kill_status: string }>('KILL QUERY WHERE query_id = {id:String} SYNC', {
        params: { id: queryId },
        timeoutMs,
      });
      return rows.every((r) => r.kill_status === 'finished');
    } catch {
      return false;
    }
  }

  newQueryId(): string {
    return randomUUID();
  }

  private async request(body: string, opts: QueryOptions, bodyIsData = false): Promise<string> {
    const q = new URLSearchParams();
    q.set('database', this.config.database);
    q.set('wait_end_of_query', '1');
    for (const [k, v] of Object.entries(opts.settings ?? {})) q.set(k, String(v));
    for (const [k, v] of Object.entries(opts.params ?? {})) q.set(`param_${k}`, encodeParam(v));
    if (opts.queryId) q.set('query_id', opts.queryId);
    if (bodyIsData && !q.has('query')) throw new Error('insert needs a query');
    const headers: Record<string, string> = { 'X-ClickHouse-User': this.config.user, 'Content-Type': 'text/plain; charset=utf-8' };
    if (this.config.password !== null) headers['X-ClickHouse-Key'] = this.config.password;

    const signals: AbortSignal[] = [];
    if (opts.signal) signals.push(opts.signal);
    if (opts.timeoutMs !== undefined) signals.push(AbortSignal.timeout(opts.timeoutMs));
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.config.url.replace(/\/$/, '')}/?${q.toString()}`, { method: 'POST', headers, body, signal });
      text = await res.text();
    } catch (e) {
      if (signal?.aborted) throw new ClickHouseAborted(opts.signal?.aborted ? 'aborted' : 'timeout');
      throw e;
    }
    if (res.status !== 200) {
      const code = Number(res.headers.get('x-clickhouse-exception-code'));
      throw new ClickHouseError(text.trim().slice(0, 800), Number.isInteger(code) && code > 0 ? code : null, res.status);
    }
    return text;
  }
}
