// 발송 결과의 공통 처리. API의 테스트 메일과 worker의 알림·운영 메일이 같이 쓴다.
import type { MailConfig } from '../config.js';
import type { Queryable } from '../db/database.js';
import { type MailReason, problemOf } from './smtp.js';

/**
 * 메일 상태(한 행)에 마지막 시도와 결과를 남긴다(4.4절 메일 연결 상태). 주소 문제로 실패한 것은 연결이 된 것이라 연결 오류로
 * 남기지 않는다. 한 행이 없으면 넣는다(계약 3.4절 한 행 테이블).
 */
export async function recordMailStatus(c: Queryable, reason: MailReason | null): Promise<void> {
  const connectionError = reason && problemOf(reason) !== 'address' ? reason : null;
  await c.query(
    `INSERT INTO mail_status (id, last_attempt_at, last_success_at, last_error, updated_at)
     VALUES (1, now(), CASE WHEN $1 THEN now() END, $2, now())
     ON CONFLICT (id) DO UPDATE SET last_attempt_at = now(),
       last_success_at = CASE WHEN $1 THEN now() ELSE mail_status.last_success_at END,
       last_error = $2, updated_at = now()`,
    [reason === null, connectionError],
  );
}

/**
 * 실제로 보낼 주소. 수신처 고정(`LOGDOCK_MAIL_REDIRECT_TO`, 2026-11-07 합의)이 있으면 그 주소 하나로 바꾼다. 발화·묶음 때 이렇게
 * 수신자를 고정하고, 고정 전에 만든 작업도 보낼 때 한 번 더 바꿔 다른 사람에게 나가지 않게 한다.
 */
export function deliveryRecipients(mail: Pick<MailConfig, 'redirectTo'>, recipients: string[]): string[] {
  return mail.redirectTo ? [mail.redirectTo] : recipients;
}
