-- 로그인 연속 실패 잠금(2026-11-07 사용자 합의, 계약 4.3절 `인증 구현 설계`).
-- 계정 이름 열쇠의 행에 연속 실패 수와 잠긴 시각을 둔다. 성공하면 연속 실패 수가 0으로 돌아가고,
-- 한도에 닿으면 잠근다. 잠금은 서버 운영자의 로컬 재설정(admin reset-password)으로만 풀린다.
-- 오래된 시도 제한 기록을 지울 때 잠긴 행은 남긴다(계약 3.4절 보관 기간).
-- 적용: 소유 역할(logdock_owner)로 psql --single-transaction -v ON_ERROR_STOP=1 -f 이 파일.
SET search_path = logdock;

ALTER TABLE login_throttle
    ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0,
    ADD COLUMN locked_at timestamptz,
    ADD CONSTRAINT login_throttle_consecutive CHECK (consecutive_failures >= 0);
