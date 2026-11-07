// 연결 설정 파일(계약 2.8절 `<connection_id>.toml`). 내용은 connection_configs.content(키 없음)에 버전별로 두고, 파일은
// 그 내용에서 그때 만든다. 에이전트의 TOML 읽기(agent/internal/config/toml.go)가 받는 문법만 쓴다: 주석, 한 단계 표,
// 기본·리터럴 문자열, 정수. 생성 결과는 에이전트 시험(TestCentralConfigFile)이 같은 글자로 읽어 확인한다.
import type { ConnectionInput } from './connection-input.js';

export interface ConfigContent {
  connection_id: string;
  config_version: number;
  ingest_url: string;
  target: { type: string; path?: string; kind?: string; name?: string };
  format: { type: string; event_start?: string; log_timezone?: string; max_event_bytes: number };
}

export function configContent(connectionId: string, version: number, ingestUrl: string, input: ConnectionInput): ConfigContent {
  const t = input.target;
  const target = t.type === 'journald' ? { type: t.type, kind: t.kind, name: t.name } : { type: t.type, path: t.path };
  const format: ConfigContent['format'] = { type: input.format.type, max_event_bytes: input.format.maxEventBytes };
  if (input.format.eventStart) format.event_start = input.format.eventStart;
  if (input.format.logTimezone) format.log_timezone = input.format.logTimezone;
  return { connection_id: connectionId, config_version: version, ingest_url: ingestUrl, target, format };
}

/**
 * TOML 문자열 값. 작은따옴표와 제어 문자가 없으면 리터럴 문자열(`'...'`)로 써서 정규식의 `\`를 그대로 보이게 하고,
 * 있으면 기본 문자열(`"..."`)로 `\`·`"`·제어 문자를 이스케이프한다.
 */
export function tomlString(v: string): string {
  if (!/['\u0000-\u001f\u007f]/u.test(v)) return `'${v}'`;
  let out = '"';
  for (const ch of v) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (cp < 0x20 || cp === 0x7f) out += `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

export function renderToml(c: ConfigContent): string {
  const kv = (k: string, v: string | number) => `${k} = ${typeof v === 'number' ? String(v) : tomlString(v)}`;
  const lines = [
    `# LogDock 수집 연결 설정. 중앙이 만든 파일이다. 키는 같은 폴더의 ${c.connection_id}.key에 따로 둔다.`,
    kv('connection_id', c.connection_id),
    kv('config_version', c.config_version),
    kv('ingest_url', c.ingest_url),
    '',
    '[target]',
    kv('type', c.target.type),
  ];
  if (c.target.path !== undefined) lines.push(kv('path', c.target.path));
  if (c.target.kind !== undefined) lines.push(kv('kind', c.target.kind));
  if (c.target.name !== undefined) lines.push(kv('name', c.target.name));
  lines.push('', '[format]', kv('type', c.format.type));
  if (c.format.event_start !== undefined) lines.push(kv('event_start', c.format.event_start));
  if (c.format.log_timezone !== undefined) lines.push(kv('log_timezone', c.format.log_timezone));
  lines.push(kv('max_event_bytes', c.format.max_event_bytes), '');
  return lines.join('\n');
}
