import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CURRENT, hashPassword, verifyPassword } from './password.js';

test('Argon2id PHC 문자열로 저장하고 맞는 비밀번호만 받는다', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.match(stored, /^\$argon2id\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.deepEqual(await verifyPassword('correct horse battery staple', stored), { ok: true, needsRehash: false });
  assert.equal((await verifyPassword('correct horse battery stapl', stored)).ok, false);
  assert.notEqual(await hashPassword('correct horse battery staple'), stored, 'salt must differ');
});

test('조합형과 완성형으로 들어온 같은 글자는 같은 비밀번호다', async () => {
  const stored = await hashPassword('café 비밀 문장 열다섯 자 이상');
  assert.equal((await verifyPassword('café 비밀 문장 열다섯 자 이상', stored)).ok, true);
});

test('비용 값이 지금 기준과 다르면 다시 해시하라고 알린다', async () => {
  const old = await hashPassword('correct horse battery staple', { ...CURRENT, passes: 1 });
  assert.deepEqual(await verifyPassword('correct horse battery staple', old), { ok: true, needsRehash: true });
  assert.deepEqual(await verifyPassword('wrong', old), { ok: false, needsRehash: false });
});

test('형식이 깨진 저장 값은 맞지 않은 것으로 본다', async () => {
  for (const bad of ['', 'plain', '$argon2i$m=1,t=1,p=1$AAAA$AAAA', '$argon2id$m=19456,t=2$AAAA$AAAA']) {
    assert.equal((await verifyPassword('x', bad)).ok, false, bad);
  }
});
