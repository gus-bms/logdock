// 시험용 임시 PostgreSQL.
//
// 시험이 스스로 띄우고 끝나면 폴더째 지운다. AGENTS.md DB 안전 규칙의 예외(2026-11-05 합의) 범위만
// 쓴다: 이 PC의 임시 폴더에만 만들고, TCP 포트를 열지 않고(listen_addresses = '') 그 폴더의 소켓으로만
// 접속하며, 합성 데이터만 넣는다. 사용자가 만든 개발 DB(logdock_dev)나 다른 DB에는 접속하지 않는다.
// 접속 대상이 바뀌지 않도록 PG로 시작하는 환경 변수는 하위 프로세스에 넘기지 않는다.
//
// 외부 패키지 없이 PostgreSQL 명령(initdb, pg_ctl, psql)만 쓴다. 명령 위치는 LOGDOCK_PG_BIN,
// Homebrew postgresql@18, PATH 순서로 찾는다.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { appendFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 마이그레이션 파일 폴더. 파일 이름 순서로 적용한다. */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const USER = 'logdock_owner';
const DATABASE = 'logdock_test';
// 소켓 파일 이름(.s.PGSQL.<port>)에만 쓰인다. 소켓 폴더가 시험마다 달라 겹치지 않는다.
const PORT = 5432;

/** PostgreSQL 명령 폴더. 비면 PATH에서 찾는다. */
export function findPgBin() {
  if (process.env.LOGDOCK_PG_BIN) return process.env.LOGDOCK_PG_BIN;
  const brew = spawnSync('brew', ['--prefix', 'postgresql@18'], { encoding: 'utf8' });
  if (brew.status === 0 && brew.stdout.trim()) return join(brew.stdout.trim(), 'bin');
  return '';
}

/** PG로 시작하는 접속 설정을 뺀 환경. 클라이언트 인코딩만 UTF8로 고정한다. */
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('PG')) env[k] = v;
  }
  env.PGCLIENTENCODING = 'UTF8';
  return env;
}

/**
 * 임시 PostgreSQL을 띄우고 마이그레이션을 적용한다.
 * @param {{ binDir?: string, migrations?: boolean }} [options]
 */
export async function startEphemeralPostgres({ binDir = findPgBin(), migrations = true } = {}) {
  const bin = (name) => (binDir ? join(binDir, name) : name);
  const env = childEnv();
  const dir = await mkdtemp(join(tmpdir(), 'ldpg-'));
  const data = join(dir, 'data');
  const log = join(dir, 'server.log');
  let stopped = false;

  // 프로세스가 끝날 때 아직 멈추지 않았으면 동기로 멈추고 지운다.
  const cleanupSync = () => {
    if (stopped) return;
    stopped = true;
    spawnSync(bin('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { env, stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  };
  process.on('exit', cleanupSync);

  /** psql을 돌린다. 실패해도 던지지 않고 결과를 돌려준다. */
  const psql = (args, input) =>
    new Promise((resolve, reject) => {
      const p = spawn(
        bin('psql'),
        ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', dir, '-p', String(PORT), '-U', USER, ...args],
        { env },
      );
      let stdout = '';
      let stderr = '';
      p.stdout.setEncoding('utf8').on('data', (s) => (stdout += s));
      p.stderr.setEncoding('utf8').on('data', (s) => (stderr += s));
      p.on('error', reject);
      p.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
      p.stdin.end(input ?? '');
    });

  const instance = {
    /** 소켓 폴더. 접속 host로 쓴다. */
    host: dir,
    port: PORT,
    user: USER,
    database: DATABASE,
    /**
     * SQL 스크립트를 시험 DB에서 돌린다(psql 메타 명령 \gset 사용 가능). 결과 행은 "a|b" 꼴이다.
     * @param {string} sql
     */
    run: (sql) => psql(['-d', DATABASE, '-A', '-t', '-f', '-'], sql),
    /** 멈추고 폴더째 지운다. 여러 번 불러도 된다. */
    async stop() {
      if (stopped) return;
      stopped = true;
      process.off('exit', cleanupSync);
      try {
        await execFileAsync(bin('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { env });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };

  try {
    await execFileAsync(
      bin('initdb'),
      ['-D', data, '-U', USER, '-A', 'trust', '-E', 'UTF8', '--locale=C', '--locale-provider=builtin',
        '--builtin-locale=C.UTF-8', '-N', '--no-instructions'],
      { env },
    );
    await appendFile(
      join(data, 'postgresql.conf'),
      [
        '',
        "listen_addresses = ''", // TCP 포트를 열지 않는다
        `unix_socket_directories = '${dir}'`,
        `port = ${PORT}`,
        // 끝나면 지우는 DB라 디스크 확정을 기다리지 않는다
        'fsync = off',
        'synchronous_commit = off',
        'full_page_writes = off',
        "timezone = 'UTC'",
        'shared_buffers = 16MB',
        'max_connections = 20',
        '',
      ].join('\n'),
    );
    await execFileAsync(bin('pg_ctl'), ['-D', data, '-l', log, '-w', '-t', '30', 'start'], { env });
    const created = await psql(['-d', 'postgres', '-c', `CREATE DATABASE ${DATABASE}`]);
    if (!created.ok) throw new Error(created.stderr);
    if (migrations) {
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files) {
        const r = await psql(['-d', DATABASE, '--single-transaction', '-f', join(MIGRATIONS_DIR, f)]);
        if (!r.ok) throw new Error(`${f}: ${r.stderr}`);
      }
    }
  } catch (err) {
    const tail = await readFile(log, 'utf8').catch(() => '');
    cleanupSync();
    process.off('exit', cleanupSync);
    throw new Error(`ephemeral postgres: ${err.message}${tail ? `\nserver log:\n${tail.slice(-2000)}` : ''}`);
  }
  return instance;
}
