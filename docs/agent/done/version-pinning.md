# 기술 버전 고정

- 담당: Claude Code 2026-11-05
- 우선순위: 2
- 선행: 없음
- 다음 할 일: 없음
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
- 2026-11-05 세 구성 요소의 지원 정책과 현재 버전을 공식 자료로 확인해 Go 1.27, ClickHouse 26.8 LTS, PostgreSQL 18(개발용 로컬과 중앙 모두)로 고정했다. PostgreSQL 19는 RC 1이라 고르지 않았고, ClickHouse는 월간 stable 대신 1년 지원 LTS를 골랐다. 근거 R38~R49와 고정 규칙은 [D17 공식 자료 조사 8절](../../research/d17-tech-evidence-2026-11-03.md#8-버전-고정), 측정 버전은 [D17 기획안 8절](../../planning/d17-tech-selection-v0.1.md#8-측정-계획)에 남겼다. 결정 기록·잔여 기획의 현재 상태 문장, 계약 초안의 버전 확인 문장, 개발 환경 안내, 시제품·측정 보류 작업을 맞췄다. 확인하다 찾은 ClickHouse text 색인(26.2부터 정식)과 projection이 있으면 경량 삭제가 기본으로 막히는 제약은 계약 초안 3.2절에 넣었다. 아무것도 설치·실행하지 않았다. 완료 조건을 모두 채워 done으로 옮긴다.
- 2026-11-05 완료 뒤 사용자 요청으로 이 PC에 Go 1.27.3과 PostgreSQL 18.6을 Homebrew로 설치했다. 함께 올라간 공용 라이브러리는 openssl@4·readline·ca-certificates의 작은 버전 변경뿐이고, 다른 도구가 연쇄로 업그레이드되지 않게 설치했다. 중앙 서버의 PostgreSQL 18은 서버를 준비할 때 설치한다.
