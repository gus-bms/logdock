import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { errors } from '../common/api-error.js';
import { type ApiRequest, type ApiResponse, appendSetCookie, header, readCookie } from '../common/http.js';
import { SessionService } from './session.service.js';
import { fromBase64Url, sameBytes } from './tokens.js';

const PUBLIC = 'logdock:public';
const OPTIONAL_SESSION = 'logdock:optional-session';

/** 세션 없이 부르는 경로(로그인, health). */
export const Public = () => SetMetadata(PUBLIC, true);
/** 세션이 있으면 읽고 없어도 통과하는 경로(GET /api/v1/auth/session). */
export const OptionalSession = () => SetMetadata(OPTIONAL_SESSION, true);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 모든 요청의 한 검사 지점(계약 4.1절 권한 검사). 세션을 확인하고, 상태를 바꾸는 요청은 CSRF 토큰
 * 헤더(X-CSRF-Token)를 세션의 토큰과 일정 시간 비교로 맞춘다. 세션이 끝났으면 쿠키를 지우고 401이다.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const flag = (key: string) => this.reflector.getAllAndOverride<boolean>(key, [ctx.getHandler(), ctx.getClass()]);
    if (flag(PUBLIC)) return true;
    const req = ctx.switchToHttp().getRequest<ApiRequest>();
    const res = ctx.switchToHttp().getResponse<ApiResponse>();
    const token = readCookie(req, this.sessions.cookieName());
    const background = header(req, 'x-logdock-background') === '1';
    const session = token ? await this.sessions.resolve(token, background) : null;
    if (!session) {
      if (token) appendSetCookie(res, this.sessions.clearCookie());
      if (flag(OPTIONAL_SESSION)) return true;
      throw errors.sessionExpired();
    }
    if (!SAFE_METHODS.has(req.method ?? 'GET')) {
      const sent = fromBase64Url(header(req, 'x-csrf-token'));
      if (!sent || !sameBytes(sent, session.csrfToken)) throw errors.csrfInvalid();
    }
    req.session = session;
    req.sessionToken = token;
    return true;
  }
}
