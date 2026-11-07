// 수집 연결의 외부 ID(계약 3.1절: 내부 정수 ID를 인코딩한 값, 예 `c_8f3k2`). 순번을 그대로 드러내지 않게 홀수를
// 곱해 섞고(2^31 위에서 되돌릴 수 있다) 36진수로 쓴다. 비밀이 아니며 인증은 키로 한다(2.2절).
// 에이전트는 `^c_[a-z0-9]+$` 꼴만 받는다.
const MOD = 2n ** 31n;
const MUL = 1_103_515_245n; // 홀수라 2^31 위에서 역원이 있다

/** 홀수 a의 2^31 위 역원(뉴턴 반복: 맞는 자릿수가 매번 두 배가 된다). */
function inverse(a: bigint): bigint {
  let x = a;
  for (let i = 0; i < 5; i++) x = (x * (2n - a * x)) % MOD;
  return ((x % MOD) + MOD) % MOD;
}

const INV = inverse(MUL);

export function encodeConnectionId(id: number): string {
  if (!Number.isInteger(id) || id <= 0 || id >= 2 ** 31) throw new RangeError(`connection id out of range: ${id}`);
  return `c_${((BigInt(id) * MUL) % MOD).toString(36)}`;
}

/** 외부 ID를 내부 ID로 되돌린다. 꼴이 다르거나 되돌린 값이 범위 밖이면 null이다. */
export function decodeConnectionId(publicId: string): number | null {
  const m = /^c_([0-9a-z]{1,7})$/.exec(publicId);
  if (!m) return null;
  const n = BigInt(parseInt(m[1], 36));
  if (n >= MOD) return null;
  const id = Number((n * INV) % MOD);
  // 같은 내부 ID는 한 가지 꼴로만 쓴다(앞자리 0 같은 다른 표기를 받지 않는다).
  if (id <= 0 || encodeConnectionId(id) !== publicId) return null;
  return id;
}
