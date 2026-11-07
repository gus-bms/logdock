import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { z } from 'zod';

import { errors } from '../common/api-error.js';
import { type ApiRequest, type ApiResponse, appendSetCookie, clientAddress } from '../common/http.js';
import { parse } from '../common/validate.js';
import { AuthService } from './auth.service.js';
import { MAX_PASSWORD_LENGTH } from './password.js';
import { SessionService } from './session.service.js';

const PasswordBody = z.object({
  current_password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  // 길이와 흔한 값은 비밀번호 규칙이 보고 사유(password_too_short 등)를 준다.
  new_password: z.string(),
});

@Controller('v1/account')
export class AccountController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * 비밀번호 변경(4.3·4.5절). 본문의 현재 비밀번호가 재확인을 겸해 reauth_required를 돌려주지 않는다.
   * 바꾸면 지금 세션을 포함한 모든 세션이 끝나므로 쿠키를 지운다(Q10-06).
   */
  @Post('password')
  @HttpCode(200)
  async changePassword(@Body() body: unknown, @Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const input = parse(PasswordBody, body);
    const r = await this.auth.changePassword(req.session!, input.current_password, input.new_password, clientAddress(req));
    switch (r.kind) {
      case 'locked':
        throw errors.loginLocked();
      case 'throttled':
        throw errors.loginThrottled(r.wait);
      case 'wrong':
        throw errors.validation([{ path: 'current_password', reason: 'current_password_wrong' }]);
      case 'invalid':
        throw errors.validation([{ path: 'new_password', reason: r.reason }]);
    }
    appendSetCookie(res, this.sessions.clearCookie());
    res.setHeader('Cache-Control', 'no-store');
    return { password_changed_at: r.changedAt, terminated: r.terminated };
  }

  /** 전체 세션 종료. 지금 세션도 끝나므로 쿠키를 지운다(Q10-06). */
  @Post('sessions/terminate-all')
  @HttpCode(200)
  async terminateAll(@Req() req: ApiRequest, @Res({ passthrough: true }) res: ApiResponse) {
    const r = await this.auth.terminateAll(req.session!);
    appendSetCookie(res, this.sessions.clearCookie());
    return { terminated: r.terminated, audit_gap: r.auditGap };
  }
}
