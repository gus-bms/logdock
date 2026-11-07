// 조회·관리 API 설정. 한도와 시간 값은 측정·Q15 협의 전의 시제품 값이며 코드에 박지 않고 여기서만 정한다.
import { readFileSync } from 'node:fs';

import type { ClickHouseConfig } from './clickhouse/clickhouse.js';

export interface DatabaseConfig {
  /** 호스트 이름 또는 유닉스 소켓 폴더(/로 시작). */
  host: string;
  port: number;
  user: string;
  database: string;
  password?: string;
  /** 연결 풀 크기. */
  max: number;
}

/**
 * 메일 서버(TD-08, Q12-08·15). 표준 SMTP 제출 하나만 지원하고 TLS가 기본이다. 평문 사내 릴레이는 서버 설정에서 명시적으로
 * 고를 때만 쓰고 화면에 경고한다. 비밀번호는 화면과 API 응답에 돌려주지 않는다(TD-20).
 */
export interface MailConfig {
  host: string;
  port: number;
  /** `tls`는 처음부터 TLS(465), `starttls`는 587 STARTTLS, `plain_relay`는 평문 사내 릴레이다. */
  security: 'tls' | 'starttls' | 'plain_relay';
  from: string;
  user: string | null;
  password: string | null;
  /** 사내 메일 서버가 사설 CA를 쓰면 그 CA(PEM). 시스템 신뢰 목록에 더한다. 인증서 검증은 끄지 않는다(TD-08). */
  ca: string | null;
  /**
   * 수신처 고정(2026-11-07 사용자 합의). 값이 있으면 알림·운영·테스트 메일을 규칙과 운영 수신 주소 대신 이 주소로만 보낸다.
   * 실제 주소는 서버 설정에만 두고 저장소에 넣지 않는다.
   */
  redirectTo: string | null;
}

export interface AppConfig {
  db: DatabaseConfig;
  /** 메일 서버. 없으면 API는 시작하되 알림 규칙을 켤 수 없다(`mail_not_configured`, 계약 8.1절 TD-08). */
  mail: MailConfig | null;
  /**
   * 에이전트가 묶음을 보낼 수신 서버 주소(계약 8.1절 주소, 2.8절 설정 파일의 ingest_url). HTTPS만 받는다(Q10-02).
   * 연결 설정 파일을 만들 때 쓰며, API 서버는 이 값이 없으면 시작하지 않는다(main.ts). 로컬 명령은 쓰지 않는다.
   */
  ingestUrl: string | null;
  /** 세션 쿠키에 Secure를 단다. HTTPS 뒤에서 돈다. 끄는 것은 개발용이다. */
  cookieSecure: boolean;
  /** 세션 비활동 한도(Q10-06, 1시간). */
  sessionIdleSeconds: number;
  /** 로그인 뒤 세션 최대 수명(Q10-06, 24시간). */
  sessionAbsoluteSeconds: number;
  /** 활동 시각을 이보다 자주 고쳐 쓰지 않는다. 비활동 한도가 이만큼 짧아질 수 있다. */
  sessionTouchSeconds: number;
  /** 비밀번호 재확인 유효 시간(Q10-05의 N분, 미정). */
  reauthSeconds: number;
  /** 로그인 시도 제한(Q10-03 수치 미정). 같은 계정·같은 접속 주소와, 주소와 무관한 같은 계정을 따로 센다. */
  throttle: {
    windowSeconds: number;
    blockSeconds: number;
    perSourceFailures: number;
    perAccountFailures: number;
    /**
     * 같은 계정 이름의 연속 실패가 이 수에 닿으면 로그인을 잠근다. 서버 운영자의 로컬 재설정으로만 풀린다
     * (2026-11-07 사용자 합의, NIST SP 800-63B-4의 100회 이하).
     */
    lockAfterConsecutiveFailures: number;
  };
  /** 같은 실패 감사를 한 행으로 묶는 시간(5.6절의 N분). */
  auditAggregateSeconds: number;
  /** 이름(서비스·서버 표시명·계정) 길이 상한. 5.3절 이름 규칙의 `N`이 정해지기 전의 시제품 값이다. */
  nameMaxLength: number;
  /**
   * 수집 연결의 이벤트 크기 상한(D03의 `N`, 미정). 등록 때 값을 주지 않으면 기본값을 쓰고, 에이전트가 받는 최대값을
   * 넘지 않게 한다. 둘 다 측정·Q15 전의 시제품 값이다.
   */
  maxEventBytes: { default: number; max: number };
  /**
   * 수집 연결 관측 표시(계약 2.7·4.4절의 `N`, 미정). 마지막 상태 보고가 staleSeconds보다 오래되면 `관측 오래됨/미확인`,
   * `등록·연결 대기`가 pendingSeconds보다 오래 이어지면 `조치 필요`에 센다. 측정·Q15 전의 시제품 값이다.
   */
  observation: { staleSeconds: number; pendingSeconds: number };
  /**
   * 검색 조건 한도(조건 수·검색식 길이, Q15의 `N`, 미정). 저장 검색·알림 규칙·검색이 같이 쓴다. 시제품 값이다.
   * maxConditions는 본문·필드 조건의 합이고, maxSourceValues는 출처 목록마다의 값 수다.
   */
  search: { maxConditions: number; maxTextLength: number; maxSourceValues: number; maxFieldPathLength: number };
  /** 저장 검색 개수 상한(WQ-33과 같은 `N`, 미정). 시제품 값이다. */
  savedSearchLimit: number;
  /** 알림 규칙 개수 상한(WQ-33의 `N`, 평가 비용 측정 전 미정). 꺼진 규칙도 센다. 시제품 값이다. */
  alertRuleLimit: number;
  /** 규칙마다 수신 주소 상한(Q12-12 합의 10개). 운영 수신 주소도 같은 상한이다(UI-14). */
  alertRecipientLimit: number;
  /** 설치 전체 메일 발송 속도 상한(분당, TD-19의 `N`, 미정). 테스트 메일·알림 메일·운영 메일을 함께 센다. 시제품 값이다. */
  mailRatePerMinute: number;
  /** 메일 서버와 주고받을 때 한 단계의 대기 상한(초). 본문을 보낸 뒤에는 두 배를 기다린다. 시제품 값이다. */
  mailTimeoutSeconds: number;
  /** 메일 링크의 기준 주소(계약 8.1절 링크, TD-16). 요청의 Host 헤더로 링크를 만들지 않는다. 없으면 메일에 링크를 넣지 않는다. */
  publicBaseUrl: string | null;
  /** 발송 작업이 보낼 메일을 찾는 주기(초). 시제품 값이다. */
  mailPollSeconds: number;
  /** 운영 메일 확인 주기(초)와, 일이 이만큼 이어져야 운영 메일에 싣는 유예(초, Q12-06의 10분). */
  opsCheckSeconds: number;
  opsGraceSeconds: number;
  /** 사건이 열린 뒤 이보다 늦게 나가는 알림 메일은 제목 앞에 `[지연 N분]`을 붙인다(Q12-11). 시제품 값이다. */
  mailDelayNoticeSeconds: number;
  /** 메일 재시도(Q12-09 설계값): 시도 사이 간격(분), 최대 시도 수, 첫 시도부터의 최대 시간. 간격에는 ±10% 흔들림을 준다. */
  mailRetry: { intervalsMinutes: number[]; maxAttempts: number; maxHours: number };
  /**
   * 기록 정리(계약 3.4절 보관 기간). 끝난 세션·로그인 시도·중복 요청 키는 몇 시간 뒤, 감사는 90일 목표(저장 상한 우선, Q10-13),
   * 알림 이력은 로그 보관 기간과 같이 둔다(Q12-14). `N`으로 남은 값은 시제품 값이다. 연속 실패 수가 있는 로그인 시도 행은
   * 창이 지나도 이어 세야 해서(4.3절) 마지막 시도 뒤 `throttleCountKeepDays` 동안 남기고, 잠긴 행은 로컬 재설정 전까지 남긴다.
   */
  cleanup: {
    intervalSeconds: number;
    sessionKeepHours: number;
    throttleKeepHours: number;
    throttleCountKeepDays: number;
    idempotencyKeepHours: number;
    auditRetentionDays: number;
    auditMaxRows: number;
    evalRoundKeepDays: number;
    statusHistoryKeepDays: number;
    noticeKeepDays: number;
    batchRows: number;
  };
  /** 표시 시간대(IANA 이름, SD-07). 코어에 특정 시간대를 고정하지 않고 서버 설정으로 받는다. 없으면 이 서버의 시간대를 쓴다. */
  displayTimezone: string;
  /** 로그 보관 기간(달, Q13 합의값 6개월). 서버 설정으로만 바꾼다(Q13-02). */
  logRetentionMonths: number;
  /** 켜진 규칙의 마지막 성공 평가가 이보다 오래되면 `alert_eval_stopped` 배너를 올린다(4.4절의 `N`, 미정). 시제품 값이다. */
  alertEvalStaleSeconds: number;
  /** 요청 본문 상한. */
  bodyLimit: string;
  /** ClickHouse 로그 저장소(3.2절, 8.1절). 조회용 계정은 설정 프로필에서 쿼리 기록을 끈다(SD-35). */
  clickhouse: ClickHouseConfig;
  /** 검색 실행(4.2절, SD-29·SD-31). M5·Q15 전의 시제품 값이다. */
  searchRun: {
    /** 실행 기준을 서버에 두는 시간. 지나면 `410 run_expired`다. */
    keepMinutes: number;
    /** 설치 전체·세션마다 동시에 도는 검색 요청 수. 넘으면 `429 search_busy`다. */
    maxConcurrent: number;
    maxPerSession: number;
    /** 요청 하나의 실행 예산. 넘으면 끝낸 구간까지만 돌려준다. */
    budgetMs: number;
    /** 최신 구간부터 나눠 실행할 때 첫 조각의 길이. 다음 조각은 두 배씩 늘린다. */
    firstSliceMinutes: number;
    pageSizeDefault: number;
    pageSizeMax: number;
    /** 목록 본문 요약 글자 수(SD-34). */
    bodySummaryChars: number;
    /** 시간별 발생량의 목표 구간 수. 간격은 이 수를 넘지 않는 가장 작은 단위로 고른다. */
    histogramBuckets: number;
    /** 서버에 둘 실행 기준 수. 넘으면 오래된 것부터 버린다. */
    maxRuns: number;
    /** 질의마다 거는 스레드·메모리 상한. null이면 ClickHouse 계정 설정 프로필을 따른다. */
    maxThreads: number | null;
    maxMemoryBytes: number | null;
    /** 검색 가능 시각이 이보다 오래 갱신되지 않으면 수집 문제 요약에 `검색 가능 미확인`을 올린다. */
    watermarkStaleSeconds: number;
    /** 주변 로그 방향마다 처음·더 불러오는 건수와 상한, 기준 시각 앞뒤 최대 시간 폭(WQ-27). */
    nearbyPageDefault: number;
    nearbyPageMax: number;
    nearbyWindowMinutes: number;
    /** 필드 이름 후보는 최근 이 시간 수신분의 경로에서 많이 나온 순서로 이 개수까지 준다(SD-25). */
    suggestHours: number;
    suggestLimit: number;
  };
  /** 알림 평가(5.4절, Q12-02, TD-12·TD-19). 검색과 따로 둔 예산으로 돈다. 시제품 값이다. */
  alertEval: {
    /** 새 평가 창이 생겼는지 보는 주기. */
    pollSeconds: number;
    /** 평가 회차 간격(설치 공통 1분, Q12-02). 창 끝은 수신 시각을 이 간격으로 내린 값이다. */
    intervalSeconds: number;
    /** 한 회차(모든 규칙)의 실행 예산. 넘으면 남은 규칙은 미평가로 남는다. */
    budgetMs: number;
    maxThreads: number | null;
    maxMemoryBytes: number | null;
  };
}

export const DEFAULTS: Omit<AppConfig, 'db'> = {
  ingestUrl: null,
  mail: null,
  cookieSecure: true,
  sessionIdleSeconds: 60 * 60,
  sessionAbsoluteSeconds: 24 * 60 * 60,
  sessionTouchSeconds: 60,
  reauthSeconds: 15 * 60,
  throttle: {
    windowSeconds: 15 * 60,
    blockSeconds: 15 * 60,
    perSourceFailures: 5,
    perAccountFailures: 50,
    lockAfterConsecutiveFailures: 100,
  },
  auditAggregateSeconds: 5 * 60,
  nameMaxLength: 100,
  // 에이전트 설정 검사가 받는 범위는 1바이트~64MiB다(agent/internal/config).
  maxEventBytes: { default: 1024 * 1024, max: 64 * 1024 * 1024 },
  observation: { staleSeconds: 3 * 60, pendingSeconds: 24 * 60 * 60 },
  search: { maxConditions: 20, maxTextLength: 1000, maxSourceValues: 100, maxFieldPathLength: 256 },
  savedSearchLimit: 100,
  alertRuleLimit: 50,
  alertRecipientLimit: 10,
  mailRatePerMinute: 30,
  mailTimeoutSeconds: 30,
  publicBaseUrl: null,
  mailPollSeconds: 5,
  opsCheckSeconds: 60,
  opsGraceSeconds: 10 * 60,
  mailDelayNoticeSeconds: 2 * 60,
  mailRetry: { intervalsMinutes: [1, 2, 5, 10, 20, 30, 30, 30, 30, 30, 30], maxAttempts: 12, maxHours: 4 },
  cleanup: {
    intervalSeconds: 60 * 60,
    sessionKeepHours: 24,
    throttleKeepHours: 24,
    throttleCountKeepDays: 90,
    idempotencyKeepHours: 24,
    auditRetentionDays: 90,
    auditMaxRows: 2_000_000,
    evalRoundKeepDays: 7,
    statusHistoryKeepDays: 30,
    noticeKeepDays: 30,
    batchRows: 5000,
  },
  displayTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  logRetentionMonths: 6,
  alertEvalStaleSeconds: 10 * 60,
  bodyLimit: '1mb',
  clickhouse: { url: 'http://127.0.0.1:8123', database: 'logdock', table: 'logs', user: 'logdock_api', password: null },
  searchRun: {
    keepMinutes: 30,
    maxConcurrent: 8,
    maxPerSession: 4,
    budgetMs: 10_000,
    firstSliceMinutes: 60,
    pageSizeDefault: 100,
    pageSizeMax: 500,
    bodySummaryChars: 300,
    histogramBuckets: 200,
    maxRuns: 500,
    maxThreads: null,
    maxMemoryBytes: null,
    watermarkStaleSeconds: 120,
    nearbyPageDefault: 50,
    nearbyPageMax: 200,
    nearbyWindowMinutes: 60,
    suggestHours: 24,
    suggestLimit: 50,
  },
  alertEval: { pollSeconds: 5, intervalSeconds: 60, budgetMs: 45_000, maxThreads: null, maxMemoryBytes: null },
};

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

/** 수신 서버 주소를 검사한다. HTTPS이고 호스트가 있어야 한다(에이전트 설정 검사와 같은 조건). */
export function checkIngestUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('LOGDOCK_INGEST_URL must be an https URL');
  }
  if (u.protocol !== 'https:' || u.hostname === '' || u.username || u.password || u.search || u.hash) {
    throw new Error('LOGDOCK_INGEST_URL must be an https URL without user info, query or fragment');
  }
  return raw;
}

/** IANA 시간대 이름인지 본다. Node의 시간대 자료로 판단하고, 틀리면 시작하지 않는다. */
export function checkTimezone(name: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
  } catch {
    throw new Error('LOGDOCK_DISPLAY_TIMEZONE must be an IANA time zone name');
  }
  return name;
}

/** 메일 주소 꼴. 관리 DB의 mail_address 도메인과 같다(앞뒤에 @ 없는 한 덩어리씩, 공백·제어 문자 불가). */
export const MAIL_ADDRESS = /^[^@\s\p{Cc}]+@[^@\s\p{Cc}]+$/u;

/**
 * 비밀 값은 설정에 직접 쓰지 않고 중앙 서비스 계정만 읽는 파일의 경로로 받는다(계약 8.1절, TD-20). 끝의 줄바꿈 하나만 뗀다.
 * 읽을 수 없으면 시작하지 않는다.
 */
function readSecretFile(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r?\n$/, '');
}

function checkRedirect(raw: string | undefined): string | null {
  if (!raw) return null;
  if (!MAIL_ADDRESS.test(raw)) throw new Error('LOGDOCK_MAIL_REDIRECT_TO must be a mail address');
  return raw;
}

/** 메일 링크의 기준 주소. HTTPS이고 경로·쿼리·조각이 없어야 한다. 끝의 `/`는 뗀다. */
export function checkPublicBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('LOGDOCK_PUBLIC_BASE_URL must be an https URL');
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new Error('LOGDOCK_PUBLIC_BASE_URL must be an https origin without path, query or fragment');
  }
  return u.origin;
}

/**
 * 메일 서버 설정을 읽는다. 호스트가 없으면 메일 설정 없음(null)이다. 있으면 발신 주소가 꼴에 맞아야 한다. 비밀번호는
 * `LOGDOCK_MAIL_PASSWORD_FILE`의 파일에서 읽는다.
 */
export function loadMailConfig(env: NodeJS.ProcessEnv): MailConfig | null {
  const host = env.LOGDOCK_MAIL_HOST;
  if (!host) return null;
  const security = env.LOGDOCK_MAIL_SECURITY || 'tls';
  if (security !== 'tls' && security !== 'starttls' && security !== 'plain_relay') {
    throw new Error('LOGDOCK_MAIL_SECURITY must be tls, starttls or plain_relay');
  }
  const from = env.LOGDOCK_MAIL_FROM ?? '';
  if (!MAIL_ADDRESS.test(from)) throw new Error('LOGDOCK_MAIL_FROM must be a mail address');
  return {
    host,
    port: intEnv(env, 'LOGDOCK_MAIL_PORT', security === 'starttls' ? 587 : 465),
    security,
    from,
    user: env.LOGDOCK_MAIL_USER || null,
    password: env.LOGDOCK_MAIL_PASSWORD_FILE ? readSecretFile(env.LOGDOCK_MAIL_PASSWORD_FILE) : null,
    ca: env.LOGDOCK_MAIL_CA_FILE ? readFileSync(env.LOGDOCK_MAIL_CA_FILE, 'utf8') : null,
    redirectTo: checkRedirect(env.LOGDOCK_MAIL_REDIRECT_TO),
  };
}

/** ClickHouse 접속 설정. 주소는 http(s)이고 사용자 정보·쿼리가 없어야 한다. 비밀번호는 파일 경로로 받는다(8.1절). */
export function loadClickHouseConfig(env: NodeJS.ProcessEnv): ClickHouseConfig {
  const url = env.LOGDOCK_CLICKHOUSE_URL || DEFAULTS.clickhouse.url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('LOGDOCK_CLICKHOUSE_URL must be an http(s) URL');
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new Error('LOGDOCK_CLICKHOUSE_URL must be an http(s) URL without user info, query or fragment');
  }
  return {
    url,
    database: env.LOGDOCK_CLICKHOUSE_DATABASE || DEFAULTS.clickhouse.database,
    table: DEFAULTS.clickhouse.table,
    user: env.LOGDOCK_CLICKHOUSE_USER || DEFAULTS.clickhouse.user,
    password: env.LOGDOCK_CLICKHOUSE_PASSWORD_FILE ? readSecretFile(env.LOGDOCK_CLICKHOUSE_PASSWORD_FILE) : null,
  };
}

function optionalIntEnv(env: NodeJS.ProcessEnv, name: string): number | null {
  return env[name] ? intEnv(env, name, 0) : null;
}

/** 환경 변수에서 설정을 읽는다. 비밀번호는 PGPASSFILE 같은 파일로 두는 편이 낫지만 개발용으로 받는다. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    ...DEFAULTS,
    ingestUrl: env.LOGDOCK_INGEST_URL ? checkIngestUrl(env.LOGDOCK_INGEST_URL) : null,
    mail: loadMailConfig(env),
    publicBaseUrl: env.LOGDOCK_PUBLIC_BASE_URL ? checkPublicBaseUrl(env.LOGDOCK_PUBLIC_BASE_URL) : null,
    displayTimezone: env.LOGDOCK_DISPLAY_TIMEZONE ? checkTimezone(env.LOGDOCK_DISPLAY_TIMEZONE) : DEFAULTS.displayTimezone,
    logRetentionMonths: intEnv(env, 'LOGDOCK_LOG_RETENTION_MONTHS', DEFAULTS.logRetentionMonths),
    clickhouse: loadClickHouseConfig(env),
    searchRun: {
      ...DEFAULTS.searchRun,
      budgetMs: intEnv(env, 'LOGDOCK_SEARCH_BUDGET_MS', DEFAULTS.searchRun.budgetMs),
      maxConcurrent: intEnv(env, 'LOGDOCK_SEARCH_MAX_CONCURRENT', DEFAULTS.searchRun.maxConcurrent),
      maxPerSession: intEnv(env, 'LOGDOCK_SEARCH_MAX_PER_SESSION', DEFAULTS.searchRun.maxPerSession),
      maxThreads: optionalIntEnv(env, 'LOGDOCK_SEARCH_MAX_THREADS'),
      maxMemoryBytes: optionalIntEnv(env, 'LOGDOCK_SEARCH_MAX_MEMORY_BYTES'),
    },
    alertEval: {
      ...DEFAULTS.alertEval,
      budgetMs: intEnv(env, 'LOGDOCK_ALERT_EVAL_BUDGET_MS', DEFAULTS.alertEval.budgetMs),
      maxThreads: optionalIntEnv(env, 'LOGDOCK_ALERT_EVAL_MAX_THREADS'),
      maxMemoryBytes: optionalIntEnv(env, 'LOGDOCK_ALERT_EVAL_MAX_MEMORY_BYTES'),
    },
    db: {
      host: env.LOGDOCK_DB_HOST ?? '/tmp',
      port: intEnv(env, 'LOGDOCK_DB_PORT', 5432),
      user: env.LOGDOCK_DB_USER ?? 'logdock_api',
      database: env.LOGDOCK_DB_NAME ?? 'logdock',
      password: env.LOGDOCK_DB_PASSWORD || undefined,
      max: intEnv(env, 'LOGDOCK_DB_POOL', 10),
    },
    cookieSecure: env.LOGDOCK_COOKIE_SECURE !== 'false',
  };
}
