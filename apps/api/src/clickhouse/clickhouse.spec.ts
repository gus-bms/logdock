// ClickHouse HTTP 접속 시험. 루프백 주소에 흉내 서버를 띄워 요청 꼴(파라미터 이스케이프·인증 헤더·서버 버퍼링)과 오류 해석을
// 본다. 실제 ClickHouse와의 동작은 search.live.spec에서 확인한다.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { ClickHouse, ClickHouseAborted, ClickHouseError, encodeParam, fromChTime, quoteIdent, toChTime } from './clickhouse.js';

describe('ClickHouse 접속', () => {
  let server: Server;
  let url: string;
  let last: { url: URL; headers: IncomingMessage['headers']; body: string };
  let reply: { status: number; headers?: Record<string, string>; body: string; delayMs?: number } = { status: 200, body: '' };

  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        last = { url: new URL(req.url!, 'http://x'), headers: req.headers, body };
        setTimeout(() => {
          res.writeHead(reply.status, reply.headers ?? {});
          res.end(reply.body);
        }, reply.delayMs ?? 0);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  const ch = (password: string | null = 'secret') => new ClickHouse({ url, database: 'logdock_test', table: 'logs_x', user: 'tester', password });

  it('값 이스케이프와 시각 표기', () => {
    assert.equal(encodeParam('a\tb\nc\\d\'e'), "a\\tb\\nc\\\\d'e");
    assert.equal(encodeParam(12345678901234567890n), '12345678901234567890');
    assert.equal(encodeParam(true), 'true');
    assert.throws(() => encodeParam(Number.NaN));
    assert.equal(quoteIdent('a`b'), '`a\\`b`');
    assert.equal(toChTime('2026-11-05T01:02:03.5Z'), '2026-11-05 01:02:03.500000');
    assert.equal(fromChTime('2026-11-05 01:02:03.000001'), '2026-11-05T01:02:03.000001Z');
    assert.equal(ch().logs, '`logdock_test`.`logs_x`');
  });

  it('질의는 본문, 값은 param_으로 보내고 서버에서 결과를 다 만든 뒤 받는다', async () => {
    reply = { status: 200, body: '{"n":"1"}\n{"n":"2"}\n' };
    const rows = await ch().rows<{ n: string }>('SELECT {p0:String} AS n', {
      params: { p0: 'x\ty' },
      settings: { max_execution_time: 2 },
      queryId: 'q-1',
    });
    assert.deepEqual(rows, [{ n: '1' }, { n: '2' }]);
    assert.equal(last.body, 'SELECT {p0:String} AS n\nFORMAT JSONEachRow');
    assert.equal(last.url.searchParams.get('param_p0'), 'x\\ty');
    assert.equal(last.url.searchParams.get('wait_end_of_query'), '1');
    assert.equal(last.url.searchParams.get('database'), 'logdock_test');
    assert.equal(last.url.searchParams.get('max_execution_time'), '2');
    assert.equal(last.url.searchParams.get('query_id'), 'q-1');
    assert.equal(last.headers['x-clickhouse-user'], 'tester');
    assert.equal(last.headers['x-clickhouse-key'], 'secret');
    await ch(null).exec('SELECT 1');
    assert.equal(last.headers['x-clickhouse-key'], undefined);
  });

  it('넣기는 질의를 주소에, 행을 본문에 담는다', async () => {
    reply = { status: 200, body: '' };
    await ch().insert('`db`.`t`', [{ a: 1 }, { a: 2 }]);
    assert.equal(last.url.searchParams.get('query'), 'INSERT INTO `db`.`t` FORMAT JSONEachRow');
    assert.equal(last.body, '{"a":1}\n{"a":2}');
  });

  it('오류 코드를 읽어 실행 상한·취소를 구분한다', async () => {
    reply = { status: 500, headers: { 'X-ClickHouse-Exception-Code': '159' }, body: 'Code: 159. DB::Exception: Timeout exceeded' };
    const e = await ch().rows('SELECT 1').catch((x) => x);
    assert.ok(e instanceof ClickHouseError);
    assert.equal(e.code, 159);
    assert.ok(e.timedOut);
    reply = { status: 500, headers: { 'X-ClickHouse-Exception-Code': '394' }, body: 'cancelled' };
    assert.ok(((await ch().rows('SELECT 1').catch((x) => x)) as ClickHouseError).cancelled);
  });

  it('응답 대기 상한과 취소는 끊은 이유를 남긴다', async () => {
    reply = { status: 200, body: '', delayMs: 300 };
    const timeout = await ch().rows('SELECT 1', { timeoutMs: 50 }).catch((x) => x);
    assert.ok(timeout instanceof ClickHouseAborted);
    assert.equal(timeout.reason, 'timeout');
    const ac = new AbortController();
    const p = ch().rows('SELECT 1', { signal: ac.signal }).catch((x) => x);
    ac.abort();
    const aborted = await p;
    assert.ok(aborted instanceof ClickHouseAborted);
    assert.equal(aborted.reason, 'aborted');
  });

  it('멈출 질의가 이미 없으면 멈춘 것으로 보고, 확인하지 못하면 false다', async () => {
    reply = { status: 200, body: '' };
    assert.equal(await ch().kill('q-1'), true);
    assert.match(last.body, /^KILL QUERY WHERE query_id = \{id:String\} SYNC/);
    reply = { status: 200, body: '{"kill_status":"finished"}\n' };
    assert.equal(await ch().kill('q-1'), true);
    reply = { status: 200, body: '{"kill_status":"waiting"}\n' };
    assert.equal(await ch().kill('q-1'), false);
    reply = { status: 500, body: 'Code: 497. DB::Exception: Not enough privileges' };
    assert.equal(await ch().kill('q-1'), false);
  });
});
