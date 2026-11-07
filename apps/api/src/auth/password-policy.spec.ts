// 새 비밀번호 규칙 시험(Q10-03, 계약 4.3절 `비밀번호 규칙`). DB 없이 돈다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COMMON_PASSWORDS } from './common-passwords.js';
import { MAX_PASSWORD_LENGTH } from './password.js';
import { blocklistKey, checkNewPassword, MIN_PASSWORD_CODE_POINTS } from './password-policy.js';

const ACCOUNT = 'admin';
const check = (p: string) => checkNewPassword(p, ACCOUNT);

describe('새 비밀번호 규칙', () => {
  it('15자부터 받고, 글자 수는 NFC로 맞춘 뒤 코드 포인트로 센다', () => {
    assert.equal(MIN_PASSWORD_CODE_POINTS, 15);
    assert.equal(check('k7#mQ2!vR9@tL4'), 'password_too_short'); // 14자
    assert.equal(check('k7#mQ2!vR9@tL4$'), null);
    const hangul = '바다가보이는언덕위의작은도서관'; // 완성형 15자
    assert.equal([...hangul].length, 15);
    assert.equal(check(hangul), null);
    // 조합형으로 들어와도 NFC로 맞춘 글자 수로 센다(코드 포인트는 더 많다)
    const decomposed = hangul.slice(0, 14).normalize('NFD');
    assert.ok([...decomposed].length > 15);
    assert.equal(check(decomposed), 'password_too_short');
  });

  it('로그인이 받는 최대 길이를 넘으면 password_too_long이다', () => {
    const long = Array.from({ length: MAX_PASSWORD_LENGTH + 1 }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join('');
    assert.equal(check(long), 'password_too_long');
  });

  it('흔하거나 유출된 값은 대소문자·공백·전각 문자를 바꿔도 막는다', () => {
    for (const p of ['1q2w3e4r5t6y7u8i', '1Q2W 3E4R 5T6Y 7U8I', '１ｑ２ｗ３ｅ４ｒ５ｔ６ｙ７ｕ８ｉ', 'Pass Word 1 2 3 4 5', 'I love you 1 2 3']) {
      assert.equal(check(p), 'password_common', p);
    }
  });

  it('비밀번호 전체를 비교하고, 흔한 낱말이 들어 있기만 한 긴 문장은 받는다', () => {
    assert.equal(check('password123 is not my password'), null);
    assert.equal(check('correct horse battery staple'), null);
  });

  it('서비스 이름·계정 이름에 숫자·기호만 더한 값은 막는다', () => {
    for (const p of ['LogDock-2026-logdock', 'admin admin 2026 logdock', 'logdocklogdock12', '#Admin_LogDock_0101!']) {
      assert.equal(check(p), 'password_common', p);
    }
    // 그 낱말이 들어 있어도 다른 낱말이 있으면 받는다
    assert.equal(check('my logdock passphrase is long'), null);
    // 그 낱말 없이 숫자만으로 된 값은 막지 않는다(글자 종류 조합 규칙이 되지 않게)
    assert.equal(check('839201746583920'), null);
    // 계정 이름은 받은 값으로 본다
    assert.equal(checkNewPassword('operator-operator-2026', 'Operator'), 'password_common');
  });

  it('되풀이와 한 방향으로 이어 친 값은 막는다', () => {
    for (const p of [
      'aaaaaaaaaaaaaaa',
      'passwordpassword',
      'abcabcabcabcabc',
      'correcthorsecorrecthorse',
      '123456789012345',
      '543210987654321',
      'abcdefghijklmnop',
      'zyxwvutsrqponmlk',
      'qwertyuiopasdfgh',
      '               ',
      '!              ',
    ]) {
      assert.equal(check(p), 'password_common', JSON.stringify(p));
    }
  });

  it('차단 목록의 값은 이미 비교 형태이고 10자 이상이며 겹치지 않는다', () => {
    assert.ok(COMMON_PASSWORDS.length > 9000);
    assert.equal(new Set(COMMON_PASSWORDS).size, COMMON_PASSWORDS.length);
    for (const e of COMMON_PASSWORDS) {
      assert.equal(blocklistKey(e), e, e);
      assert.ok([...e].length >= 10, e);
    }
  });
});
