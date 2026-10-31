# LogDock 문서 안내

현재 단계는 기능 명세와 설계 검토다. 구현은 health API와 연결 상태 화면까지이며, 문서의 기능 후보·검증 시나리오가 구현되거나 검증된 것은 아니다.

## 다른 환경에서 이어가기

1. [handoff](HANDOFF.md)에서 현재 상태와 다음 작업을 읽는다.
2. [결정 기록](decisions.md)에서 합의·보류·미결정을 확인한다.
3. [제품 기능 후보](specs/product-features-v0.1.md)와 [수집·에이전트 명세](specs/collection-agent-v0.1.md)를 검토한다.
4. 기술 판단의 근거는 [상용 서비스 조사](research/commercial-services-2026-10-30.md)와 공식 출처로 확인한다.
5. [아키텍처 검토 상태](architecture.md)에서 현재 scaffold와 미확정 설계를 구분한다.

## 문서별 역할

| 문서 | 역할 |
| --- | --- |
| [결정 기록](decisions.md) | 제품 정책과 D01~D08의 현재 결정 상태 |
| [제품 기능 명세 v0.1](specs/product-features-v0.1.md) | 제품 정의·사용 흐름·F01~F10 채택 후보 |
| [수집·에이전트 명세 v0.1](specs/collection-agent-v0.1.md) | 자원 보호·전달·장애·보안·18개 검증 시나리오 |
| [상용 서비스 조사](research/commercial-services-2026-10-30.md) | 7개 제품의 문서·화면·공개 데모·가격 비교 |
| [handoff](HANDOFF.md) | 다음 세션의 읽기 순서·실행 경계·검토할 작업 |
| [아키텍처 검토 상태](architecture.md) | 현재 구현과 후속 설계 책임·선택 미확정 범위 |

Markdown 문서와 문서 간 상대 링크가 환경을 옮길 때의 기본 자료다. `artifacts/`의 PDF는 2026-10-30 당시 검토본으로, 이후 Markdown 변경이 자동 반영되지 않는다.

## 검토용 PDF

- [상용 서비스 조사 PDF](artifacts/logdock-commercial-research-2026-10-30.pdf)
- [수집·에이전트 명세 PDF](artifacts/logdock-agent-spec-v0.1-2026-10-30.pdf)

## 변경할 때

사용자의 새 결정을 결정 기록에 반영하고 관련 명세와 handoff의 상태를 함께 맞춘다. 합의되지 않은 추천안은 제안 상태를 유지한다. 문서의 예상 동작과 실제 구현·정적 확인·테스트 실행·운영 관찰을 구분한다.
