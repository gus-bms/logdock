#!/usr/bin/env node
/**
 * LogDock 기획 문서 정적 점검. 파일을 수정하지 않고 외부 의존성이 없다.
 *
 * 사용법: node .claude/skills/plan-audit/scripts/check-docs.mjs [저장소 경로]
 *
 * 종료 코드
 *   0  문제 없음 (사람이 판단할 '확인' 항목은 있을 수 있음)
 *   1  문제 있음
 *   2  기준 문서나 절을 찾지 못해 점검할 수 없음
 *
 * Q 목록과 잔여 수를 코드에 적지 않는다. 기준은 매번
 * docs/planning/user-decisions-*.md의 '잔여 협의 집계 기준' 표에서 읽는다.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(scriptDir, '../../../..');

const ID_RE = /(?<![A-Za-z0-9-])(?:[QD]\d{2}(?:-\d{2})?|[FP]\d{2}|(?:AT|IT|OT|OB)-\d{2})(?![A-Za-z0-9])/g;
const RECOMMENDED_OPTION_RE = /\*\*[A-Z]안 \(추천\)\*\*/;
const RANGE_RE = /([A-Z]{1,2}\d{0,2}-?)(\d{2})~(?:\1)?(\d{2})/g;
const COUNT_RE = /(\d+)개\s*(?:최상위\s*)?(?:Q\s*)?범위/g;
const PENDING_RE = /답변 대기|결정 대기|선택 대기|협의 중|추천안은 미채택/g;
const DATED_LINE_RE = /^(?:[-*]\s+)?\**\d{4}-\d{2}-\d{2}/;
const PERCENTILE_RE = /^P(?:50|75|90|95|99)$/;
const SECRET_RES = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-ant-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[abpr]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const LOCAL_PATH_RE = /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\/;
const IPV4_RE = /(?<![\d.§vV])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const SAFE_EMAIL_RE = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|example|test|invalid|localhost)$|^git@github\.com$/i;

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.md') ? [full] : [];
  });
}

function loadDoc(full) {
  return { full, rel: relative(root, full).split('\\').join('/'), lines: readFileSync(full, 'utf8').split('\n') };
}

/** 코드 블록을 비우고 인라인 코드를 지운 줄을 돌려준다. 예시 코드를 문서 구조로 읽지 않기 위해서다. */
function proseLines(doc) {
  let fence = null;
  return doc.lines.map((line) => {
    const mark = line.match(/^\s*(```+|~~~+)/);
    if (mark) {
      if (!fence) fence = mark[1][0];
      else if (mark[1][0] === fence) fence = null;
      return '';
    }
    return fence ? '' : line.replace(/`[^`]*`/g, '');
  });
}

/** GitHub의 heading anchor 규칙. 같은 제목이 반복되면 -1, -2가 붙는다. */
function collectAnchors(doc) {
  const anchors = new Set();
  const seen = new Map();
  for (const line of proseLines(doc)) {
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(m[1]);
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const slug = heading[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
      .replace(/ /g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

function clip(text, at, width = 34) {
  const start = Math.max(0, at - width);
  const piece = text.slice(start, at + width).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${piece}${at + width < text.length ? '…' : ''}`;
}

/** 정의로 볼 수 있는 자리의 텍스트: 제목, 표 첫 칸, 목록·문단의 굵은 머리말. */
function definitionText(line) {
  const heading = line.match(/^#{1,6}\s+(.+)$/);
  if (heading) return heading[1];
  const cell = line.match(/^\|([^|]*)\|/);
  if (cell) return cell[1];
  const bold = line.match(/^\s*(?:[-*]\s+)?\*\*([^*]+)\*\*/);
  return bold ? bold[1] : '';
}

function addDefinitions(text, defined) {
  for (const [id] of text.matchAll(ID_RE)) defined.add(id);
  for (const [, prefix, from, to] of text.matchAll(RANGE_RE)) {
    for (let n = Number(from); n <= Number(to); n += 1) {
      defined.add(`${prefix}${String(n).padStart(2, '0')}`);
    }
  }
}

function remainingQs(doc) {
  const start = doc.lines.findIndex((line) => /^#{2,4}\s+잔여 협의 집계 기준/.test(line));
  if (start < 0) return null;
  const level = doc.lines[start].match(/^#+/)[0].length;
  const ids = [];
  for (const line of doc.lines.slice(start + 1)) {
    const heading = line.match(/^(#+)\s/);
    if (heading && heading[1].length <= level) break;
    const row = line.match(/^\|\s*(Q\d{2})\s*\|/);
    if (row) ids.push(row[1]);
  }
  return ids;
}

const docsDir = join(root, 'docs');
const planDocs = [
  ...['AGENTS.md', 'README.md', 'CONTRIBUTING.md'].map((name) => join(root, name)).filter(existsSync),
  ...walk(docsDir),
].map(loadDoc);
const skillDocs = walk(join(root, '.claude/skills')).map(loadDoc);

const decisionList = planDocs.find((doc) => /^docs\/planning\/user-decisions-.*\.md$/.test(doc.rel));
const docsIndex = planDocs.find((doc) => doc.rel === 'docs/README.md');
const remaining = decisionList ? remainingQs(decisionList) : null;
if (!decisionList || !docsIndex || remaining === null) {
  console.error('기준을 찾지 못했습니다: docs/README.md와 user-decisions의 "잔여 협의 집계 기준" 절이 필요합니다.');
  process.exit(2);
}

const problems = { '깨진 링크': [], '정의 없는 ID': [], '문서 안내 누락': [], '공개 저장소 위험': [] };
const reviews = { '잔여 수 불일치': [], '합의 뒤 남은 대기 표현': [] };

const anchorsByPath = new Map(planDocs.map((doc) => [doc.full, collectAnchors(doc)]));
const indexTargets = new Set();
const defined = new Set();
const references = [];
let linkCount = 0;
let datedCountLines = 0;

for (const doc of planDocs) {
  proseLines(doc).forEach((line, index) => {
    const where = `${doc.rel}:${index + 1}`;

    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      linkCount += 1;
      const [path, rawAnchor] = target.split('#');
      const file = path ? resolve(dirname(doc.full), path) : doc.full;
      if (doc === docsIndex) indexTargets.add(file);
      if (!existsSync(file)) {
        problems['깨진 링크'].push(`${where} 파일 없음: ${target}`);
      } else if (rawAnchor && file.endsWith('.md')) {
        const anchors = anchorsByPath.get(file);
        const anchor = decodeURIComponent(rawAnchor);
        if (anchors && !anchors.has(anchor) && !anchors.has(anchor.toLowerCase())) {
          problems['깨진 링크'].push(`${where} 제목 없음: ${target}`);
        }
      }
    }

    addDefinitions(definitionText(line), defined);
    const prose = line.replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, '');
    for (const m of prose.matchAll(ID_RE)) references.push({ id: m[0], where, text: clip(prose, m.index) });

    for (const m of prose.matchAll(COUNT_RE)) {
      const before = prose.slice(Math.max(0, m.index - 40), m.index);
      const after = prose.slice(m.index + m[0].length, m.index + m[0].length + 8);
      if (!before.includes('잔여') && !after.includes('남')) continue;
      if (Number(m[1]) === remaining.length) continue;
      if (doc.rel.startsWith('docs/agent/done/')) continue;
      if (doc.rel === 'docs/decisions.md' && DATED_LINE_RE.test(line)) {
        datedCountLines += 1;
        continue;
      }
      reviews['잔여 수 불일치'].push(`${where} ${m[1]}개로 표기: ${clip(prose, m.index)}`);
    }

    for (const m of prose.matchAll(PENDING_RE)) {
      if (doc.rel.startsWith('docs/research/') || doc.rel.startsWith('docs/agent/')) continue;
      const window = prose.slice(Math.max(0, m.index - 70), m.index + 70);
      const qs = [...window.matchAll(/(?<![A-Za-z0-9-])Q\d{2}/g)].map((q) => q[0]);
      if (qs.length > 0 && !qs.some((q) => remaining.includes(q))) {
        reviews['합의 뒤 남은 대기 표현'].push(`${where} ${clip(prose, m.index)}`);
      }
    }
  });
}

const reported = new Set();
for (const { id, where, text } of references) {
  if (defined.has(id) || PERCENTILE_RE.test(id)) continue;
  const key = `${id}@${where}`;
  if (reported.has(key)) continue;
  reported.add(key);
  problems['정의 없는 ID'].push(`${where} ${id}: ${text}`);
}

for (const doc of planDocs) {
  // docs/agent 작업 폴더는 폴더가 곧 목록이라 docs/README.md 등록을 요구하지 않는다.
  if (doc.rel.startsWith('docs/agent/') && doc.rel !== 'docs/agent/README.md') continue;
  if (doc.rel.startsWith('docs/') && doc !== docsIndex && !indexTargets.has(doc.full)) {
    problems['문서 안내 누락'].push(`${doc.rel}이(가) docs/README.md에 없습니다`);
  }
}

for (const doc of [...planDocs, ...skillDocs]) {
  doc.lines.forEach((line, index) => {
    const where = `${doc.rel}:${index + 1}`;
    const flag = (reason) => problems['공개 저장소 위험'].push(`${where} ${reason}`);
    if (SECRET_RES.some((re) => re.test(line))) flag('비밀값 형식');
    const local = line.match(LOCAL_PATH_RE);
    if (local) flag(`로컬 절대 경로: ${clip(line, local.index)}`);
    for (const m of line.matchAll(IPV4_RE)) {
      const octets = m.slice(1, 5).map(Number);
      const isLoopback = octets[0] === 127 || octets.every((n) => n === 0);
      const isDocRange = /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(m[0]);
      if (octets.every((n) => n <= 255) && !isLoopback && !isDocRange) flag(`IP 주소: ${m[0]}`);
    }
    for (const [email] of line.matchAll(EMAIL_RE)) {
      if (!SAFE_EMAIL_RE.test(email)) flag(`메일 주소: ${email}`);
    }
  });
}

function printGroup(title, items, limit = 30) {
  console.log(`[${title}] ${items.length}건`);
  for (const item of items.slice(0, limit)) console.log(`  ${item}`);
  if (items.length > limit) console.log(`  …외 ${items.length - limit}건`);
}

const problemTotal = Object.values(problems).reduce((sum, items) => sum + items.length, 0);
const reviewTotal = Object.values(reviews).reduce((sum, items) => sum + items.length, 0);

// 잔여 표는 Q ID만 센다. 기술 선정처럼 Q 밖의 선택은 '(추천)' 표시가 남은 선택표로 찾는다.
const waitingTables = planDocs
  .filter((doc) => doc.rel.startsWith('docs/planning/'))
  .map((doc) => [doc.rel, doc.lines.filter((line) => RECOMMENDED_OPTION_RE.test(line)).length])
  .filter(([, count]) => count > 0)
  .map(([rel, count]) => `${rel} (추천 표시 ${count}건)`);

console.log('LogDock 문서 정적 점검 (실행 검증이 아니라 Markdown 내용 대조)');
console.log(`기준 잔여: ${remaining.length}개 범위 (${remaining.join(', ') || '없음'}), 출처 ${decisionList.rel}`);
console.log(`답변 대기 선택표: ${waitingTables.join(', ') || '없음'}`);
console.log(`대상: 문서 ${planDocs.length}개, 내부 링크 ${linkCount}개, ID 참조 ${references.length}개`);
console.log('\n== 문제: 고쳐야 함 ==');
for (const [title, items] of Object.entries(problems)) printGroup(title, items);
console.log('\n== 확인: 현재 상태 문장인지 과거 기록인지 사람이 판단 ==');
for (const [title, items] of Object.entries(reviews)) printGroup(title, items);
if (datedCountLines > 0) console.log(`  (decisions.md의 날짜 기록 ${datedCountLines}건은 과거 시점 값이라 제외)`);
console.log(`\n합계: 문제 ${problemTotal}건, 확인 ${reviewTotal}건`);

process.exitCode = problemTotal > 0 ? 1 : 0;
