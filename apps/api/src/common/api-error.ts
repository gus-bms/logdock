// 오류 형식(계약 4.5절): {"code", "retryable", "params", "message", "request_id"}.
// code는 바뀌지 않는 식별자이고 화면 문구는 디자인 쪽이 code와 params로 만든다. message는 개발용이다.
// 키·비밀번호·로그 본문·검색어는 담지 않는다.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly params: Record<string, unknown> = {},
    readonly retryable = false,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const errors = {
  loginFailed: () => new ApiError(401, 'login_failed', 'login failed'),
  sessionExpired: () => new ApiError(401, 'session_expired', 'session expired or missing'),
  reauthRequired: () => new ApiError(403, 'reauth_required', 'recent password confirmation required'),
  csrfInvalid: () => new ApiError(403, 'csrf_invalid', 'missing or wrong CSRF token'),
  notFound: () => new ApiError(404, 'not_found', 'not found'),
  /** 연속 실패로 잠김. 서버 운영자의 로컬 재설정으로만 풀리므로 기다려도 풀리지 않는다(4.3절). */
  loginLocked: () =>
    new ApiError(423, 'login_locked', 'login locked after too many consecutive failures; a local password reset is required'),
  loginThrottled: (retryAfterSeconds: number) =>
    new ApiError(429, 'login_throttled', 'too many failed attempts', { retry_after_seconds: retryAfterSeconds }, true, {
      'Retry-After': String(retryAfterSeconds),
    }),
  /** 다른 사람이 먼저 고쳤다. 지금 값을 주고 화면이 가진 값과 비교해 바뀐 항목을 보인다(4.1절 동시 수정). */
  versionConflict: (current: Record<string, unknown>) =>
    new ApiError(409, 'version_conflict', 'changed by someone else', { current }),
  nameTaken: (path: string) => new ApiError(409, 'name_taken', 'name already in use', { path }),
  /** 보관된 대상에는 할 수 없는 동작이다(5.3절 WQ-54). */
  targetArchived: () => new ApiError(409, 'target_archived', 'target is archived'),
  /** 감사 기록을 남길 수 없어 바꾸지 않았다. 감사가 복구된 뒤 사용자가 다시 실행한다(Q10-14 (4)). */
  heldAuditUnavailable: () =>
    new ApiError(409, 'held_audit_unavailable', 'audit storage unavailable; the change was not applied', {}, true),
  validation: (fields: { path: string; reason: string }[]) =>
    new ApiError(422, 'validation_failed', 'invalid input', { fields }),
  internal: () => new ApiError(500, 'internal', 'internal error', {}, true),
};
