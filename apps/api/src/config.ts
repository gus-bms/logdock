// 조회·관리 API 설정. 한도와 시간 값은 측정·Q15 협의 전의 시제품 값이며 코드에 박지 않고 여기서만 정한다.
import { readFileSync } from 'node:fs';

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
  /** 요청 본문 상한. */
  bodyLimit: string;
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
  bodyLimit: '1mb',
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

/** 메일 주소 꼴. 관리 DB의 mail_address 도메인과 같다(앞뒤에 @ 없는 한 덩어리씩, 공백·제어 문자 불가). */
export const MAIL_ADDRESS = /^[^@\s\p{Cc}]+@[^@\s\p{Cc}]+$/u;

/**
 * 비밀 값은 설정에 직접 쓰지 않고 중앙 서비스 계정만 읽는 파일의 경로로 받는다(계약 8.1절, TD-20). 끝의 줄바꿈 하나만 뗀다.
 * 읽을 수 없으면 시작하지 않는다.
 */
function readSecretFile(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r?\n$/, '');
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
  };
}

/** 환경 변수에서 설정을 읽는다. 비밀번호는 PGPASSFILE 같은 파일로 두는 편이 낫지만 개발용으로 받는다. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    ...DEFAULTS,
    ingestUrl: env.LOGDOCK_INGEST_URL ? checkIngestUrl(env.LOGDOCK_INGEST_URL) : null,
    mail: loadMailConfig(env),
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
