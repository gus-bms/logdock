// LogDock 디자인 토큰 색 대비 정적 계산
// 실행: node docs/design/check-contrast.mjs
// tokens.css의 용도 토큰을 풀어 WCAG 2.x 대비 비율을 계산한다. 실제 화면 검증이 아니다.
// 반투명 색(rgb ... / a)은 계산하지 않는다.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const vars = {};
for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
  if (!(m[1] in vars)) vars[m[1]] = m[2].trim();
}

function resolve(name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`순환 참조: ${name}`);
  seen.add(name);
  const v = vars[name];
  if (v === undefined) throw new Error(`없는 토큰: ${name}`);
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolve(ref[1], seen) : v;
}

function luminance(hex) {
  const n = hex.replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function ratio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// [전경, 배경, 최소 비율, 용도]
// 4.5: 일반 글자(1.4.3). 3: 입력 테두리·상태 테두리·초점 표시 같은 비글자 요소(1.4.11).
const pairs = [];
const surfaces = ['--color-bg-surface', '--color-bg-page', '--color-bg-subtle', '--color-bg-hover', '--color-bg-selected', '--color-bg-selected-strong'];
for (const bg of surfaces) {
  pairs.push(['--color-text', bg, 4.5, '본문']);
  pairs.push(['--color-text-secondary', bg, 4.5, '보조 글자']);
  pairs.push(['--color-text-link', bg, 4.5, '링크']);
}
for (const bg of ['--color-bg-surface', '--color-bg-page']) {
  pairs.push(['--color-border-control', bg, 3, '입력 테두리']);
  pairs.push(['--color-text-tertiary', bg, 4.5, '3차 글자(표 머리)']);
}
for (const bg of surfaces) {
  pairs.push(['--color-focus', bg, 3, '초점 표시']);
}
pairs.push(['--color-text-on-accent', '--color-accent', 4.5, '주 버튼 글자']);
pairs.push(['--color-text-on-accent', '--color-accent-hover', 4.5, '주 버튼 글자(올림)']);
pairs.push(['--color-accent', '--color-bg-surface', 3, '주 버튼 모양']);
pairs.push(['--color-text-link', '--color-bg-selected-strong', 4.5, '고른 행 안 링크']);
pairs.push(['--color-accent-fg', '--color-accent-subtle', 4.5, '현재 메뉴 글자']);
pairs.push(['--color-accent-fg', '--color-bg-surface', 4.5, '분할 버튼 선택 글자']);
pairs.push(['--color-text-on-accent', '--color-danger-fg', 4.5, '위험 버튼 글자(확인 창)']);
pairs.push(['--color-danger-fg', '--color-bg-page', 4.5, '위험 글자(화면 바탕)']);
for (const s of ['success', 'warning', 'danger', 'info', 'unknown', 'neutral']) {
  pairs.push([`--color-${s}-fg`, `--color-${s}-bg`, 4.5, `${s} 배지 글자`]);
  pairs.push([`--color-${s}-fg`, '--color-bg-surface', 4.5, `${s} 글자(표면)`]);
  pairs.push([`--color-${s}-border`, '--color-bg-surface', 3, `${s} 표시점·막대`]);
  pairs.push([`--color-${s}-fg`, '--color-bg-selected', 4.5, `${s} 글자(고른 행)`]);
}

let fail = 0;
const rows = pairs.map(([fg, bg, min, use]) => {
  const r = ratio(resolve(fg), resolve(bg));
  const ok = r >= min;
  if (!ok) fail += 1;
  return `${ok ? '통과' : '미달'}  ${r.toFixed(2).padStart(5)} ≥ ${min}  ${use}  ${fg} / ${bg}`;
});
console.log('LogDock 토큰 색 대비 (정적 계산, WCAG 2.x 공식)');
console.log(rows.join('\n'));
console.log(`\n합계: ${pairs.length}쌍, 미달 ${fail}건`);
process.exit(fail ? 1 : 0);
