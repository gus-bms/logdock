// 수집 연결 외부 ID(계약 3.1절) 시험. DB 없이 돈다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeConnectionId, encodeConnectionId } from './public-id.js';

describe('수집 연결 외부 ID', () => {
  it('내부 ID로 되돌릴 수 있고 에이전트가 받는 꼴이며 순번이 그대로 보이지 않는다', () => {
    const seen = new Set<string>();
    for (const id of [1, 2, 3, 42, 1000, 65535, 2 ** 31 - 1]) {
      const pub = encodeConnectionId(id);
      assert.match(pub, /^c_[a-z0-9]+$/);
      assert.equal(decodeConnectionId(pub), id, pub);
      seen.add(pub);
    }
    assert.equal(seen.size, 7);
    assert.notEqual(encodeConnectionId(2).slice(2), (2).toString(36));
  });

  it('꼴이 다르거나 같은 ID의 다른 표기는 받지 않는다', () => {
    const pub = encodeConnectionId(42);
    for (const bad of ['', 'c_', '42', `C${pub.slice(1)}`, `c_0${pub.slice(2)}`, 'c_zzzzzzzz', `${pub}/`, 'c_!x']) {
      assert.equal(decodeConnectionId(bad), null, bad);
    }
    assert.throws(() => encodeConnectionId(0));
    assert.throws(() => encodeConnectionId(2 ** 31));
  });
});
