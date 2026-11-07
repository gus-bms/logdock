import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { AuditService } from '../audit/audit.service.js';
import { Database, type Queryable, utc } from '../db/database.js';
import { hashPassword, verifyPassword } from './password.js';
import { checkNewPassword, type PasswordProblem } from './password-policy.js';
import { type NewSession, type SessionInfo, SessionService } from './session.service.js';
import { type ThrottleState, ThrottleService } from './throttle.service.js';

/** 시도 제한으로 받지 않은 결과. throttled는 잠시 막힘, locked는 연속 실패 잠금(로컬 재설정으로만 풀림)이다. */
export type Refused = { kind: 'throttled'; wait: number } | { kind: 'locked' };

export type LoginResult = { kind: 'ok'; session: NewSession; accountName: string } | { kind: 'failed' } | Refused;

export type ReauthResult = { kind: 'ok'; until: string } | { kind: 'wrong' } | { kind: 'expired' } | Refused;

export type ChangePasswordResult =
  | { kind: 'ok'; changedAt: string; terminated: number }
  | { kind: 'wrong' }
  | { kind: 'invalid'; reason: PasswordProblem }
  | Refused;

function refusal(s: ThrottleState): Refused | null {
  if (s.kind === 'locked') return { kind: 'locked' };
  if (s.kind === 'blocked') return { kind: 'throttled', wait: s.wait };
  return null;
}

/**
 * 로그인·재확인·비밀번호 변경·로그아웃·전체 세션 종료(Q10-03·05·06·12·14, 계약 4.1·4.3·5.6절).
 * 실패 기록(시도 제한·감사)은 실패 응답을 돌려주기 전에 확정해야 하므로, 트랜잭션 안에서 던지지 않고
 * 결과를 돌려준 뒤 컨트롤러가 오류로 바꾼다.
 */
@Injectable()
export class AuthService implements OnModuleInit {
  private readonly log = new Logger('Auth');
  /** 없는 계정에도 같은 비용으로 비교해 계정이 있는지 시간으로 드러내지 않는다. */
  private dummyHash = '';

  constructor(
    private readonly db: Database,
    private readonly sessions: SessionService,
    private readonly throttle: ThrottleService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await hashPassword(randomBytes(24).toString('base64'));
  }

  async login(name: string, password: string, address: string): Promise<LoginResult> {
    const keys = this.throttle.keys(name, address);
    return this.db.tx(async (c): Promise<LoginResult> => {
      const refused = refusal(await this.throttle.check(c, keys));
      if (refused) return refused;
      // FOR SHARE: 진행 중인 비밀번호 변경·재설정이 끝날 때까지 기다렸다가 바뀐 해시로 비교한다.
      // 그러지 않으면 바뀌기 전 비밀번호로 만든 세션이 변경의 전체 세션 종료를 비켜 갈 수 있다.
      const r = await c.query<{ id: number; name: string; password_hash: string }>(
        'SELECT id, name, password_hash FROM accounts WHERE lower(name) = lower($1) FOR SHARE',
        [name.normalize('NFC').trim()],
      );
      const account = r.rows[0];
      const v = await verifyPassword(password, account?.password_hash ?? this.dummyHash);
      if (!account || !v.ok) {
        const f = await this.throttle.fail(c, keys);
        // 누가 시도했는지 단정할 수 없으므로 계정 ID 없이 묶어 남긴다. 입력한 이름은 남기지 않는다.
        await this.audit.writeOrGap(c, { action: 'auth.login_failed', result: 'failure' }, true);
        if (f.lockedNow && account) await this.noteLocked(c, account.id);
        return refusal(f.state) ?? { kind: 'failed' };
      }
      if (v.needsRehash) {
        await c.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [account.id, await hashPassword(password)]);
      }
      await this.throttle.succeed(c, keys);
      const session = await this.sessions.create(c, account.id);
      // 감사를 쓸 수 없어도 로그인은 진행하고 공백으로 남긴다(Q10-14 (3)).
      await this.audit.writeOrGap(c, { action: 'auth.login', result: 'success', accountId: account.id });
      return { kind: 'ok', session, accountName: account.name };
    });
  }

  /** 비밀번호 재확인(CM-07). 실패는 로그인과 같은 시도 제한에 센다(계약 4.3절). */
  async reauth(session: SessionInfo, password: string, address: string): Promise<ReauthResult> {
    const keys = this.throttle.keys(session.accountName, address);
    return this.db.tx(async (c): Promise<ReauthResult> => {
      const refused = refusal(await this.throttle.check(c, keys));
      if (refused) return refused;
      const r = await c.query<{ password_hash: string }>('SELECT password_hash FROM accounts WHERE id = $1 FOR SHARE', [
        session.accountId,
      ]);
      const v = await verifyPassword(password, r.rows[0]?.password_hash ?? this.dummyHash);
      if (!v.ok) {
        const f = await this.throttle.fail(c, keys);
        await this.audit.writeOrGap(c, { action: 'auth.reauth_failed', result: 'failure', accountId: session.accountId }, true);
        if (f.lockedNow) await this.noteLocked(c, session.accountId);
        return refusal(f.state) ?? { kind: 'wrong' };
      }
      await this.throttle.succeed(c, keys);
      // 검사 지점을 지난 뒤 다른 요청이 세션을 끝냈으면(전체 종료·비밀번호 변경) 재확인할 세션이 없다.
      const until = await this.sessions.markReauth(c, session.idHash);
      return until ? { kind: 'ok', until } : { kind: 'expired' };
    });
  }

  /**
   * 비밀번호 변경(Q10-03·06·14, 계약 4.3·4.5절). 본문의 현재 비밀번호 확인이 재확인을 겸한다.
   * 새 비밀번호 규칙은 현재 비밀번호를 맞혀 보기 전에 보고 시도 제한에 세지 않는다. 현재 비밀번호가 틀리면
   * 재확인 실패와 같은 시도 제한에 센다. 바꾸면 지금 세션을 포함한 모든 세션을 끝낸다. 감사를 남길 수 없으면
   * 바꾸지 않고 보류한다(Q10-14 (4), AuditUnavailableError → 409 held_audit_unavailable).
   */
  async changePassword(session: SessionInfo, current: string, next: string, address: string): Promise<ChangePasswordResult> {
    const problem = checkNewPassword(next, session.accountName);
    if (problem) return { kind: 'invalid', reason: problem };
    const keys = this.throttle.keys(session.accountName, address);
    return this.db.tx(async (c): Promise<ChangePasswordResult> => {
      const refused = refusal(await this.throttle.check(c, keys));
      if (refused) return refused;
      // FOR UPDATE: 같은 계정의 다른 변경과 로그인(FOR SHARE)이 이 변경이 끝날 때까지 기다린다.
      const r = await c.query<{ password_hash: string }>('SELECT password_hash FROM accounts WHERE id = $1 FOR UPDATE', [
        session.accountId,
      ]);
      const v = await verifyPassword(current, r.rows[0]?.password_hash ?? this.dummyHash);
      if (!r.rows[0] || !v.ok) {
        const f = await this.throttle.fail(c, keys);
        await this.audit.writeOrGap(
          c,
          { action: 'auth.password_change', result: 'failure', accountId: session.accountId, reasonCode: 'current_password_wrong' },
          true,
        );
        if (f.lockedNow) await this.noteLocked(c, session.accountId);
        return refusal(f.state) ?? { kind: 'wrong' };
      }
      const u = await c.query<{ changed_at: string }>(
        `UPDATE accounts SET password_hash = $2, password_changed_at = now(), version = version + 1 WHERE id = $1
         RETURNING ${utc('password_changed_at')} AS changed_at`,
        [session.accountId, await hashPassword(next)],
      );
      const terminated = await this.sessions.revokeAll(c, session.accountId, 'password_change');
      await this.throttle.succeed(c, keys);
      await this.audit.writeOrHold(c, { action: 'auth.password_change', result: 'success', accountId: session.accountId });
      return { kind: 'ok', changedAt: u.rows[0].changed_at, terminated };
    });
  }

  async logout(session: SessionInfo): Promise<void> {
    await this.db.tx(async (c) => {
      await this.sessions.revoke(c, session.idHash, 'logout');
      await this.audit.writeOrGap(c, { action: 'auth.logout', result: 'success', accountId: session.accountId });
    });
  }

  /**
   * 전체 세션 종료(Q10-06). 감사 장애 때도 차단 상태를 확정할 수 있으면 진행하는 긴급 예외라(Q10-14 (5))
   * 감사를 남기지 못했으면 공백을 남기고 audit_gap을 돌려준다.
   */
  async terminateAll(session: SessionInfo): Promise<{ terminated: number; auditGap: boolean }> {
    return this.db.tx(async (c) => {
      const terminated = await this.sessions.revokeAll(c, session.accountId, 'terminate_all');
      const audited = await this.audit.writeOrGap(c, {
        action: 'auth.sessions_terminate',
        result: 'success',
        accountId: session.accountId,
      });
      return { terminated, auditGap: !audited };
    });
  }

  /**
   * 연속 실패로 잠긴 순간을 감사와 자체 로그에 남긴다. 잠기면 아무도 웹으로 들어와 배너를 볼 수 없으므로
   * 서버 운영자가 자체 로그에서 알아차리게 한다. 계정 이름과 접속 주소는 남기지 않는다.
   */
  private async noteLocked(c: Queryable, accountId: number): Promise<void> {
    this.log.warn('login locked after consecutive failures; run `admin reset-password` on the server to unlock');
    await this.audit.writeOrGap(c, {
      action: 'auth.login_locked',
      result: 'success',
      actorType: 'system',
      accountId,
      reasonCode: 'consecutive_failures',
    });
  }
}
