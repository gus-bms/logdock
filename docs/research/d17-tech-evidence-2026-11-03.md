# D17 기술 후보 공식 자료 조사

확인일: 2026-11-03(8절 버전 고정은 2026-11-05). 대상은 수집기, 저장·검색 엔진, 로그 저장 위치, 관리 DB, 실행 수단이다. [기술 선정안](../planning/d17-tech-selection-v0.1.md)의 근거이며 채택 결정이나 실제 동작 검증이 아니다.

## 1 확인 방법과 경계

공식 문서를 웹 검색 발췌로 확인했고 버전과 라이선스는 GitHub API로 읽었다. 페이지 전문을 정독한 것은 아니며 어떤 후보도 설치하거나 측정하지 않았다. GitHub 이슈는 공식 프로젝트 저장소의 보고이지만 현재 버전에 남아 있는지는 확인하지 않았다. 검색·본문 관련 근거는 [Q08 공식 자료 조사](q08-search-evidence-2026-11-02.md)의 S번호를 함께 쓴다.

## 2 후보 버전과 라이선스

2026-11-03 GitHub API의 저장소 라이선스 식별자와 최신 릴리스다. 값은 채택 시점에 다시 확인한다. 채택한 구성 요소의 고정 버전은 [8절](#8-버전-고정)에 있다.

| 후보 | 최신 릴리스 | 라이선스 식별자 |
| --- | --- | --- |
| ClickHouse | v26.10.2.103-stable (2026-10-24) | Apache-2.0 |
| Grafana Loki | v3.7.9 (2026-10-20) | AGPL-3.0 |
| Elasticsearch | v9.5.6 (2026-11-02) | 식별 불가(NOASSERTION). R24 참고 |
| OpenSearch | 3.9.0 (2026-09-29) | Apache-2.0 |
| Vector | v0.61.0 (2026-10-29) | MPL-2.0 |
| Fluent Bit | v5.1.5 (2026-10-21) | Apache-2.0 |
| Filebeat(elastic/beats) | v9.5.6 (2026-11-02) | 식별 불가(NOASSERTION) |
| OpenTelemetry Collector Contrib | v0.164.1 (2026-10-26) | Apache-2.0 |
| NestJS | v12.3.0 (2026-10-28) | MIT |
| PostgreSQL | REL_18_6 (태그) | 식별 불가(NOASSERTION). 라이선스 문서는 이번에 확인하지 않음 |

## 3 수집기

| 근거 ID | 공식 자료 | 확인한 사실 | LogDock에 주는 영향 |
| --- | --- | --- | --- |
| R01 | [Vector file source](https://vector.dev/docs/reference/configuration/sources/file/) | 체크포인트가 없는 파일의 시작 위치는 `read_from` 하나로 정한다. `max_line_bytes`를 넘는 줄은 버린다. 파일 식별은 앞부분 체크섬 또는 장치·아이노드다 | 생성 확인 파일과 불확실한 파일을 나누는 D02를 설정으로 표현할 수 없다 |
| R02 | [Vector buffering model](https://vector.dev/docs/architecture/buffering-model/), [Guarantees](https://vector.dev/docs/architecture/guarantees/) | `when_full: block`이 기본이다. 디스크 버퍼는 최소 약 256MB이고 500ms마다 동기화한다. 내구 버퍼가 있는 sink는 버퍼에 쓰면 전달로 표시한다 | D01과 맞는다. 연결마다 sink를 나누면 최소 크기가 연결 수만큼 쌓여 자원 최소화와 어긋난다 |
| R03 | [Vector HTTP sink](https://vector.dev/docs/reference/configuration/sinks/http/), [이슈 #6420](https://github.com/vectordotdev/vector/issues/6420) | 408, 429, 501을 뺀 5xx만 재시도한다. 그 밖의 응답은 재시도하지 않고 재시도 코드를 바꾸는 설정 요청이 이슈로 남아 있다 | 키 폐기로 401·403을 주면 데이터를 버린다. Q05와 충돌한다. 중앙이 인증 오류에 5xx를 돌려주는 우회만 가능하다 |
| R04 | [Vector journald source](https://vector.dev/docs/reference/configuration/sources/journald/) | `journalctl` 명령을 통해 읽고 체크포인트를 저장한다 | journald를 별도 라이브러리 없이 읽는 선례다 |
| R05 | [Filebeat output](https://www.elastic.co/docs/reference/beats/filebeat/configuring-output), [filestream](https://www.elastic.co/docs/reference/beats/filebeat/filebeat-input-filestream), [internal queue](https://www.elastic.co/guide/en/beats/filebeat/current/configuring-internal-queue.html) | 출력은 하나만 정의할 수 있다. `message_max_bytes`를 넘는 부분은 버리고 보낸다. 디스크 큐 한도를 넘으면 입력 설정에 따라 일시정지하거나 버린다 | 연결별 키(Q10-07)를 한 프로세스로 처리할 수 없다. 잘라서 보내는 동작은 D03과 충돌한다. 일반 HTTP 출력은 검색 결과에서 찾지 못했다 |
| R06 | [Fluent Bit tail](https://docs.fluentbit.io/manual/data-pipeline/inputs/tail) | `skip_long_lines`는 여러 줄 메시지에 적용되지 않는다. `read_newly_discovered_files_from_head`가 있다 | 여러 줄 이벤트의 전체 거부(D03)를 보장하지 않는다. 새 파일 구분은 일부 가능하다 |
| R07 | [Fluent Bit buffering](https://docs.fluentbit.io/manual/4.0/administration/buffering-and-storage) | `storage.total_limit_size`에 닿으면 가장 오래된 chunk를 버린다. tail 입력은 일시정지가 로그 손실로 이어질 수 있다고 경고한다 | 포화 시 기존 대기를 지키는 D01과 정면으로 충돌한다 |
| R08 | [Fluent Bit scheduling and retries](https://docs.fluentbit.io/manual/administration/scheduling-and-retries) | `Retry_Limit`을 없앨 수 있고 재시도가 끝나면 기본으로 버린다 | HTTP 출력의 4xx 처리는 확인하지 못했다 |
| R09 | [OpenTelemetry Collector resiliency](https://opentelemetry.io/docs/collector/resiliency/), [exporterhelper](https://github.com/open-telemetry/opentelemetry-collector/blob/main/exporter/exporterhelper/README.md) | 큐가 가득 차면 버린다. 영속 큐도 디스크가 가득 차거나 I/O 오류가 나면 버린다. 재시도 시간이 지나면 버린다 | D01·D05의 무기한 보존과 충돌한다 |
| R10 | [filelog receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/filelogreceiver/README.md) | 큰 항목은 기본으로 나누고 `truncate`는 잘라서 보낸다 | 분할·잘림을 채택하지 않은 D03과 충돌한다 |
| R11 | [fileconsumer design](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/pkg/stanza/fileconsumer/design.md), [이슈 #43693](https://github.com/open-telemetry/opentelemetry-collector-contrib/issues/43693) | 파일 지문으로 회전을 추적한다. copytruncate 뒤 읽기가 멈춘다는 보고가 있다 | 자체 구현에 참고할 설계 자료다. 라이브러리로 재사용하는 것은 검증 전이다 |

## 4 저장·검색

| 근거 ID | 공식 자료 | 확인한 사실 | LogDock에 주는 영향 |
| --- | --- | --- | --- |
| R12 | [ClickHouse transactional support](https://clickhouse.com/docs/guides/developer/transactional) | 한 블록·한 파티션 INSERT는 전부 적용되거나 전부 거부된다. 읽는 쪽은 전후 상태만 본다. 여러 파티션에 걸치면 파티션별로만 원자적이다. `fsync_after_insert`로 디스크 동기화를 요청할 수 있다 | 묶음을 수신일 파티션 하나에 넣으면 순번 방식의 원자성이 성립한다 |
| R13 | [ClickHouse async inserts](https://clickhouse.com/docs/optimize/asynchronous-inserts) | `wait_for_async_insert=1`이면 저장 후 응답한다 | Q04 저장 뒤 응답을 엔진 경로로 맞출 수 있다 |
| R14 | [ClickHouse TTL](https://clickhouse.com/docs/use-cases/observability/clickstack/ttl), [architecture overview](https://clickhouse.com/docs/concepts/core-concepts/academic-overview) | 일 단위 파티션과 부분 삭제를 권장한다. 경량 삭제는 즉시 읽기에서 제외하고 물리 삭제는 병합 때 일어난다 | Q13의 만료·조기 삭제·구간 삭제와 공간 회수 시차에 맞는다 |
| R15 | [ClickHouse query complexity](https://clickhouse.com/docs/operations/settings/query-complexity), [max_execution](https://clickhouse.com/docs/reference/settings/session-settings/max-execution) | `break`는 부분 결과를 돌려주지만 안전하게 멈추지 못하는 연산이 있다. 사용자 마감은 클라이언트에서 강제하고 취소를 전파하라고 안내한다 | 완료 구간을 알아야 하므로 시간 조각을 나눠 실행하는 쪽이 맞다 |
| R16 | [KILL](https://clickhouse.com/docs/reference/statements/kill), [query_log](https://clickhouse.com/docs/reference/system-tables/query_log), [log_queries](https://clickhouse.com/docs/reference/settings/session-settings/log-queries) | `KILL QUERY`로 실행 중 쿼리를 끝낸다. `log_queries`는 기본 켜짐이고 끌 수 있다 | Q08 SD-35의 검색어 비노출을 설정으로 맞출 수 있다 |
| R17 | [OSS usage recommendations](https://clickhouse.com/docs/operations/tips), [Sizing guide](https://clickhouse.com/docs/guides/sizing-and-hardware-recommendations) | 권장은 32GB 이상이다. 16GB 미만은 메모리 예외가 날 수 있다. 소량이면 8GB 밑으로 내리지 말라고 안내한다. 조정하면 2GB에서도 돌지만 낮은 수집률이다. 16GB 미만에서는 mark cache 축소, 쿼리 처리 스레드 1개 등 설정을 낮추라고 안내한다. 압축 데이터가 약 200GB 이하면 데이터 크기만큼 메모리를 두는 것이 가장 좋고, 범용 기준 메모리 4GB당 CPU 1코어를 권장한다(2026-11-03 페이지 본문 재확인) | 중앙 서버 메모리가 후보 판정의 환경 조건이다. 사용자는 16GB를 준비하기로 했다 |
| R18 | [String search functions](https://clickhouse.com/docs/sql-reference/functions/string-search-functions) | 대소문자 미구분은 영어 규칙을 따르며 다른 언어는 예상과 다를 수 있다 | 한글은 영향이 없다. 비ASCII 지원 범위는 시험 후 공개한다(Q08 SD-17) |
| R19 | [Workload scheduling](https://clickhouse.com/docs/operations/workload-scheduling) | 워크로드별 CPU·쿼리 슬롯 한도를 둘 수 있다. 병합과 변경 작업은 CPU 스케줄링 대상이 아니다 | 검색·알림 평가 분리(Q08 SD-31, Q12 TD-19)에 쓴다. 완전한 격리는 아니다 |
| R20 | [ClickHouse JS](https://clickhouse.com/docs/integrations/language-clients/js) | 공식 Node.js 클라이언트가 있고 Node 24를 지원한다. 스트리밍과 요청 취소를 제공한다 | NestJS 조회 계층을 유지할 수 있다 |
| R21 | [Elasticsearch translog](https://www.elastic.co/docs/reference/elasticsearch/index-settings/translog), [Create API](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-create) | 기본값은 fsync 뒤 성공 응답이다. `op_type=create`는 같은 ID가 있으면 409다 | Q04와 D06에 가장 잘 맞는 기본 동작이다 |
| R22 | [Flattened field type](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/flattened) | 값이 모두 keyword로 색인되고 숫자 범위 쿼리를 지원하지 않는다. 특정 키만 타입을 지정할 수 있다 | 임의 필드의 숫자 범위(Q08 필드 합의)가 어렵다 |
| R23 | [Bootstrap checks](https://www.elastic.co/docs/deploy-manage/deploy/self-managed/bootstrap-checks), [System configuration](https://www.elastic.co/docs/deploy-manage/deploy/self-managed/important-system-configuration) | 운영 모드에서 `vm.max_map_count` 등 호스트 설정을 시작 시 검사한다 | 설치 부담이 있다 |
| R24 | [Elastic licensing FAQ](https://www.elastic.co/pricing/faq/licensing) | 소스에 AGPLv3 선택지가 있지만 릴리스 배포물은 Elastic License라고 설명한다 | LogDock과 함께 배포할 때 조건 확인이 필요하다 |
| R25 | [Loki labels](https://grafana.com/docs/loki/latest/get-started/labels/), [structured metadata](https://grafana.com/docs/loki/latest/get-started/labels/structured-metadata/), [HTTP API](https://grafana.com/docs/loki/latest/reference/loki-http-api/) | 라벨 조합이 스트림이고 값 종류가 적어야 한다. structured metadata는 색인하지 않는다. 삭제 API는 선택자와 시간 범위를 받는다 | 수신 시각을 별도 시간축으로 색인할 수단이 없다 |
| R26 | [pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html) | GIN·GiST 색인이 LIKE·ILIKE를 지원한다. 트라이그램을 뽑을 수 없는 패턴은 전체 색인 스캔이 된다 | `주문` 같은 두 글자 검색은 색인 이득이 없다는 추론이다 |
| R27 | [PostgreSQL partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) | 파티션 삭제가 대량 DELETE보다 훨씬 빠르다. 유일 제약은 파티션 키를 포함해야 한다 | 수신일 파티션은 Q13에 맞지만 이벤트 ID의 전체 유일성은 직접 보장할 수 없다 |

## 5 관리 DB와 실행 수단

| 근거 ID | 공식 자료 | 확인한 사실 | LogDock에 주는 영향 |
| --- | --- | --- | --- |
| R28 | [MySQL implicit commit](https://dev.mysql.com/doc/refman/8.0/en/implicit-commit.html) | ALTER TABLE, CREATE TABLE 등은 암묵적으로 커밋한다 | 스키마 변경 중 실패를 트랜잭션으로 되돌릴 수 없다 |
| R29 | [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html) | SKIP LOCKED로 큐 형태 테이블의 잠금 경합을 피할 수 있다 | 알림 메일 작업(Q12 TD-11)을 별도 큐 없이 처리하는 근거다 |
| R30 | [Go regexp](https://pkg.go.dev/regexp) | 입력 크기에 선형인 시간을 보장한다 | 추출 규칙의 처리 시간 폭주를 엔진 수준에서 막는다(Q08 S23) |
| R31 | [systemd.resource-control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html) | `MemoryMax`, `CPUQuota`, `IOWriteBandwidthMax`, `TasksMax`로 서비스 자원을 강제한다 | RS-01의 강제 상한 수단이다. systemd가 없는 호스트는 내부 한도만 남는다 |
| R35 | [Transactional DDL in PostgreSQL](https://wiki.postgresql.org/wiki/Transactional_DDL_in_PostgreSQL:_A_Competitive_Analysis), [CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html) | 위키는 PostgreSQL이 WAL 설계로 DDL을 트랜잭션 안에서 실행한다고 설명한다. 공식 매뉴얼은 일반 `CREATE INDEX`는 트랜잭션 블록 안에서 실행할 수 있지만 `CREATE INDEX CONCURRENTLY`는 안 된다고 적는다. 2026-11-03 D17-04 답변 전에 페이지 본문을 받아 확인했다 | 스키마 변경 실패를 트랜잭션으로 되돌릴 수 있다(D17-04). 트랜잭션 안에서 못 쓰는 명령은 별도 단계로 다룬다 |
| R36 | [Docker JSON File logging driver](https://docs.docker.com/engine/logging/drivers/json-file/) | json-file 파일은 Docker 데몬만 다루도록 설계됐고, 외부 도구로 다루면 예기치 않은 동작이 생길 수 있어 피해야 한다고 경고한다. `max-size` 기본값은 무제한(-1)이고 `max-file`은 `max-size`가 있을 때만 동작한다(2026-11-03 페이지 본문 확인) | LogDock 첫 출시는 json-file 파일을 직접 읽지 않고 컨테이너 로그를 journald로 읽는다(2026-11-03 합의). 회전 설정이 없으면 원본이 디스크를 채울 수 있다 |
| R37 | [journald.conf](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html) | `RateLimitIntervalSec=`·`RateLimitBurst=` 기본값은 서비스마다 30초에 1만 건이고, 넘는 메시지는 버린 뒤 버린 건수만 남긴다. 실제 한도는 디스크 여유에 따라 배수로 늘어난다. `Storage=auto`는 `/var/log/journal`이 있으면 영구, 없으면 메모리에 보관하며 기본값은 빌드 때 정해진다. `LineMax=`를 넘는 줄은 여러 레코드로 나뉜다(2026-11-03 페이지 본문 확인) | 설치 때 서버별 영구 보관 여부와 속도 제한을 확인한다. 버려진 메시지는 원본 기록 소실로 다룬다 |

## 6 로그 저장 위치

D17-06(서버 디스크와 object storage 중 어디에 저장할지)의 근거다. 사용자는 서버 디스크만 쓰는 안을 골랐고, 아래는 미채택 안의 동작과 나중에 바꿀 때의 조건을 남긴 것이다.

| 근거 ID | 공식 자료 | 확인한 사실 | LogDock에 주는 영향 |
| --- | --- | --- | --- |
| R32 | [Separation of storage and compute](https://clickhouse.com/docs/guides/separation-storage-compute), [External disks](https://clickhouse.com/docs/operations/storing-data), [Integrating S3](https://clickhouse.com/docs/integrations/s3) | object storage 디스크와 로컬 캐시 디스크를 저장 정책으로 묶고 테이블의 `storage_policy`로 고른다. 기본 구성에서는 메타데이터가 서버 로컬에 남는다. 클라우드의 수명 주기 정책은 지원하지 않으며 테이블이 깨질 수 있다고 경고한다. 저장 정책을 바꿀 때 새 정책은 기존 디스크와 볼륨을 모두 포함해야 하고 데이터를 옮겨 주지 않는다 | 전부 object storage에 두는 안의 구성 근거다. 메타데이터가 로컬에 있으므로 object storage만으로 서버 고장에 대비되지 않는다고 판단했다(추론). 서버 디스크로 시작해도 기존 디스크를 포함한 새 정책에 object storage 볼륨을 더해 계층 저장으로 갈 수 있다. 시험하지 않았다 |
| R33 | [MergeTree 저장 정책과 TTL](https://clickhouse.com/docs/reference/engines/table-engines/mergetree-family/mergetree) | 볼륨을 여러 개 두고 `TTL ... TO VOLUME`으로 오래된 데이터를 옮기거나 `ALTER TABLE ... MOVE PARTITION`으로 직접 옮긴다. `move_factor`는 남은 공간이 이 비율 아래로 내려가면 다음 볼륨으로 옮긴다. 이동 시점이 이미 지난 행은 기본 설정(`perform_ttl_move_on_insert=1`)에서 삽입할 때 바로 이동 대상 볼륨에 쓰일 수 있다 | 계층 저장의 구현 수단이다. 이동 기준을 발생 시각으로 잡으면 늦게 도착한 로그가 바로 object storage로 갈 수 있으므로 보관과 같은 수신 시각을 기준으로 삼아야 한다 |
| R34 | [S3 insert and read performance](https://clickhouse.com/docs/integrations/s3/performance), [Building a distributed cache for S3](https://clickhouse.com/blog/building-a-distributed-cache-for-s3) | 삽입한 데이터뿐 아니라 병합 결과도 object storage에 써야 해서 쓰기 지연을 피하지 못한다. 흩어진 작은 읽기는 지연 때문에 로컬 SSD보다 느리고, 큰 범위를 훑는 읽기는 병렬 읽기로 빠를 수 있다. 수치는 제조사의 클라우드 환경 시험이다 | 전부 object storage에 두면 저장 뒤 응답과 병합이 느려진다. 오래된 구간을 object storage에서 검색할 때 얼마나 느려지는지는 측정하지 않았다 |

## 7 확인하지 못한 것

- PostgreSQL 트랜잭션 DDL은 R35로 확인했지만 실제 마이그레이션 도구에서의 동작은 시험하지 않았다.
- OpenSearch는 버전과 라이선스만 확인했고 기능은 조사하지 않았다.
- Fluent Bit HTTP 출력의 4xx 처리, Vector `offset_key`의 여러 줄 이벤트 기준, Filebeat의 파일 발견 시작 위치는 확인하지 못했다.
- ClickHouse의 `query_log`에 쿼리 파라미터 값이 남는지는 확인하지 못했다.
- 부분 일치 속도, 압축률, 메모리, 에이전트 자원은 어느 후보도 측정하지 않았다.
- object storage를 쓸 때의 실제 쓰기·검색 지연과 요청 비용, 저장 정책을 바꿔 계층을 더하는 절차는 시험하지 않았다.
- 서버의 로컬 메타데이터를 잃었을 때 object storage의 데이터만으로 복구되는지 직접 설명한 공식 자료는 찾지 못했다. R32의 메타데이터 위치에서 추론했다.

## 8 버전 고정

2026-11-05 확인했다. D17에서 고른 Go·ClickHouse·PostgreSQL의 지원 정책과 현재 버전을 공식 페이지 본문, go.dev의 다운로드 목록 JSON, GitHub API로 읽었다. 기획 종료 기준의 "공식 자료 확인일·버전·license·지원 capability"를 채우기 위한 것이며 아무것도 설치하거나 실행하지 않았다.

| 구성 요소 | 고정 | 2026-11-05 최신 패치 | 지원 기간 | 라이선스 | 고른 이유 |
| --- | --- | --- | --- | --- | --- |
| Go(에이전트·수신 서버) | 1.27 계열 | 1.27.3(2026-10-19) | Go 1.29가 나올 때까지(R38) | BSD-3-Clause(R48) | 지원 중인 두 계열(1.27·1.26) 가운데 지원이 더 오래 남았다 |
| ClickHouse | 26.8 LTS 계열 | v26.8.34.13-lts(2026-10-22) | 첫 출시일 2026-08-27부터 1년(R43·R44) | Apache-2.0(R48) | 월간 stable은 최근 3개만 지원해 석 달 안팎마다 올려야 한다. LTS는 1년 지원이라 자주 올리기 어려운 자체 운영에 맞고, 필요한 기능(R45~R47)이 이 계열에 모두 있다 |
| PostgreSQL(개발용 로컬과 중앙 모두) | 18 | 18.6 | 2030-11-14까지(R40) | PostgreSQL License(R41) | 정식 출시된 가장 새 메이저다. 19는 2026-10-15 RC 1이고 정식 출시 전이다. DDL 초안이 쓰는 기능을 18 문서로 확인했다(R42) |

- **고정 단위:** 메이저와 LTS 계열만 고정하고 패치는 보안·버그 수정을 따라 올린다. 설치·측정·배포 기록에는 정확한 패치 번호를 남긴다.
- **계열 변경:** Go 1.28 이상, ClickHouse 다음 LTS, PostgreSQL 19로 옮길 때는 지원이 끝나기 전에 이 절을 다시 정하고, 결과가 달라질 수 있는 측정([D17 기획안 8절](../planning/d17-tech-selection-v0.1.md#8-측정-계획))을 다시 한다.
- **로컬과 중앙:** 개발용 로컬 PostgreSQL과 중앙 서버 PostgreSQL은 둘 다 18이다. 메이저가 다르면 DDL과 동작 차이를 개발 중에 놓칠 수 있다.
- **범위 밖:** 조회 API·웹(NestJS·React)의 의존성과 Go·DB 드라이버 같은 라이브러리는 여기서 고정하지 않는다. 구현을 시작할 때 같은 방식으로 확인한다.

| 근거 ID | 공식 자료 | 확인한 사실 | LogDock에 주는 영향 |
| --- | --- | --- | --- |
| R38 | [Go release history](https://go.dev/doc/devel/release), [다운로드 목록 JSON](https://go.dev/dl/?mode=json) | 각 메이저는 더 새 메이저 두 개가 나올 때까지 지원한다. 2026-11-05 지원 계열은 1.27(1.27.3, 2026-10-19)과 1.26(1.26.10)이다. 1.27.0은 2026-08-19에 나왔다 | 1.27 계열을 고른다 |
| R39 | [Go 1.27 release notes](https://go.dev/doc/go1.27), [Minimum requirements](https://go.dev/wiki/MinimumRequirements) | Go 1.27은 macOS 13 이상이 필요하다. Go 1.24부터 Linux는 kernel 3.2 이상이다 | 개발 PC는 macOS 13 이상이어야 한다. 에이전트를 올릴 서버의 kernel 하한은 3.2다. 실제 대상 서버의 kernel은 확인하지 않았다 |
| R40 | [PostgreSQL Versioning Policy](https://www.postgresql.org/support/versioning/) | 메이저는 첫 출시 뒤 5년 지원하고 minor는 적어도 석 달마다 낸다. 지원 표에서 18의 현재 minor는 18.6, 지원 종료는 2030-11-14다. 같은 페이지 머리 공지는 2026-10-15 PostgreSQL 19 RC 1 출시다 | 18을 고른다. 19로 옮기려면 메이저 업그레이드 절차가 필요하다 |
| R41 | [PostgreSQL Licence](https://www.postgresql.org/about/licence/) | PostgreSQL License는 BSD·MIT와 비슷한 허용형 오픈소스 라이선스라고 설명한다. GitHub API는 식별자를 주지 않는다(NOASSERTION) | 2절에서 확인하지 않은 라이선스를 채운다 |
| R42 | PostgreSQL 18 [문자열 함수](https://www.postgresql.org/docs/18/functions-string.html), [생성 열](https://www.postgresql.org/docs/18/ddl-generated-columns.html), [CREATE TABLE](https://www.postgresql.org/docs/18/sql-createtable.html), [부분 색인](https://www.postgresql.org/docs/18/indexes-partial.html), [NOTIFY](https://www.postgresql.org/docs/18/sql-notify.html) | `IS [NOT] [form] NORMALIZED`는 서버 인코딩이 UTF8일 때만 쓸 수 있다. 18에서 생성 열의 기본은 virtual이고 `STORED`를 적으면 저장 생성 열이다. `GENERATED { ALWAYS \| BY DEFAULT } AS IDENTITY`, 조건을 만족하는 행 사이에서만 유일성을 강제하는 부분 유일 색인, `NOTIFY`의 알림 전달이 18 문서에 있다 | API 계약 초안 DDL(3.4절)이 쓰는 기능이 18에 있다. `name_text` 도메인은 UTF8 DB가 전제다. `connections.target_identity`는 `STORED`를 적었으므로 기본값이 바뀌어도 저장 생성 열이다 |
| R43 | [Which ClickHouse version to use in production?](https://clickhouse.com/docs/faq/operations/production) | 기본 추천은 대략 매달 나오는 stable이고, 최근 stable 3개만 진단과 버그 수정 백포트를 받는다. LTS는 1년에 두 번 나오고 첫 출시 뒤 1년 지원한다. 자주 올릴 수 없는 정책이 있거나 계속 올릴 자원이 부족하면 LTS를 고려하라고 하며, 처음에 LTS를 고른 팀도 필요한 새 기능 때문에 stable로 옮기는 경우가 많다고 덧붙인다 | LTS를 고른다. 새 기능이 필요해지면 다음 LTS를 기다리거나 이 절을 다시 정한다 |
| R44 | [ClickHouse SECURITY.md](https://github.com/ClickHouse/ClickHouse/blob/master/SECURITY.md), [Changelog](https://clickhouse.com/docs/whats-new/changelog), GitHub 릴리스 API | 2026-11-05 보안 수정을 받는 버전은 26.10·26.9·26.8·26.3이다. 26.8 LTS는 2026-08-27, 26.3 LTS는 2026-03-26에 나왔다. 26.8 LTS의 최신 패치는 v26.8.34.13-lts(2026-10-22)다 | 26.8이 지원이 가장 오래 남은 LTS다 |
| R45 | [JSON data type](https://clickhouse.com/docs/sql-reference/data-types/newjson) | 오픈소스 JSON 타입은 25.3에서 운영용(production ready)으로 표시됐고 그 전 버전에서는 운영에 권하지 않는다 | API 계약 초안 `logs.fields`의 `JSON` 후보를 26.8에서 쓸 수 있다. 타입별 `Map` 열과의 비교는 측정으로 정한다 |
| R46 | [Text indexes](https://clickhouse.com/docs/engines/table-engines/mergetree-family/textindexes) | text 색인은 26.2부터 정식 기능(GA)이고 별도 설정 없이 쓴다. 토크나이저로 `ngrams(N)` 등을 고를 수 있다. 문구 검색 옵션(`support_phrase_search`)은 실험 기능이다 | M2의 본문 색인 후보에 n-gram 토크나이저 text 색인을 넣을 수 있다. 실험 옵션은 쓰지 않는다 |
| R47 | [DELETE](https://clickhouse.com/docs/sql-reference/statements/delete) | 경량 DELETE는 MergeTree 계열에서 쓴다. projection이 있는 테이블에서는 기본으로 동작하지 않고 MergeTree 설정 `lightweight_mutation_projection_mode`로 바꾼다. 많은 양을 경량 삭제하면 SELECT 성능이 떨어질 수 있다 | 구간 삭제(Q13-03)는 경량 삭제다. 주변 로그용 projection을 붙이면 이 설정을 함께 정해야 한다 |
| R48 | [golang/go LICENSE](https://github.com/golang/go/blob/master/LICENSE), [ClickHouse LICENSE](https://github.com/ClickHouse/ClickHouse/blob/master/LICENSE)(GitHub 라이선스 API) | Go는 BSD-3-Clause, ClickHouse는 Apache-2.0이다 | 세 구성 요소 모두 허용형 라이선스다. 함께 배포하면 각 저작권·라이선스 고지를 넣는다 |
| R49 | [PostgreSQL macOS 설치](https://www.postgresql.org/download/macosx/), [Homebrew postgresql@18](https://formulae.brew.sh/formula/postgresql@18) | 공식 다운로드 페이지는 Homebrew의 메이저별 `postgresql@NN` 설치를 안내한다. 2026-11-05 `postgresql@18`은 18.6이다 | 개발용 로컬 PostgreSQL을 메이저 18로 맞춰 설치할 수 있다 |

이 절에서 확인하지 못한 것:

- 에이전트를 올릴 서버의 kernel·아키텍처와 중앙 서버 배포판에서 고른 버전을 설치할 수 있는지.
- DDL 초안의 실제 적용. 사용자가 개발용 PostgreSQL 18을 설치한 뒤 확인한다.
- PostgreSQL 19의 정식 출시일과 18과의 비호환 변경.
