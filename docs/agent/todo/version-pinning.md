# 기술 버전 고정

- 담당: 없음
- 우선순위: 2
- 선행: 없음
- 다음 할 일: Go, ClickHouse, PostgreSQL의 현재 지원 버전을 공식 자료로 확인한다
- 막힌 이유: 없음
- 풀리는 조건: 없음
- 마지막 갱신: 2026-11-05

## 목표와 완료 조건

기획 종료 기준의 "기술 결정에는 공식 자료 확인일·버전·license·지원 capability"를 채운다.

- Go, ClickHouse, PostgreSQL의 고정 버전과 공식 확인일, license를 D17 근거 문서에 기록한다.
- 측정 M1~M8을 어느 버전으로 할지 D17 기획안 8절에 연결한다.
- 이 PC의 개발용 PostgreSQL과 중앙 서버의 PostgreSQL을 같은 메이저 버전으로 맞춘다([개발 환경](../refs/dev-environment.md)).

## 참고 문서

- [D17 기술 선정안](../../planning/d17-tech-selection-v0.1.md) 8·10절
- [D17 공식 근거](../../research/d17-tech-evidence-2026-11-03.md)

## 진행 기록

- 2026-11-04 작업 파일을 만들었다.
- 2026-11-05 개발용 PostgreSQL을 이 PC에 두기로 해([결정 기록](../../decisions.md)) 로컬과 중앙의 버전 맞춤을 목표에 더했다.
