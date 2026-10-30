import { useEffect, useState } from 'react';

type HealthState =
  | { status: 'checking' }
  | { status: 'connected' }
  | { status: 'failed'; message: string };

function isHealthy(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'ok' &&
    'service' in value &&
    value.service === 'logdock-api'
  );
}

function App() {
  const [health, setHealth] = useState<HealthState>({ status: 'checking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const timeout = window.setTimeout(() => controller.abort(), 5_000);

    async function checkHealth() {
      try {
        const response = await fetch('/api/health', {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });

        if (!response.ok) {
          throw new Error(`API가 HTTP ${response.status}로 응답했습니다.`);
        }

        const body: unknown = await response.json().catch(() => {
          throw new Error('API 응답이 올바른 JSON 형식이 아닙니다.');
        });
        if (!isHealthy(body)) {
          throw new Error('API 응답 형식을 확인할 수 없습니다.');
        }

        if (!cancelled) setHealth({ status: 'connected' });
      } catch (error: unknown) {
        if (cancelled) return;

        const message = controller.signal.aborted
          ? 'API 응답 시간이 초과되었습니다.'
          : error instanceof TypeError
            ? 'API에 연결할 수 없습니다. API 서버 실행 상태를 확인해 주세요.'
            : error instanceof Error
            ? error.message
            : 'API에 연결할 수 없습니다.';

        setHealth({ status: 'failed', message });
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void checkHealth();

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt]);

  function retryHealth() {
    setHealth({ status: 'checking' });
    setAttempt((value) => value + 1);
  }

  const healthLabel = {
    checking: '확인 중',
    connected: '연결됨',
    failed: '연결 실패',
  }[health.status];

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="LogDock 홈">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>LogDock</span>
        </a>
        <span className="header-note">통합 로그 관리</span>
      </header>

      <main>
        <section className="intro" aria-labelledby="page-title">
          <div className="eyebrow">
            <span className="eyebrow-line" />
            여러 서비스의 로그가 모이는 곳
          </div>
          <h1 id="page-title">
            흩어진 로그를,
            <br />
            하나의 공간으로.
          </h1>
          <p className="intro-description">
            서비스와 서버가 달라도 오류를 함께 살펴볼 수 있도록.
            <br className="desktop-break" />
            LogDock의 첫 연결을 준비하고 있습니다.
          </p>
          <span className="stage-badge">초기 프로젝트</span>
        </section>

        <section className="status-grid" aria-label="연결 준비 상태">
          <article className="status-card api-card">
            <div className="card-heading">
              <h2>API 연결</h2>
              <span className={`status-pill status-${health.status}`}>
                <span className="status-dot" />
                {healthLabel}
              </span>
            </div>
            <div className="health-detail" role="status" aria-live="polite">
              {health.status === 'connected' && 'LogDock API가 정상 응답하고 있습니다.'}
              {health.status === 'checking' && 'LogDock API의 응답을 확인하고 있습니다.'}
              {health.status === 'failed' && health.message}
            </div>
            <button
              className="retry-button"
              type="button"
              onClick={retryHealth}
              disabled={health.status === 'checking'}
            >
              {health.status === 'checking' ? '연결 확인 중…' : '다시 확인'}
              <span aria-hidden="true">↗</span>
            </button>
          </article>

          <article className="status-card">
            <div className="card-heading">
              <h2>서비스 연결</h2>
              <span className="status-pill status-pending">연결 전</span>
            </div>
            <p className="card-description">아직 서비스 조회 기능이 연결되지 않았습니다.</p>
            <span className="card-footnote">서비스와 서버별로 살펴볼 수 있도록</span>
          </article>

          <article className="status-card">
            <div className="card-heading">
              <h2>로그 수집</h2>
              <span className="status-pill status-pending">연결 전</span>
            </div>
            <p className="card-description">아직 수집된 로그를 조회하지 않습니다.</p>
            <span className="card-footnote">오류의 시작과 흐름을 한곳에서</span>
          </article>
        </section>

        <section className="empty-state" aria-labelledby="empty-title">
          <div className="dock-illustration" aria-hidden="true">
            <span className="dock-post post-left" />
            <span className="dock-post post-right" />
            <span className="dock-deck" />
            <span className="dock-water water-first" />
            <span className="dock-water water-second" />
          </div>
          <div className="empty-copy">
            <span className="section-label">첫 연결을 기다리는 중</span>
            <h2 id="empty-title">로그가 도착할 공간이 준비되었습니다.</h2>
            <p>
              현재는 기본 화면과 API 상태 확인만 사용할 수 있습니다.
              <br />
              로그 수집기와 검색 엔진 연결은 다음 단계에서 진행합니다.
            </p>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <span>LogDock</span>
        <span>여러 서비스의 로그가 모이는 곳</span>
      </footer>
    </div>
  );
}

export default App;
