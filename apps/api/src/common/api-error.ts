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
  /** 지금 상태에서 할 수 없는 동작이다. 지금 상태를 준다(5.1절 상태별 동작). */
  invalidState: (current: Record<string, unknown>) =>
    new ApiError(409, 'invalid_state', 'not allowed in the current state', { current }),
  /** 개수 상한에 닿아 더 만들지 않았다. 화면이 상한을 보이도록 상한 값을 준다(4.4절, Q11-03, WQ-33). */
  limitReached: (limit: number) => new ApiError(409, 'limit_reached', 'the count limit has been reached', { limit }),
  /** 요청이 너무 잦다. 메일은 설치 전체 발송 속도 상한(TD-19)에 걸린 경우다. */
  rateLimited: (retryAfterSeconds: number) =>
    new ApiError(429, 'rate_limited', 'too many requests', { retry_after_seconds: retryAfterSeconds }, true, {
      'Retry-After': String(retryAfterSeconds),
    }),
  /** 메일 서버 설정이 없어 알림 규칙을 켤 수 없다(TD-08). 끈 채로 만들거나 고치는 것은 된다. */
  mailNotConfigured: () => new ApiError(409, 'mail_not_configured', 'mail server is not configured; alert rules cannot be enabled'),
  /** 유효 키가 이미 둘이다(Q10-07, WQ-65). */
  keyLimitReached: () => new ApiError(409, 'key_limit_reached', 'the connection already has two valid keys'),
  /** 감사 기록을 남길 수 없어 바꾸지 않았다. 감사가 복구된 뒤 사용자가 다시 실행한다(Q10-14 (4)). */
  heldAuditUnavailable: () =>
    new ApiError(409, 'held_audit_unavailable', 'audit storage unavailable; the change was not applied', {}, true),
  /** 칸 경로와 이유. 정규식 오류면 오류가 난 부분(`expr`)을 함께 줘 화면이 위치를 표시한다. */
  validation: (fields: { path: string; reason: string; expr?: string }[]) =>
    new ApiError(422, 'validation_failed', 'invalid input', { fields }),
  /** 같은 Idempotency-Key로 내용이 다른 요청이 왔다. 화면의 키 생성 오류다(4.1절 중복 요청 방지). */
  idempotencyKeyReused: () =>
    new ApiError(409, 'idempotency_key_reused', 'the same Idempotency-Key was used for a different request'),
  /** 같은 서버의 같은 대상이 이미 보관되지 않은 연결로 등록돼 있다(Q07-06). 그 연결의 외부 ID를 준다. */
  duplicateConnection: (connectionId: string) =>
    new ApiError(409, 'duplicate_connection', 'the same server already collects this target', { connection_id: connectionId }),
  /** 검색 조건 오류. 조건 경로와 이유를 준다(CM-03 상태 5). */
  conditionInvalid: (fields: { path: string; reason: string }[]) =>
    new ApiError(422, 'condition_invalid', 'invalid search condition', { fields }),
  /** 검색 실행 기준이 만료됐거나 없다. 화면은 다시 검색을 안내한다(CM-04 `만료·접근 제한`). */
  runExpired: () => new ApiError(410, 'run_expired', 'search run expired or unknown'),
  /** 동시 검색 수 상한(4.2절 동시 실행). */
  searchBusy: (retryAfterSeconds: number) =>
    new ApiError(429, 'search_busy', 'too many searches running', { retry_after_seconds: retryAfterSeconds }, true, {
      'Retry-After': String(retryAfterSeconds),
    }),
  /** 로그 저장소를 쓸 수 없다. 엔진 내부 문장은 담지 않는다. */
  storageUnavailable: () => new ApiError(503, 'storage_unavailable', 'log storage unavailable', {}, true),
  /** 실행 예산 안에 끝낸 구간이 없다. 끝낸 구간이 있으면 부분 결과(200)로 돌려준다. */
  searchTimeout: () => new ApiError(504, 'search_timeout', 'search timed out before any range completed', { completed_range: null }, true),
  /** 이벤트를 가져올 수 없다. 가능한 사유를 준다(UI-03 상태 7). */
  eventUnavailable: (reasons: string[]) => new ApiError(410, 'event_unavailable', 'event is not available', { reasons }),
  /** 감사 이력을 읽을 수 없다. 화면은 목록 자리에 장애를 보인다(UI-15, WQ-90). */
  auditUnavailable: () => new ApiError(503, 'audit_unavailable', 'audit history cannot be read', {}, true),
  internal: () => new ApiError(500, 'internal', 'internal error', {}, true),
};
