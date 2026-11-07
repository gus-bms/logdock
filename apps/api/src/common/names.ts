// 이름 규칙(계약 5.3절, WQ-51·57). 서비스 이름·서버 표시명·계정 이름이 같이 쓴다. DB의 name_text 도메인과 같다:
// 앞뒤 공백을 빼고 1~N자, 제어 문자 불가, NFC로 저장. 길이 상한 N은 앱이 검사한다(설정값).

export type NameProblem = 'too_small' | 'too_big' | 'control_characters';

export type NameCheck = { ok: true; value: string } | { ok: false; reason: NameProblem };

/** 저장할 형태로 맞추고 규칙을 본다. 글자 수는 NFC로 맞춘 뒤 코드 포인트로 센다. */
export function checkName(raw: string, maxLength: number): NameCheck {
  const value = raw.normalize('NFC').trim();
  if (value === '') return { ok: false, reason: 'too_small' };
  if ([...value].length > maxLength) return { ok: false, reason: 'too_big' };
  if (/\p{Cc}/u.test(value)) return { ok: false, reason: 'control_characters' };
  return { ok: true, value };
}
