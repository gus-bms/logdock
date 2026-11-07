// 조회·관리 API 설정. 한도와 시간 값은 측정·Q15 협의 전의 시제품 값이며 코드에 박지 않고 여기서만 정한다.

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

export interface AppConfig {
  db: DatabaseConfig;
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
  /** 요청 본문 상한. */
  bodyLimit: string;
}

export const DEFAULTS: Omit<AppConfig, 'db'> = {
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
  bodyLimit: '1mb',
};

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

/** 환경 변수에서 설정을 읽는다. 비밀번호는 PGPASSFILE 같은 파일로 두는 편이 낫지만 개발용으로 받는다. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    ...DEFAULTS,
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
