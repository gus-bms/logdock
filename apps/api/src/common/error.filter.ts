import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';

import { AuditUnavailableError } from '../audit/audit.service.js';
import { ApiError, errors } from './api-error.js';
import type { ApiRequest, ApiResponse } from './http.js';

/** 모든 오류를 계약 4.5절 형식으로 바꾼다. 예상하지 못한 오류는 500 internal이고 내용은 자체 로그에만 남긴다. */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('ApiError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<ApiRequest>();
    const res = http.getResponse<ApiResponse>();
    const err = this.toApiError(exception, req);
    if (res.headersSent) {
      res.end();
      return;
    }
    for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
    res.statusCode = err.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        code: err.code,
        retryable: err.retryable,
        params: err.params,
        message: err.message,
        request_id: req.requestId ?? null,
      }),
    );
  }

  private toApiError(exception: unknown, req: ApiRequest): ApiError {
    if (exception instanceof ApiError) return exception;
    if (exception instanceof AuditUnavailableError) return errors.heldAuditUnavailable();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // 이 앱의 검사 오류는 모두 ApiError라, Nest가 내는 400·413은 JSON 본문 해석 단계에서만 나온다.
      if (status === 400) return errors.validation([{ path: '', reason: 'invalid_json' }]);
      if (status === 413) return errors.validation([{ path: '', reason: 'body_too_large' }]);
      if (status === 404) return errors.notFound();
      if (status === 405) return new ApiError(405, 'method_not_allowed', 'method not allowed');
    }
    // 경로 틀과 요청 참조만 남긴다. 본문·쿠키는 남기지 않는다(4.1절 자체 로그).
    this.log.error(`${req.method} request ${req.requestId ?? '-'} failed: ${(exception as Error)?.stack ?? exception}`);
    return errors.internal();
  }
}
