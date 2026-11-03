# D17 기술 후보 공식 자료 조사

확인일: 2026-11-03. 대상은 수집기, 저장·검색 엔진, 로그 저장 위치, 관리 DB, 실행 수단이다. [기술 선정안](../planning/d17-tech-selection-v0.1.md)의 근거이며 채택 결정이나 실제 동작 검증이 아니다.

## 1 확인 방법과 경계

공식 문서를 웹 검색 발췌로 확인했고 버전과 라이선스는 GitHub API로 읽었다. 페이지 전문을 정독한 것은 아니며 어떤 후보도 설치하거나 측정하지 않았다. GitHub 이슈는 공식 프로젝트 저장소의 보고이지만 현재 버전에 남아 있는지는 확인하지 않았다. 검색·본문 관련 근거는 [Q08 공식 자료 조사](q08-search-evidence-2026-11-02.md)의 S번호를 함께 쓴다.

## 2 후보 버전과 라이선스

2026-11-03 GitHub API의 저장소 라이선스 식별자와 최신 릴리스다. 값은 채택 시점에 다시 확인한다.

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
