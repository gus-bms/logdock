// 흔하거나 유출된 비밀번호 차단 목록(src/auth/common-passwords.ts)을 만든다. 계약 4.3절 `비밀번호 규칙`.
// 원본은 저장소에 두지 않는다. SOURCE_URL에서 받은 파일을 인자로 넘기면 고정한 해시와 맞는지 보고 목록을 다시 쓴다.
//
//   node apps/api/scripts/build-common-passwords.mjs 100k-most-used-passwords-NCSC.txt
//
// 비교 형태는 src/auth/password-policy.ts의 blocklistKey와 같아야 한다. password-policy.spec.ts가 목록의 값이
// 이미 그 형태인지 확인한다.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_COMMIT = '1a7bb9127eca9e6ff2fc0301c597fe6e16a0cb56';
const SOURCE_PATH = 'Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt';
const SOURCE_URL = `https://raw.githubusercontent.com/danielmiessler/SecLists/${SOURCE_COMMIT}/${SOURCE_PATH}`;
const SOURCE_SHA256 = 'c2e5696882c603b76bb67a47ee970897e5a76fc4c3f5547abe3d0ca340c576e0';
/** 15자 이상 비밀번호도 공백을 빼면 짧아질 수 있어, 비교 형태가 이 길이 이상인 값을 남긴다. */
const MIN_KEY_LENGTH = 10;

const SECLISTS_LICENSE = `MIT License

Copyright (c) 2018 Daniel Miessler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const blocklistKey = (s) => s.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
/** 공개 저장소에 사람을 가리킬 수 있는 값을 두지 않으려고 메일 주소 모양(앞부분에 글자·숫자가 있는 것)은 뺀다. */
const looksLikeEmail = (k) => /^[^@]*[\p{L}\p{N}][^@]*@[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(k);

const source = process.argv[2];
if (!source) {
  console.error(`usage: node build-common-passwords.mjs <source.txt>\nsource: ${SOURCE_URL}`);
  process.exit(2);
}
const raw = readFileSync(source);
const sha = createHash('sha256').update(raw).digest('hex');
if (sha !== SOURCE_SHA256) {
  console.error(`source sha256 ${sha} does not match the pinned ${SOURCE_SHA256}`);
  process.exit(1);
}

const keys = [...new Set(raw.toString('utf8').split(/\r?\n/u).map(blocklistKey))]
  .filter((k) => [...k].length >= MIN_KEY_LENGTH && !looksLikeEmail(k))
  .sort();

const header = [
  '// 생성 파일이다. 직접 고치지 말고 apps/api/scripts/build-common-passwords.mjs로 다시 만든다.',
  '//',
  '// 흔하거나 유출된 비밀번호 차단 목록(Q10-03, 계약 4.3절 `비밀번호 규칙`).',
  `// 원본: SecLists ${SOURCE_PATH}`,
  `//   커밋 ${SOURCE_COMMIT}, sha256 ${SOURCE_SHA256}`,
  '//   영국 NCSC가 Have I Been Pwned의 Pwned Passwords에서 가장 많이 쓰인 10만 개로 공개한 목록의 사본이다.',
  '//   Have I Been Pwned는 Pwned Passwords에 라이선스·출처 표시 요구가 없다고 밝힌다.',
  `// 비교 형태(NFKC, 소문자, 공백 제거)가 ${MIN_KEY_LENGTH}자 이상인 값 ${keys.length}개만 남겼다. 메일 주소 모양은 뺐다.`,
  '//',
  '// SecLists 라이선스:',
  ...SECLISTS_LICENSE.split('\n').map((l) => (l ? `// ${l}` : '//')),
  '',
  'export const COMMON_PASSWORDS: readonly string[] = [',
].join('\n');

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'auth', 'common-passwords.ts');
writeFileSync(out, `${header}\n${keys.map((k) => `  ${JSON.stringify(k)},`).join('\n')}\n];\n`);
console.log(`wrote ${keys.length} entries to ${out}`);
