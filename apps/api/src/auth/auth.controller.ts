import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { z } from 'zod';

import { errors } from '../common/api-error.js';
import { type ApiRequest, type ApiResponse, appendSetCookie, clientAddress } from '../common/http.js';
import { parse } from '../common/validate.js';
import { type AppConfig } from '../config.js';
import { APP_CONFIG } from '../tokens.js';
import { OptionalSession, Public } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { MAX_PASSWORD_LENGTH } from './password.js';
import { SessionService } from './session.service.js';
import { toBase64Url } from './tokens.js';

const LoginBody = z.object({
  name: z.string().min(1).max(200),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  return_to: z.string().max(2048).nullish(),
});

const ReauthBody = z.object({
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

/** 로그인 뒤 돌아갈 곳은 이 웹의 내부 경로만 받는다. 다른 호스트나 //로 시작하는 값은 버린다(4.3절). */
export function safeReturnTo(v: string | null | undefined): string | null {
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f]/.test(v)) return null;
  return v;
}

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 실패는 계정이 있는지와 무엇이 틀렸는지 드러내지 않는 401 login_failed 하나다(4.3절). */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const input = parse(LoginBody, body);
    const r = await this.auth.login(input.name, input.password, clientAddress(req));
    if (r.kind === 'locked') throw errors.loginLocked();
    if (r.kind === 'throttled') throw errors.loginThrottled(r.wait);
    if (r.kind === 'failed') throw errors.loginFailed();
    appendSetCookie(res, this.sessions.cookie(r.session.token, this.config.sessionAbsoluteSeconds));
    res.setHeader('Cache-Control', 'no-store');
    return {
      csrf_token: r.session.csrfToken,
      return_to: safeReturnTo(input.return_to),
      account: { name: r.accountName },
      expires_at: r.session.expiresAt,
    };
  }

  /** 세션 상태와 CSRF 토큰. 세션이 없어도 200으로 authenticated: false를 돌려준다. */
  @OptionalSession()
  @Get('session')
  session(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    res.setHeader('Cache-Control', 'no-store');
    const s = req.session;
    if (!s) return { authenticated: false };
    return {
      authenticated: true,
      account: { name: s.accountName },
      csrf_token: toBase64Url(s.csrfToken),
      expires_at: s.expiresAt,
      idle_expires_at: s.idleExpiresAt,
      reauth_valid_until: s.reauthValidUntil,
      idle_timeout_seconds: this.config.sessionIdleSeconds,
    };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse): Promise<void> {
    await this.auth.logout(req.session!);
    appendSetCookie(res, this.sessions.clearCookie());
  }

  /** 틀리면 422 validation_failed(current_password_wrong)로 CM-07 창을 유지하게 한다(4.3절). */
  @Post('reauth')
  @HttpCode(200)
  async reauth(@Body() body: unknown, @Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const input = parse(ReauthBody, body);
    const r = await this.auth.reauth(req.session!, input.password, clientAddress(req));
    if (r.kind === 'locked') throw errors.loginLocked();
    if (r.kind === 'throttled') throw errors.loginThrottled(r.wait);
    if (r.kind === 'wrong') throw errors.validation([{ path: 'password', reason: 'current_password_wrong' }]);
    if (r.kind === 'expired') {
      appendSetCookie(res, this.sessions.clearCookie());
      throw errors.sessionExpired();
    }
    return { reauth_valid_until: r.until };
  }
}
