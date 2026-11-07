// 중앙 로컬 명령(계약 8.2절). 설치 때 공용 계정과 초기 비밀번호를 만들고(set-password), 분실·잠금 때 다시
// 정한다(reset-password). 웹·API로는 열지 않고 서버에서 서비스 계정이나 관리자 권한으로만 실행한다.
import { AuditService } from '../audit/audit.service.js';
import { hashPassword } from '../auth/password.js';
import { checkNewPassword, type PasswordProblem } from '../auth/password-policy.js';
import { SessionService } from '../auth/session.service.js';
import { checkName } from '../common/names.js';
import { type AppConfig } from '../config.js';
import { Database } from '../db/database.js';

export type SetPasswordResult =
  | { kind: 'ok'; accountName: string; auditGap: boolean }
  | { kind: 'exists' }
  | { kind: 'bad_name' }
  | { kind: 'invalid'; reason: PasswordProblem };

export type ResetPasswordResult =
  | { kind: 'ok'; accountName: string; terminated: number; auditGap: boolean }
  | { kind: 'not_found' }
  | { kind: 'ambiguous' }
  | { kind: 'invalid'; reason: PasswordProblem };

export class AdminCommands {
  private readonly audit: AuditService;
  private readonly sessions: SessionService;

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {
    this.audit = new AuditService(config);
    this.sessions = new SessionService(config, db);
  }

  /**
   * 설치 때 공용 계정과 초기 비밀번호를 만든다. 계정이 이미 있으면 아무것도 바꾸지 않는다. 바꾸려면 세션 종료와
   * 시도 제한 해제가 함께 되는 reset-password를 쓴다. 감사를 쓸 수 없어도 진행하고 공백으로 남긴다.
   */
  async setPassword(name: string, password: string): Promise<SetPasswordResult> {
    // 5.3절 이름 규칙(name_text 도메인과 같음)을 따른다.
    const checked = checkName(name, this.config.nameMaxLength);
    if (!checked.ok) return { kind: 'bad_name' };
    const accountName = checked.value;
    const problem = checkNewPassword(password, accountName);
    if (problem) return { kind: 'invalid', reason: problem };
    const hash = await hashPassword(password);
    return this.db.tx(async (c): Promise<SetPasswordResult> => {
      // 동시에 두 번 실행해도 계정이 하나만 생기게 테이블 쓰기를 막고 본다(읽기는 막지 않는다).
      await c.query('LOCK TABLE accounts IN SHARE ROW EXCLUSIVE MODE');
      if ((await c.query('SELECT 1 FROM accounts LIMIT 1')).rowCount) return { kind: 'exists' };
      const r = await c.query<{ id: number }>('INSERT INTO accounts (name, password_hash) VALUES ($1, $2) RETURNING id', [
        accountName,
        hash,
      ]);
      const audited = await this.audit.writeOrGap(c, {
        action: 'auth.password_set_local',
        result: 'success',
        actorType: 'local_operator',
        accountId: r.rows[0].id,
      });
      return { kind: 'ok', accountName, auditGap: !audited };
    });
  }

  /**
   * 분실·잠금 때 새 비밀번호를 정하고 모든 웹 세션을 끝내며 로그인 시도 제한과 연속 실패 잠금을 푼다. 이름이 없으면
   * 하나뿐인 계정을 고른다. 감사를 쓸 수 없어도 진행하고 공백으로 남긴다(Q10-14 (6), WQ-89).
   */
  async resetPassword(name: string | undefined, password: string): Promise<ResetPasswordResult> {
    return this.db.tx(async (c): Promise<ResetPasswordResult> => {
      // FOR UPDATE: 진행 중인 로그인·웹 변경과 겹치지 않게 한다(로그인은 FOR SHARE로 기다린다).
      const r =
        name === undefined
          ? await c.query<{ id: number; name: string }>('SELECT id, name FROM accounts ORDER BY id LIMIT 2 FOR UPDATE')
          : await c.query<{ id: number; name: string }>('SELECT id, name FROM accounts WHERE lower(name) = lower($1) FOR UPDATE', [
              name.normalize('NFC').trim(),
            ]);
      if (r.rows.length === 0) return { kind: 'not_found' };
      if (r.rows.length > 1) return { kind: 'ambiguous' };
      const account = r.rows[0];
      const problem = checkNewPassword(password, account.name);
      if (problem) return { kind: 'invalid', reason: problem };
      await c.query('UPDATE accounts SET password_hash = $2, password_changed_at = now(), version = version + 1 WHERE id = $1', [
        account.id,
        await hashPassword(password),
      ]);
      const terminated = await this.sessions.revokeAll(c, account.id, 'password_reset_local');
      // 시도 제한 열쇠는 계정 이름과 접속 주소를 해시해 두어 이 계정의 열쇠만 골라낼 수 없다. 공용 계정 하나라 모두 지운다.
      await c.query('DELETE FROM login_throttle');
      const audited = await this.audit.writeOrGap(c, {
        action: 'auth.password_reset_local',
        result: 'success',
        actorType: 'local_operator',
        accountId: account.id,
      });
      return { kind: 'ok', accountName: account.name, terminated, auditGap: !audited };
    });
  }
}
