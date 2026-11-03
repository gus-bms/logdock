# Q08 검색 공식 자료 조사

확인일: 2026-11-02. 대상은 시간 처리, 본문 일치, 필드 타입, 조회 일관성, 레벨 정규화다. [기획안과 사용자 결정표](../planning/q08-search-plan-v0.1.md)의 근거이며, 정책 채택·엔진 선정·실제 동작 검증이 아니다.

## 1 확인 방법과 경계

공식 문서를 웹 검색 발췌로 확인했다. 페이지 전문을 정독한 것은 아니며 후보 제품을 설치하거나 특정 버전을 시험하지 않았다. 버전에 따라 달라질 수 있는 값은 D17 선정 시점에 다시 확인한다. 공식 문서가 아닌 포럼에서만 나온 내용은 5절에 따로 적었고 근거 표에 넣지 않았다.

## 2 시간

| 근거 ID | 공식 자료 | 확인한 사실 | LogDock에 적용할 때의 경계 |
| --- | --- | --- | --- |
| S01 | [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/) | Timestamp는 원본 시계 기준 시각, ObservedTimestamp는 수집 쪽이 관측한 시각이다. 시각을 하나만 쓰는 시스템에는 Timestamp가 있으면 그것을, 없으면 ObservedTimestamp를 쓰도록 권한다. SeverityNumber는 TRACE 1~4, DEBUG 5~8, INFO 9~12, WARN 13~16, ERROR 17~20, FATAL 21~24이고 SeverityText는 원본 문자열이다 | 기존 관측 시각 대체 설계안과 레벨 6단계의 참고다. OTel 채택을 뜻하지 않는다. LogDock은 시각을 여러 개 보관하므로 Q02-05대로 발생 시각을 미확인으로 남기고 검색 기준 시각만 대체한다 |
| S02 | [Datadog Log Date Remapper](https://docs.datadoghq.com/logs/log_configuration/processors/log_date_remapper/), [Pipelines](https://docs.datadoghq.com/logs/log_configuration/pipelines/), [Troubleshooting](https://docs.datadoghq.com/logs/troubleshooting/) | 로그는 과거 18시간, 미래 2시간 범위에서 제출할 수 있고 18시간보다 오래되면 수신 단계에서 버린다. 날짜 속성이 없으면 수신 시각을 쓴다. 기본 날짜 속성은 timestamp, date, _timestamp, Timestamp, eventTime, published_date 등이다 | 대조 사례다. 시각을 이유로 폐기하면 Q02-05 본문 보존·D01 장기 대기와 충돌하므로 LogDock은 이 방식을 쓰지 않는다 |
| S03 | [Splunk Configure timestamp recognition](https://help.splunk.com/en/splunk-enterprise/get-started/get-data-in/10.4/configure-timestamps/configure-timestamp-recognition) | MAX_DAYS_AGO·MAX_DAYS_HENCE 범위 밖 시각의 이벤트를 버리지 않고 직전 이벤트 시각이나 색인 시각으로 대체한다 | 잘못된 시각을 폐기 대신 대체하는 선례다. 직전 이벤트 시각 대신 관측 시각을 쓰는 것은 LogDock의 제안이다 |
| S04 | [Loki request validation](https://grafana.com/docs/loki/latest/operations/request-validation-rate-limits/), [Troubleshoot ingestion](https://grafana.com/docs/loki/latest/operations/troubleshooting/troubleshoot-ingest/) | 오래된 시각과 먼 미래 시각을 거부하는 제한이 있다. 별도로 스트림마다 최신 항목보다 일정 범위(기본 설정 기준 약 1시간) 이상 오래된 항목을 거부한다 | 정상 장애 뒤 대기 로그가 늦게 도착하는 D01/Q05 흐름에서 거부가 생기지 않는지 D17에서 검증해야 한다. 수치는 버전별로 다시 확인한다 |
| S05 | [Logstash date filter](https://www.elastic.co/docs/reference/logstash/plugins/plugins-filters-date), [Fluent Bit parser](https://docs.fluentbit.io/manual/data-pipeline/parsers/configuring-parser), [Vector VRL functions](https://vector.dev/docs/reference/vrl/functions/) | 시간대 없는 시각은 수집기마다 별도 지정이 필요하다. Logstash는 지정이 없으면 플랫폼 기본 시간대를 쓴다. Fluent Bit는 고정 오프셋, 시스템 시간대, IANA 시간대 옵션을 제공한다. Vector는 전역 설정을 따르고 함수 인자로 덮어쓸 수 있다 | 연결별 시간대 입력과 서버 시간대 기본값 안의 근거다. 특정 수집기 채택이 아니다 |

## 3 본문과 필드

| 근거 ID | 공식 자료 | 확인한 사실 | LogDock에 적용할 때의 경계 |
| --- | --- | --- | --- |
| S06 | [Elasticsearch Standard tokenizer](https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-standard-tokenizer.html), [nori analyzer](https://www.elastic.co/guide/en/elasticsearch/plugins/current/analysis-nori-analyzer.html) | 표준 토크나이저는 Unicode Text Segmentation(UAX #29) 기반이다. 한국어 형태소 분석은 별도 nori 플러그인이 맡는다 | 단어 단위 검색에서 `주문이`를 `주문`으로 찾으려면 형태소 분석이 필요하다는 판단의 근거다. 로그 본문에는 형태소 분석이 맞지 않는 코드·ID가 섞인다 |
| S07 | [Elasticsearch field data types](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/field-data-types), [Wildcard query](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-wildcard-query) | `wildcard` 타입은 비정형 기계 생성 텍스트의 grep식 검색을 위한 특수 keyword 타입이다. wildcard query에 `case_insensitive` 옵션이 있다. 패턴 앞의 `*`는 느려질 수 있다고 경고한다 | 부분 일치 계약을 Elasticsearch로 충족하려면 `text`만으로는 부족하다는 뜻이다. 실제 비용은 미측정이다 |
| S08 | [ClickHouse text indexes](https://clickhouse.com/docs/engines/table-engines/mergetree-family/textindexes), [Skip index examples](https://clickhouse.com/docs/optimize/skipping-indexes/examples) | text index가 26.2에서 GA가 되어 전문 검색 용도로 Bloom filter 인덱스보다 권장된다. `ilike`는 일부 토크나이저와 사전 스캔 방식에서만 쓰이고 `NOT LIKE`는 text index를 쓰지 못한다. ngrams 토크나이저의 LIKE 가속에는 패턴 조건이 있다 | 대소문자 미구분 부분 일치와 제외는 인덱스 가속을 전제할 수 없다. 스캔 비용을 실행 예산으로 통제하는 계약이 필요하다 |
| S09 | [LogQL log queries](https://grafana.com/docs/loki/latest/query/log_queries/) | `\|=` `!=`는 포함/미포함, `\|~` `!~`는 정규식이다. `(?i)`로 대소문자 미구분 정규식을 쓴다. 숫자 변환에 실패한 줄은 걸러지지 않고 `__error__` 표시가 붙는다 | 포함·제외는 기본 연산이다. 변환 실패 줄이 결과에 남는 동작은 LogDock의 판단 불가 제외 안과 달라 어댑터에서 처리해야 한다 |
| S10 | [Datadog Log Search Syntax](https://docs.datadoghq.com/logs/explorer/search_syntax/) | 자유 검색은 단어 단위이고 속성 검색은 대소문자를 구분한다. `-` 제외와 숫자 범위를 지원한다 | 필드 값 비교의 대소문자 구분과 제외 조건이 일반적인 기능임을 보여주는 사례다 |
| S11 | [Pino API](https://github.com/pinojs/pino/blob/main/docs/api.md), [Pino help](https://github.com/pinojs/pino/blob/main/docs/help.md) | 레벨은 trace 10, debug 20, info 30, warn 40, error 50, fatal 60이고 기본 출력은 숫자다. `formatters.level`로 문자열로 바꿀 수 있다. 시각 기본값은 epoch 밀리초다 | 숫자 레벨 정규화의 근거다 |
| S12 | [Python logging](https://docs.python.org/3/library/logging.html) | DEBUG 10, INFO 20, WARNING 30, ERROR 40, CRITICAL 50이다 | 같은 숫자 30이 Pino에서는 info, Python에서는 warning이다. 숫자 레벨 자동 해석을 연결별로 바꿀 수 있어야 하는 근거다 |
| S13 | [Python json](https://docs.python.org/3/library/json.html) | `json.dumps`는 기본값 `ensure_ascii=True`로 비ASCII 문자를 이스케이프한다 | 저장 본문을 그대로 비교하면 이런 앱의 한글을 찾지 못한다는 근거다 |
| S14 | [systemd.journal-fields](https://www.freedesktop.org/software/systemd/man/systemd.journal-fields.html) | `_SOURCE_REALTIME_TIMESTAMP`는 메시지 발생 추정 시각, `__REALTIME_TIMESTAMP`는 journal 수신 시각, `PRIORITY`는 0~7, `MESSAGE`는 사람이 읽는 본문이다 | 외피 시각·레벨의 우선순위 근거다. 실제 호스트 설정은 미확인이다 |
| S15 | [Datadog Log Status Remapper](https://docs.datadoghq.com/logs/log_configuration/processors/log_status_remapper/), [Logs Show Info Status](https://docs.datadoghq.com/logs/guide/logs-show-info-status-for-warnings-or-errors/) | status, severity, level, syslog.severity를 공식 상태로 읽고 0~7은 syslog 심각도로 대응한다. 상태가 없으면 INFO를 붙인다 | 레벨 키 후보의 참고다. 누락을 INFO로 바꾸는 동작은 Q02-05와 맞지 않아 쓰지 않는다 |
| S16 | [Grafana Logs Drilldown troubleshooting](https://grafana.com/docs/grafana/latest/explore/simplified-exploration/logs/troubleshooting/), [Loki query acceleration](https://grafana.com/docs/loki/latest/query/query_acceleration/) | Loki는 로그 레벨을 자동 판별해 `detected_level`로 남길 수 있다 | 줄 내용에서 레벨을 인식하는 기능의 선례다. 구체 판별 규칙은 공식 페이지에서 끝까지 확인하지 못했다 |
| S17 | [Elasticsearch ignore_malformed](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/ignore-malformed) | 타입이 맞지 않는 값은 기본적으로 문서 전체를 거부한다. `ignore_malformed`를 켜면 해당 필드만 건너뛰지만 객체와 스칼라 충돌은 여전히 거부한다 | 서비스마다 같은 이름을 다른 타입으로 쓰면 로그가 거부될 수 있어 Q02-05와 충돌한다. D17 탈락 조건으로 검증한다 |
| S18 | [ClickHouse JSON type](https://clickhouse.com/docs/reference/data-types/newjson) | 같은 경로에 여러 타입 값을 함께 저장할 수 있다. 경로 수와 타입 수에 상한 설정이 있다 | 타입 충돌 요구에 유리한 사실이다. 실제 비용은 미측정이다 |

## 4 조회와 데이터 정합성

| 근거 ID | 공식 자료 | 확인한 사실 | LogDock에 적용할 때의 경계 |
| --- | --- | --- | --- |
| S19 | [Elasticsearch paginate search results](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results) | refresh가 끼면 페이지 사이 결과가 달라질 수 있어 PIT를 쓴다. `search_after`에는 문서마다 유일한 tiebreaker가 필요하다 | 같은 시각 페이지 이동 계약의 근거다. LogDock 안은 PIT에 의존하지 않고 수신 기준 시점으로 고정한다 |
| S20 | [ClickHouse ReplacingMergeTree](https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree) | 중복 제거는 병합 때만 일어나고 부재를 보장하지 않는다. 읽을 때 정리하려면 FINAL이 필요하고 비용이 든다 | D06의 검색·집계 한 건 계약을 이 방식만으로 충족한다고 볼 수 없다 |
| S21 | [Loki components](https://grafana.com/docs/loki/latest/get-started/components/) | 시각과 본문이 직전 줄과 같으면 중복으로 무시한다 | 같은 밀리초에 같은 본문이 실제로 두 번 발생하면 D06의 별도 발생 구분과 충돌할 수 있다 |
| S22 | [Loki log retention](https://grafana.com/docs/loki/latest/operations/storage/retention/) | 보존은 Compactor가 처리하며 인덱스 참조를 지운 뒤 chunk를 비동기로 삭제한다 | Q13의 로그별 최초 수신 기준 만료를 지원하는지는 확인하지 못했다. D17 검증 항목이다 |
| S23 | [OWASP ReDoS](https://owasp.org/www-community/attacks/Regular_expression_Denial_of_Service_-_ReDoS), [Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html) | 입력이 정규식이 되면 백트래킹 엔진에서 처리 시간이 입력 크기에 지수적으로 늘 수 있다 | 정규식을 후속으로 두는 판단의 참고다. 안전한 엔진을 쓰면 위험은 줄지만 스캔 비용은 남는다 |

## 5 확인하지 못한 것

- Elasticsearch의 `case_insensitive`가 비ASCII 문자에 어떻게 동작하는지 공식 문서로 확인하지 못했다. 포럼에는 ASCII로 제한된다는 답변이 있다. 한글은 대소문자가 없어 영향이 없지만 키릴·그리스 문자에는 영향이 있어 D17에서 시험한다.
- Loki 자동 레벨 판별의 키 목록은 커뮤니티 글로만 확인했다.
- Loki와 ClickHouse, Elasticsearch가 수신 시각 기준 로그별 보존을 어떻게 구현할 수 있는지는 조사하지 않았다.
- 어떤 엔진도 설치·측정하지 않았으므로 성능 비교는 없다.
