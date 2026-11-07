// 중앙 서버 ClickHouse의 시험 전용 DB(`logdock_test`)를 쓰는 시험 도구(AGENTS.md DB 규칙의 2026-11-07 예외).
// - `LOGDOCK_TEST_CLICKHOUSE=1`로 켰을 때만 돈다. 평소 `npm test`는 중앙 서버에 닿지 않는다.
// - 측정(logdock-bench)이 돌고 있으면 시험하지 않는다. 상태 확인 계정의 SSH로 프로세스만 본다.
// - 상태 확인 계정의 SSH 포트 전달로만 접속하고, 실행마다 다른 표(`logs_api_` + 임의 값)를 공용 표 정의로 만들어 끝나면 지운다.
// 접속 정보는 저장소 루트 `.env`(커밋 제외)에서 읽고 출력하지 않는다.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';

import { ClickHouse, type ClickHouseConfig, quoteIdent } from '../clickhouse/clickhouse.js';

export interface TestClickHouse {
  config: ClickHouseConfig;
  ch: ClickHouse;
  stop(): Promise<void>;
}

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'db', 'clickhouse'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('repository root not found');
}

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

async function waitPort(port: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ok = await new Promise<boolean>((r) => {
      const c = connect(port, '127.0.0.1');
      c.once('connect', () => (c.destroy(), r(true)));
      c.once('error', () => r(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** 공용 표 정의(db/clickhouse/0001_logs.sql)를 시험 표 이름으로 바꾼다. */
export function logsDdl(database: string, table: string): string {
  const sql = readFileSync(join(repoRoot(), 'db', 'clickhouse', '0001_logs.sql'), 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('--'))
    .join('\n')
    .trim()
    .replace(/;$/, '');
  if (!sql.startsWith('CREATE TABLE logs\n')) throw new Error('unexpected DDL head');
  return sql.replace(/^CREATE TABLE logs\n/, `CREATE TABLE ${quoteIdent(database)}.${quoteIdent(table)}\n`);
}

/** 시험 ClickHouse를 준비한다. 쓸 수 없으면 건너뛸 이유(문자열)를 돌려준다. */
export async function startTestClickHouse(): Promise<TestClickHouse | string> {
  if (process.env.LOGDOCK_TEST_CLICKHOUSE !== '1') return 'LOGDOCK_TEST_CLICKHOUSE=1이 없어 중앙 시험 DB 시험을 건너뜀';
  const env = { ...readEnvFile(resolve(repoRoot(), '.env')), ...process.env };
  const host = env.LOGDOCK_TEST_CLICKHOUSE_SSH || 'logdock-central';
  const database = env.LOGDOCK_TEST_CLICKHOUSE_DB;
  const user = env.LOGDOCK_TEST_CLICKHOUSE_USER;
  const password = env.LOGDOCK_TEST_CLICKHOUSE_PASSWORD ?? null;
  if (!database || !user) return '.env에 시험 DB 정보가 없어 건너뜀';

  // 측정 중이면 시험하지 않는다. `[/]`는 이 명령 자신이 걸리지 않게 하는 정규식이다.
  const guard = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'pgrep -f "[/]srv/logdock/logdock-bench"'], { encoding: 'utf8' });
  if (guard.status === 0) return '중앙 서버에서 측정이 돌고 있어 건너뜀';
  if (guard.status !== 1) return '중앙 서버 상태를 확인하지 못해 건너뜀';

  const port = await freePort();
  const remote = env.LOGDOCK_TEST_CLICKHOUSE_REMOTE_PORT || '8123';
  const tunnel: ChildProcess = spawn(
    'ssh',
    ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8', '-L', `${port}:127.0.0.1:${remote}`, host],
    { stdio: 'ignore' },
  );
  const closeTunnel = () => {
    if (tunnel.exitCode === null) tunnel.kill();
  };
  if (!(await waitPort(port, 10_000))) {
    closeTunnel();
    return '시험 DB로 가는 SSH 포트 전달을 열지 못해 건너뜀';
  }
  const config: ClickHouseConfig = { url: `http://127.0.0.1:${port}`, database, table: `logs_api_${randomBytes(4).toString('hex')}`, user, password };
  const ch = new ClickHouse(config);
  try {
    await ch.exec(logsDdl(database, config.table));
  } catch (e) {
    closeTunnel();
    throw e;
  }
  return {
    config,
    ch,
    async stop() {
      try {
        await ch.exec(`DROP TABLE IF EXISTS ${ch.logs} SYNC`);
      } finally {
        closeTunnel();
      }
    },
  };
}
