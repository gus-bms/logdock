-- 세션마다 CSRF 토큰을 둔다(계약 초안 4.1절, T04. 2026-11-06 설계).
-- 서버에 세션 상태가 있으므로 OWASP CSRF 방지 지침의 synchronizer token 방식을 쓴다. 로그인 때 무작위
-- 32바이트를 만들어 세션 행에 두고, 로그인 응답과 GET /api/v1/auth/session이 돌려주며, 상태를 바꾸는
-- 요청의 X-CSRF-Token 헤더와 일정 시간 비교로 맞춘다.
-- 세션 ID는 해시만 두지만 이 값은 원문을 둔다. 세션 확인 응답이 다시 돌려줘야 하고, 세션 쿠키 없이는
-- 쓸 수 없는 값이기 때문이다.
-- 열을 NOT NULL로 더하므로 sessions에 행이 있으면 실패한다. 이 파일을 만들 때는 세션을 만드는 코드가 없었다.
SET search_path = logdock;

ALTER TABLE sessions ADD COLUMN csrf_token bytea NOT NULL;
ALTER TABLE sessions ADD CONSTRAINT sessions_csrf_token CHECK (octet_length(csrf_token) = 32);
