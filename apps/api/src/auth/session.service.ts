import { Inject, Injectable } from '@nestjs/common';

import { type AppConfig } from '../config.js';
import { Database, type Queryable, utc } from '../db/database.js';
import { APP_CONFIG } from '../tokens.js';
import { fromBase64Url, newToken, sha256, toBase64Url } from './tokens.js';

/** 검사 지점을 지난 세션. 시각은 UTC RFC 3339 문자열이다. */
export interface SessionInfo {
  idHash: Buffer;
  accountId: number;
  accountName: string;
  csrfToken: Buffer;
  expiresAt: string;
  idleExpiresAt: string;
  /** 최근 재확인이 유효한 끝 시각. 없거나 지났으면 null. */
  reauthValidUntil: string | null;
}

export interface NewSession {
  token: string;
  csrfToken: string;
  expiresAt: string;
}

/**
 * 웹 세션(Q10-05·06, 계약 4.1절). 세션 ID는 무작위 32바이트이고 쿠키에는 base64url, DB에는 SHA-256만 둔다.
 * 유효 판단은 DB 시각으로 한다. 세션 시각을 DB가 now()로 쓰므로 앱 시계와 섞지 않기 위해서다.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Database,
  ) {}

  cookieName(): string {
    // __Host- 접두사는 Secure·Path=/·Domain 없음일 때만 브라우저가 받는다.
    return this.config.cookieSecure ? '__Host-logdock_session' : 'logdock_session';
  }

  cookie(token: string, maxAgeSeconds: number): string {
    const secure = this.config.cookieSecure ? '; Secure' : '';
    return `${this.cookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${maxAgeSeconds}`;
  }

  clearCookie(): string {
    return this.cookie('', 0);
  }

  async create(c: Queryable, accountId: number): Promise<NewSession> {
    const id = newToken();
    const csrf = newToken();
    const r = await c.query<{ expires_at: string }>(
      `INSERT INTO sessions (id_hash, account_id, csrf_token) VALUES ($1, $2, $3)
       RETURNING ${utc(`created_at + make_interval(secs => $4)`)} AS expires_at`,
      [sha256('session', id), accountId, csrf, this.config.sessionAbsoluteSeconds],
    );
    return { token: toBase64Url(id), csrfToken: toBase64Url(csrf), expiresAt: r.rows[0].expires_at };
  }

  /**
   * 쿠키의 세션을 찾는다. 폐기됐거나 비활동·최대 수명을 넘었으면 null이다.
   * background가 아니면 활동 시각을 고친다. 화면이 스스로 보내는 요청은 세션을 늘리지 않는다(PT-19).
   */
  async resolve(token: string | undefined, background: boolean): Promise<SessionInfo | null> {
    const raw = fromBase64Url(token);
    if (!raw) return null;
    const idHash = sha256('session', raw);
    const cfg = this.config;
    const r = await this.db.query<{
      account_id: number;
      name: string;
      csrf_token: Buffer;
      expires_at: string;
      idle_expires_at: string;
      reauth_valid_until: string | null;
      touch: boolean;
    }>(
      `SELECT s.account_id, a.name, s.csrf_token,
              ${utc(`s.created_at + make_interval(secs => $2)`)} AS expires_at,
              ${utc(`least(s.last_active_at + make_interval(secs => $3), s.created_at + make_interval(secs => $2))`)} AS idle_expires_at,
              CASE WHEN s.reauth_at > now() - make_interval(secs => $4)
                   THEN ${utc(`s.reauth_at + make_interval(secs => $4)`)} END AS reauth_valid_until,
              s.last_active_at <= now() - make_interval(secs => $5) AS touch
         FROM sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.id_hash = $1 AND s.revoked_at IS NULL
          AND s.last_active_at > now() - make_interval(secs => $3)
          AND s.created_at > now() - make_interval(secs => $2)`,
      [idHash, cfg.sessionAbsoluteSeconds, cfg.sessionIdleSeconds, cfg.reauthSeconds, cfg.sessionTouchSeconds],
    );
    const row = r.rows[0];
    if (!row) return null;
    let idleExpiresAt = row.idle_expires_at;
    if (!background && row.touch) {
      const t = await this.db.query<{ idle_expires_at: string }>(
        `UPDATE sessions SET last_active_at = now() WHERE id_hash = $1 AND revoked_at IS NULL
         RETURNING ${utc(`least(last_active_at + make_interval(secs => $2), created_at + make_interval(secs => $3))`)} AS idle_expires_at`,
        [idHash, cfg.sessionIdleSeconds, cfg.sessionAbsoluteSeconds],
      );
      idleExpiresAt = t.rows[0]?.idle_expires_at ?? idleExpiresAt;
    }
    return {
      idHash,
      accountId: row.account_id,
      accountName: row.name,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
      idleExpiresAt,
      reauthValidUntil: row.reauth_valid_until,
    };
  }

  async revoke(c: Queryable, idHash: Buffer, reason: 'logout'): Promise<void> {
    await c.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE id_hash = $1 AND revoked_at IS NULL`,
      [idHash, reason],
    );
  }

  /** 계정의 모든 웹 세션을 끝낸다. 지금 세션도 포함한다(Q10-06). 끝낸 수를 돌려준다. */
  async revokeAll(
    c: Queryable,
    accountId: number,
    reason: 'terminate_all' | 'password_change' | 'password_reset_local',
  ): Promise<number> {
    const r = await c.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE account_id = $1 AND revoked_at IS NULL`,
      [accountId, reason],
    );
    return r.rowCount ?? 0;
  }

  /** 재확인 시각을 고친다. 그 사이 세션이 끝났으면 null이다. */
  async markReauth(c: Queryable, idHash: Buffer): Promise<string | null> {
    const r = await c.query<{ until: string }>(
      `UPDATE sessions SET reauth_at = now() WHERE id_hash = $1 AND revoked_at IS NULL
       RETURNING ${utc(`reauth_at + make_interval(secs => $2)`)} AS until`,
      [idHash, this.config.reauthSeconds],
    );
    return r.rows[0]?.until ?? null;
  }
}
