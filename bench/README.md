# LogDock 측정 도구

[측정 M1~M4 계획](../docs/planning/measurement-m1-m4-plan-v0.1.md)을 실행하는 Go 도구(`logdock-bench`)다. 합성 로그만 쓰고 실제 로그는 읽지 않는다. 제품 코드가 아니며 측정이 끝나면 결과 문서만 남긴다.

## 빌드와 시험

Go 1.27, 표준 라이브러리만 쓴다. 저장소 루트에서 실행한다.

```sh
go -C bench test ./...
GOOS=linux GOARCH=amd64 go -C bench build -o dist/logdock-bench ./cmd/logdock-bench
```

`dist/`는 Git에 넣지 않는다.

## 명령

| 명령 | 하는 일 | DB 변경 |
| --- | --- | --- |
| `sample`, `calibrate`, `ddl` | 합성 줄 보기, 형식별 gzip 압축률, 변형의 CREATE TABLE 출력 | 없음 |
| `smoke` | 작은 데이터로 모든 단계를 한 번씩 돌리고 지운다. 긴 측정 전에 먼저 돌린다 | 있음 |
| `load` | 변형 테이블을 만들고 합성 날짜를 넣는다(M1·M2 데이터) | 있음 |
| `sizes` | 테이블·열·색인별 저장 크기와 6개월 환산(M1) | 없음 |
| `query` | 검색 응답 시간(M2). `-cold`는 캐시를 비우므로 `sudo`로 실행 | 캐시만 비움 |
| `ingest` | 하루 양 속도로 1초마다 묶어 넣는 지연(M3) | 있음 |
| `concurrent` | 넣으면서 검색 5개를 동시에 보낸다(M4) | 있음 |
| `drop` | 측정 테이블이나 측정 DB를 지운다 | 있음 |

- 측정 데이터는 `bench` DB에만 쓴다. `default`·`system`·`logdock` DB에는 쓰지 않는다.
- ClickHouse 관리 계정 비밀번호는 서버의 `/srv/logdock/.env`에서 읽고 출력하지 않는다.
- 결과는 `/srv/logdock/bench-results/<실행 ID>/`에 남는다(`meta.json`과 CSV·JSON). 다른 계정도 읽을 수 있다.
- 디스크 여유가 15GB(`-min-free-gb`) 아래로 내려가면 넣기를 멈춘다.
- 합성 nginx 형식은 gzip 압축률이 약 6.0%로, 2026-11-07 실측(약 5.8%)에 맞췄다. 시험 `TestNginxCompressionMatchesField`가 이 범위를 지킨다.
