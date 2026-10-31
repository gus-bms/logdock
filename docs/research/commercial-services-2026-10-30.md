# 상용 로그 관리 서비스 비교와 LogDock 설계 쟁점

기준일: 2026-10-30. 제품 조사이며 채택 명세나 구현 승인을 뜻하지 않는다.

- [문서 안내](../README.md)
- [기능 후보](../specs/product-features-v0.1.md)
- [결정 기록](../decisions.md)
- [당시 검토용 PDF](../artifacts/logdock-commercial-research-2026-10-30.pdf)

조사 당시의 설계 질문을 보존했다. 조사 이후 합의한 현재 상태는 결정 기록을 우선하며, Issue 관리 보류 등 후속 결정을 이 조사 문서의 미정 항목으로 되돌리지 않는다.

가격·플랜·preview 상태는 기준일의 공개 자료다. 후속 의사결정에서 변경 가능한 조건은 공식 출처로 다시 확인한다. 외부 화면 이미지의 권리는 해당 제공자에게 있으며 LogDock의 Apache 2.0 라이선스로 재허락하는 것으로 해석하지 않는다. PDF에는 당시 공식 이미지가 포함되어 있다.

2026년 10월 30일 기준 · 공개 자료와 공개 데모를 이용한 검토 자료

상용 수준의 로그 제품은 로그를 저장하고 나열하는 기능에 더해, 수집 신뢰도·검색의 완전성·권한·운영 비용·조사 상태의 연속성을 사용자에게 설명한다. LogDock의 설계는 이 제품 계약들을 먼저 합의한 뒤 기술 구성과 화면으로 구체화할 필요가 있다.

## 조사 범위

Datadog, Elastic Observability, Grafana Cloud Logs, Better Stack, Axiom, Sentry, SigNoz의 7개 제품을 비교했다. 수집·변환·저장·조회 API·UI/UX·조직/권한·운영/확장·가격/배포 조건을 확인했다. 공개 기능의 유무만으로 품질 점수를 만들지 않았다.

## 증거를 읽는 방법

| 표기 | 의미와 한계 |
| --- | --- |
| 공식 문서 | 벤더가 공개한 기능·계약·제한이다. 실제 고객 환경의 성능·손실률·SLA를 독립 실행한 증거는 아니다. |
| 공식 화면 | 문서에 실린 이미지를 실제로 관찰했다. 이미지 내부의 과거 데이터·버전은 현재 SaaS 동작을 입증하지 않는다. |
| 공개 데모 | Grafana Play와 Axiom Play를 직접 탐색했다. Elastic은 캡처 재생형 guided tour다. 수집·장애·권한·청구 검증으로 확대하지 않는다. |
| 설계 추론 | 조사에서 도출한 LogDock 논의 후보다. 승인된 명세·구현 계획·완료된 기능을 뜻하지 않는다. |

이 조사 단계에서는 LogDock 애플리케이션 코드·운영 서버를 변경하지 않았다. 신규 계정·수집 키·클라우드 리소스를 생성하거나 실제 운영 로그를 전송하지 않았다. 유료·인증 기능, 실제 수집/손실/HA/청구 검증은 미실행 범위다.

## 제품별로 무엇을 배울 수 있는가

| 제품 | 제품 모델과 주된 참고점 | 주의할 경계 |
| --- | --- | --- |
| Datadog | 대규모 로그 운영의 index/Flex/archive 분리, 권한·quota·탐색 동선 | 저장 방식마다 검색·알림 기능이 같지 않다. |
| Elastic | 수집 파이프라인·데이터 품질·전문 검색·분석의 깊이 | Hosted와 Serverless의 lifecycle·운영·가격 계약을 분리해야 한다. |
| Grafana Cloud | Loki 기반의 queryless 탐색, 서비스→필드→패턴→문맥 | OSS Loki, Grafana OSS, Cloud/Enterprise의 권한 기능이 같지 않다. |
| Better Stack | source 중심 연결과 운영자 친화적 Live tail·SQL·알림 연결 | 수집/보관/query boost/incident 좌석은 다른 과금 축이다. |
| Axiom | dataset 중심 typed query builder, Stream·상세·context와 실행 피드백 | 현행 loading/query-compute/storage 3축 가격을 봐야 한다. |
| Sentry | 로그와 trace를 문제 단위의 triage로 연결하는 개발자 UX | Logs, Errors, Issues, quota, query window는 서로 다른 개념이다. |
| SigNoz | OTel·ClickHouse 기반의 Cloud/self-host 관측 플랫폼 | Community/Enterprise/Cloud, beta/Coming Soon 범위를 분리해야 한다. |

비교 근거 [D4](https://docs.datadoghq.com/logs/explorer/) [E5](https://www.elastic.co/docs/solutions/observability/logs/discover-logs) [G1](https://grafana.com/docs/grafana/latest/visualizations/simplified-exploration/logs/) [B1](https://betterstack.com/docs/logs/logging-start/) [A5](https://axiom.co/docs/query-data/explore) [S1](https://docs.sentry.io/product/logs/) [Z1](https://signoz.io/docs/architecture/)

### 시장 조사에서 드러난 핵심

- 같은 오류를 잠시 묶어 보는 패턴 분석과, 담당자·해결 상태·회귀를 관리하는 Issue는 별도 제품 모델이다. [G3](https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/simplified-exploration/logs/patterns/) [S3](https://docs.sentry.io/product/drains/) [S5](https://docs.sentry.io/concepts/data-management/event-grouping/) [Z4](https://signoz.io/docs/userguide/exceptions/)

- 보존된 데이터, 빠르게 검색되는 데이터, 현재 플랜이 조회를 허용하는 시간 범위가 같지 않을 수 있다. [E2](https://www.elastic.co/docs/deploy-manage/deploy/elastic-cloud/project-settings) [S1](https://docs.sentry.io/product/logs/) [S2](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/)

- 검색 성공과 결과의 완전성, HTTP 성공과 개별 이벤트의 저장 성공도 분리해서 표현해야 한다. [D6](https://docs.datadoghq.com/api/latest/logs/) [A4](https://axiom.co/docs/restapi/endpoints/ingestToDataset)

- 멀티테넌시와 권한은 모든 조회·필드 목록·공유·알림·export 경로에서 이어져야 한다. 화면의 폴더나 서비스 필터 자체가 보안 경계는 아니다. [E8](https://www.elastic.co/docs/deploy-manage/users-roles/serverless-custom-roles) [E14](https://www.elastic.co/docs/deploy-manage/manage-spaces) [G11](https://grafana.com/docs/loki/latest/operations/authentication/) [G12](https://grafana.com/docs/loki/latest/operations/multi-tenancy/)

## Datadog Log Management

대규모 로그 운영의 관리 계층과 데이터 계층을 나누는 방식을 참고할 수 있다. SaaS 내부의 실제 replica 수나 물리적 tenant 분리는 공개 기능만으로 확정할 수 없다.

| 관점 | 공식 공개자료에서 확인한 내용 | 근거 |
| --- | --- | --- |
| 온보딩 | Agent·컨테이너·OTel 등의 경로를 제공하며 source별 parsing·multiline 설정이 필요하다. 에이전트 설치와 최초 로그 검색 성공을 같은 상태로 표시해서는 안 된다. | [D1](https://docs.datadoghq.com/logs/log_collection/) |
| 수집/변환 | 수집과 indexing을 분리한다. index quota를 넘으면 indexing은 중지해도 Live Tail과 archive 경로는 계속될 수 있어, 저장·검색 가능성의 상태가 갈린다. | [D2](https://docs.datadoghq.com/logs/log_configuration/indexes/) |
| 저장/보존 | Standard index, Flex, 외부 archive를 다른 상품·동작으로 다룬다. Flex에서는 monitors·Watchdog Insights가 지원되지 않는 조건이 있다. | [D8](https://www.datadoghq.com/pricing/?product=log-management) |
| 과거 검색 | Archive Search는 rehydrate 없이 scan·진행률·취소와 임시 결과를 제공한다. 집계·다른 제품의 분석·장기 결과 보존에는 rehydrate가 필요한 경계가 있다. | [D3](https://docs.datadoghq.com/logs/explorer/archive_search/) |
| 탐색 UX | 검색·시간·index·facet·histogram·결과 표와 상세 panel을 연결하고, 상세 필드에서 다시 필터링한다. 공식 화면 관찰이며 전체 최신 SaaS 시나리오를 실행한 것은 아니다. | [D4](https://docs.datadoghq.com/logs/explorer/) [D5](https://docs.datadoghq.com/logs/explorer/side_panel/) |
| API/권한 | 공개 검색 API는 cursor와 timeout/partial 상태를 포함한다. restriction query·여러 role의 합집합, archive/rehydration 별도 권한을 고려해야 한다. | [D6](https://docs.datadoghq.com/api/latest/logs/) [D7](https://docs.datadoghq.com/logs/guide/logs-rbac-permissions/) |
| 오류/운영 | backend error grouping은 별도 모델이다. Agent 수집계 관측과 데이터 검색 성공은 다른 신호이며, 내부 HA/RPO/RTO·일반 query 취소 계약은 미확인이다. | [D9](https://docs.datadoghq.com/logs/error_tracking/error_grouping/) [D11](https://docs.datadoghq.com/data_security/agent/) |

## Elastic Observability

Elastic Cloud Hosted와 Observability Serverless를 구분했다. 공개 문서, 공식 이미지, 실제 선택 지역을 고정한 동적 가격표와 guided tour를 근거로 했다.

| 관점 | 공식 공개자료에서 확인한 내용 | 근거 |
| --- | --- | --- |
| 온보딩 | Elastic Agent/Fleet, Filebeat, OTel, Logstash 경로가 있다. Filestream은 JSON·multiline 순서와 파일 식별 상태가 중요하며, input 전환 시 기존 offset 처리도 계약이다. | [E3](https://www.elastic.co/docs/reference/integrations/filestream) |
| 데이터 품질 | 실패 문서와 일부 field가 무시된 degraded 문서를 나누고, failure store의 sample로 파이프라인을 수정한다. 수정은 과거 실패 데이터를 자동 replay하지 않는다. | [E4](https://www.elastic.co/docs/solutions/observability/streams/manage-data-quality) |
| 저장/보존 | Hosted의 ILM 계층과 Serverless data-stream lifecycle은 다르다. Serverless retention은 최소 보존 의미이며 즉시 삭제 시각 보장이 아니다. | [E2](https://www.elastic.co/docs/deploy-manage/deploy/elastic-cloud/project-settings) |
| 탐색 UX | Discover의 field 탐색·histogram·문서 표·상세·stacktrace·유사 오류와 Streams 연결이 참고점이다. guided tour는 과거 캡처 재생형으로 최신 실환경 성능 증거가 아니다. | [E5](https://www.elastic.co/docs/solutions/observability/logs/discover-logs) [E12](https://www.elastic.co/demo-gallery/observability) |
| API | deep paging은 PIT와 결정적 sort/search_after를 고려한다. async search는 실행 중/부분 결과/만료 상태가 있다. 모든 API의 Serverless 제공 범위는 따로 대조해야 한다. | [E6](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results) [E7](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-async-search-get) |
| 권한 | index/field/document 수준 권한과 Kibana 기능 권한을 나눈다. role은 합집합이며 Space의 기능 노출 설정만으로 데이터 접근을 제한할 수 없다. | [E8](https://www.elastic.co/docs/deploy-manage/users-roles/serverless-custom-roles) [E14](https://www.elastic.co/docs/deploy-manage/manage-spaces) |
| 확장/보안 | Observability 검색용량은 search-ready 데이터량 기준이며 query load 자체로 자동확장되지 않는다. Serverless SAML과 Hosted SAML의 플랜 조건도 다르다. | [E2](https://www.elastic.co/docs/deploy-manage/deploy/elastic-cloud/project-settings) [E13](https://www.elastic.co/docs/deploy-manage/users-roles/cloud-organization/configure-saml-authentication) |
| 가용성 | 문서는 성공 write 전 지역 object storage 내구성, node/AZ 실패 RPO0을 설명한다. single-region이며 자동 지역 failover가 아니다. 실제 장애·복구 시험은 하지 않았다. | [E9](https://www.elastic.co/docs/deploy-manage/production-guidance/availability-and-resilience/resilience-in-serverless) |

## Grafana Cloud Logs와 Loki

Loki 엔진의 공개 구조와 Grafana의 제품 UX, Cloud/Enterprise의 관리 기능을 구분해야 한다. Grafana Play는 로그인 없이 직접 탐색했다.

| 관점 | 공식 공개자료에서 확인한 내용 | 근거 |
| --- | --- | --- |
| 온보딩 | 서비스·환경 등 안정적인 metadata를 수집기에 부여하고, 읽기/쓰기 목적의 access policy scope를 분리한다. 실제 수집기 설치·수집 성공은 실행하지 않았다. | [G4](https://grafana.com/docs/grafana-cloud/platform/security-and-account-management/security-and-access/authentication-and-permissions/access-policies/) |
| 엔진 | Loki write path는 distributor가 stream을 replicas에 보내고 quorum ACK를 기다리는 구조를 설명한다. read path는 query frontend·scheduler·querier·object store 책임으로 나뉜다. | [G9](https://grafana.com/docs/loki/latest/get-started/architecture/) [G13](https://grafana.com/docs/loki/latest/get-started/components/) |
| 탐색 UX | 서비스별 volume→로그/라벨/field/pattern 탭으로 탐색한다. 고급 LogQL로 이어질 수 있다. 원문·표·JSON 표시와 상세·앞뒤 context를 문서화한다. | [G1](https://grafana.com/docs/grafana/latest/visualizations/simplified-exploration/logs/) [G2](https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/simplified-exploration/logs/view-logs/) |
| 패턴 | 패턴은 최근 3시간에서 얻는 ephemeral 결과다. 장기적인 Issue 처리 상태와 같지 않다. pattern ingester 설정이 필요하며 include/exclude 동선이 있다. | [G3](https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/simplified-exploration/logs/patterns/) |
| API | query_range는 시간·limit·정렬 방향과 nanosecond timestamp 문자열을 사용한다. 앱 수준의 동일 시각 경계 paging·문맥 식별 계약은 별도 설계가 필요하다. | [G10](https://grafana.com/docs/loki/latest/reference/loki-http-api/) |
| 권한 | tenant ID는 X-Scope-OrgID로 전달하지만 Loki 자체 일반 사용자 인증은 별도 경계다. Cloud access policy와 team LBAC는 OSS 기본 기능으로 일반화하면 안 된다. | [G4](https://grafana.com/docs/grafana-cloud/platform/security-and-account-management/security-and-access/authentication-and-permissions/access-policies/) [G5](https://grafana.com/docs/grafana/latest/administration/data-source-management/teamlbac/) [G11](https://grafana.com/docs/loki/latest/operations/authentication/) [G12](https://grafana.com/docs/loki/latest/operations/multi-tenancy/) |
| 운영/비용 | 처리·기록·보존·쿼리를 분리해 청구한다. Adaptive Logs의 cloud-side drop과 collector-side drop은 위치·기능 상태가 다르므로 관측 및 비용 결과가 다르다. | [G6](https://grafana.com/docs/grafana-cloud/platform/pricing-and-usage/logs/) [G8](https://grafana.com/docs/grafana-cloud/observe-and-act/adaptive-telemetry/adaptive-logs/introduction/) |

## Better Stack Logs

source를 연결·변환·보관·권한의 사용 단위로 다루고 Live tail과 분석 SQL을 연결한다. 직접 제품 실행은 하지 않았고 공식 UI 이미지와 문서를 확인했다.

| 관점 | 공식 공개자료에서 확인한 내용 | 근거 |
| --- | --- | --- |
| 온보딩 | source 이름·플랫폼 선택 뒤 token/ingest host와 테스트 이벤트를 제공한다. 파일과 컨테이너 수집은 Collector·Vector 설정 경로로 지원한다. | [B1](https://betterstack.com/docs/logs/logging-start/) |
| 실패/유실 | Collector의 기본 buffer-full은 drop_newest이고 기본 line limit은 8KiB다. HTTP request의 10MiB 상한과 다르며, 수집기별 경계를 함께 봐야 한다. | [B2](https://betterstack.com/docs/logs/api/create-a-collector/) [B7](https://betterstack.com/docs/logs/ingesting-data/http/logs/) |
| 파이프라인 | VRL parse·rename·filter·redact를 미리 시험할 수 있다. runtime 오류 시 원문과 오류 metadata를 보존하는 동작이 있다. 마스킹 실패에도 원문을 저장할지는 LogDock의 별도 결정이다. | [B3](https://betterstack.com/docs/logs/using-logtail/transforming-ingested-data/logs-vrl/) |
| 저장/과거 | ClickHouse SQL에서 recent/historical 경로를 합쳐 조회하는 예제를 제공한다. 고객 bucket의 copy 보존과 서비스 내 검색 가능 기간은 서로 다르다. | [B5](https://betterstack.com/docs/logs/query-api/connect-remotely/) [B6](https://betterstack.com/docs/logs/host-data-in-your-own-bucket/) |
| 탐색/알림 | Live tail 검색 언어와 분석용 SQL을 구분한다. source·시간·histogram·표·표시 밀도 설정이 보이며, 알림은 지속·회복·no-data 정책을 따로 둔다. | [B4](https://betterstack.com/docs/logs/using-logtail/live-tail-query-language/) [B8](https://betterstack.com/docs/logs/dashboards/alerts/) |
| API | standard SQL 동시성은 logs 4/metrics 20으로 문서화된다. time-order LIMIT 예제는 있지만 stable event cursor·서버 취소의 전체 계약은 미확인이다. | [B5](https://betterstack.com/docs/logs/query-api/connect-remotely/) |
| 조직/운영 | team role과 source ingest token·관리 API token·SQL 조회 자격을 나눈다. custom role/SSO/audit 조건은 상품별이다. SaaS 물리 HA/RPO/RTO는 미확인이다. | [B10](https://betterstack.com/docs/uptime/audit-logs/) [B11](https://betterstack.com/docs/uptime/team-management/manage-roles/) |

## Axiom

dataset 중심의 EventDB와 typed Builder/Editor, Stream 탐색을 제공한다. 공개 Play에서 원문·상세·context와 샘플 집계를 직접 확인했다.

| 관점 | 공식 공개자료에서 확인한 내용 | 근거 |
| --- | --- | --- |
| 온보딩 | dataset의 kind·retention·edge를 정하고 ingest 권한 token을 연결한다. OTel·Vector·Fluentd 등의 경로와 agent/aggregator/hybrid 구성을 공개한다. | [A1](https://axiom.co/docs/reference/datasets) [A2](https://axiom.co/docs/send-data/reference-architectures) |
| 저장/쿼리 | EventDB는 columnar object-storage 구조와 WAL·query workers·pushdown을 설명한다. 공개 설명을 ClickHouse 기반이라고 바꿔 해석할 근거는 없다. | [A3](https://axiom.co/docs/platform-overview/architecture) |
| 부분 실패 | event ingest의 HTTP 200에도 개별 event 실패가 있을 수 있다. transport status 하나로 전체 batch 성공을 판정할 수 없다. | [A4](https://axiom.co/docs/restapi/endpoints/ingestToDataset) |
| 탐색 UX | Stream의 pause/resume, 이벤트 우측 Properties/Raw, field filter, context의 선택 행과 앞뒤 이벤트를 직접 확인했다. Builder와 Editor의 표현 가능 범위가 UX 계약이다. | [A5](https://axiom.co/docs/query-data/explore) [A6](https://axiom.co/docs/query-data/stream) [A13](https://play.axiom.co/) |
| API/비용 | cursor pagination은 public preview이며 문서는 timestamp 방식을 권한다. token·조직별 query cost cap과 429가 있어, 수집과 검색의 비용 제한 동작도 다르다. | [A9](https://axiom.co/docs/restapi/pagination) [A10](https://axiom.co/docs/console/intelligence/query-cost-limits) |
| 권한 | 조직 기능과 dataset의 ingest/query/share 권한을 분리한다. role 합집합과 PAT/목적별 token을 구분하며 token expiry·scope가 중요하다. | [A7](https://axiom.co/docs/reference/settings) [A8](https://axiom.co/docs/reference/tokens) |
| 운영 경계 | loading·storage·query를 따로 scale하는 공개 설명은 있다. 실제 HA/성능·cross-region query failover와 서버 cancellation은 이번 조사에서 입증하지 않았다. | [A3](https://axiom.co/docs/platform-overview/architecture) |

## Sentry Logs와 Issues

로그 탐색과 오류 이슈 관리의 차이를 가장 명확하게 보여주는 참고 대상이다. 공개 문서·가격·공식 이미지로 확인했고 실제 수집·SaaS 데모 실행은 완료하지 못했다.

| 관점 | 공식 공개자료에서 확인한 내용 | 근거 |
| --- | --- | --- |
| 수집 | SDK 로그와 OTel forwarding·platform drains가 있다. PHP의 request/job-end flush와 long-running CLI flush는 수집 신뢰도와 관련된다. | [S4](https://docs.sentry.io/platforms/php/logs/) |
| 제품 경계 | drains로 전달한 로그가 자동 error issue가 되는 것은 아니다. Issues는 fingerprint·stacktrace·exception/message 등을 활용해 문제 단위로 묶는 별도 모델이다. | [S3](https://docs.sentry.io/product/drains/) [S5](https://docs.sentry.io/concepts/data-management/event-grouping/) |
| 검색/보존 | Logs 문서는 query window를 Developer 7일/Team 14일/Business 30일로, 보안 문서는 Logs retention을 전 플랜 30일로 기재한다. 개념 범위 또는 문서 갱신 차이는 실계정 확인이 남는다. | [S1](https://docs.sentry.io/product/logs/) [S2](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/) |
| UX/완전성 | 특정 조건에서 추가 scan이 필요할 수 있고 큰 볼륨 chart는 표본 추정이다. auto-refresh 중지 조건도 있어 빈 목록·샘플·검색 완료·실시간 상태를 구분해야 한다. | [S1](https://docs.sentry.io/product/logs/) |
| API | Explore events는 rows와 type/unit metadata를 제공하고 per_page 상한과 opaque cursor가 있다. 전체 export 용도와 같은 계약으로 보면 안 된다. | [S6](https://docs.sentry.io/api/explore/query-explore-events-in-table-format/) [S7](https://docs.sentry.io/api/pagination/) |
| 권한 | organization/team/project와 SSO 조건을 구분한다. ingest DSN/공개 ingest key와 query bearer token은 권한이 다르다. 현재 audit 전체 범위와 로그 scrub 효과는 미확인이다. | [S8](https://docs.sentry.io/organization/authentication/sso/) |
| 공개 구조 | 공개 아키텍처의 error event flow에는 Relay/Kafka/processing/Snuba/ClickHouse가 있다. 이 일반 도식을 현재 Logs SaaS의 모든 내부 구현으로 단정하지 않는다. | [S11](https://develop.sentry.dev/application-architecture/overview/) |
| 배포/라이선스 | 최신 self-host 소스의 FSL Fair Source와 SaaS 운영 모델을 구분한다. UX 패턴을 연구하는 것과 Apache 프로젝트에 코드를 재사용하는 것은 별도 검토다. | [S10](https://develop.sentry.dev/self-hosted/) |

## SigNoz Cloud와 Self-host

OTel Collector와 ClickHouse 기반으로 API와 React 화면을 연결하는 공개 구조가 있다. Community·Enterprise·Cloud와 beta/Coming Soon 상태를 구분했다.

| 관점 | 공식 공개자료에서 확인한 내용 | 근거 |
| --- | --- | --- |
| 수집 | filelog의 newline별 record와 multiline 설정을 구분한다. receiver에서 경계를 정하고 flush 시점을 관리해야 한다. PHP/PM2 계측 가이드는 tracing일 수 있어 로그 수집 성공으로 간주할 수 없다. | [Z2](https://signoz.io/docs/userguide/parse-multiline-logs/) |
| 변환 | ordered pipeline과 processor가 parse/enrich/transform을 수행한다. 앞 단계에서 변경한 값이 뒤 pipeline의 filter 입력이므로 순서와 rule version이 데이터 계약이다. | [Z3](https://signoz.io/docs/logs-pipelines/introduction/) |
| 저장/보존 | Collector→ClickHouse→SigNoz API/React 구조다. 신호별 TTL과 Cloud 보존 변경 경로가 있으며 설정 변경의 소급 여부도 확인해야 한다. | [Z1](https://signoz.io/docs/architecture/) [Z14](https://signoz.io/docs/userguide/retention-period/) |
| 탐색/예외 | 로그 상세에 Overview/Context/Metrics와 전후 행 로딩이 있다. Exceptions 목록은 trace span event에서 생성되며 log record를 소비하지 않는다. | [Z4](https://signoz.io/docs/userguide/exceptions/) [Z11](https://signoz.io/docs/userguide/logs_query_builder/) |
| API | query는 offset/limit과 timestamp+id 정렬을 문서화한다. query 시간은 ms, HTTP ingest 시간은 ns일 수 있어 API 경계의 단위를 엄격히 다뤄야 한다. | [Z5](https://signoz.io/docs/logs-management/logs-api/search-logs/) [Z6](https://signoz.io/docs/logs-management/logs-api/payload-model/) |
| 권한 | Cloud ingest key는 write-only다. 세밀한 telemetry IAM은 Cloud/Enterprise beta query gate이며 자동 row filter가 아니다. unrestricted role 합집합을 주의해야 한다. | [Z7](https://signoz.io/docs/manage/administrator-guide/iam/user-guides/scope-telemetry-access-by-ingestion-key/) [Z13](https://signoz.io/docs/ingestion/signoz-cloud/keys/) |
| 운영/한도 | 일별 key 한도를 넘으면 다음 UTC 자정까지 영구 drop하는 비용 제어 정책이 있다. 비용 상한과 delivery 보장은 별개다. 전체 Cloud/self-host HA는 독립 실행하지 않았다. | [Z12](https://signoz.io/docs/cost-control/ingestion-limits/) |
| edition/라이선스 | Google OAuth는 Community도 지원하지만 SAML/OIDC는 Cloud/Enterprise 조건이다. core MIT와 enterprise 디렉터리 라이선스를 나누며 audit/multi-tenancy 등의 Coming Soon을 완료 기능으로 세지 않았다. | [Z8](https://signoz.io/docs/manage/administrator-guide/sso/overview/) [Z9](https://signoz.io/pricing/) [Z10](https://github.com/SigNoz/signoz/blob/main/LICENSE) |

## UI와 UX를 읽는 기준

제품의 시각적 완성도와 함께, 조사 중인 상태가 끊기지 않는지를 봐야 한다. 아래는 실제 공개 데모에서 확인한 동선과 문서 기반 동선을 나눈 것이다.

| 제품 | 확인한 수준 | 직접 확인 또는 공개 화면의 흐름 |
| --- | --- | --- |
| Grafana | 공개 live demo | 서비스별 volume→서비스 로그→필터/탭→Query details의 처리량·시간→패턴 목록과 include/exclude. 패턴 목록에는 일부 필터 미지원 안내가 있었다. |
| Axiom | 공개 live demo | dataset Stream→pause→이벤트 우측 상세→context의 선택 행·전후 이벤트→샘플 집계 chart→Builder 전환. |
| Elastic | guided tour + 공식 이미지 | Discover 검색→컬럼 표→log spike→대시보드의 안내 경로. 오래된 캡처 재생형이라 최신 실 query 처리 검증은 아니다. |
| Datadog / Better Stack | 공식 이미지 | 검색·시간·facet/source·histogram·표·상세·표시 밀도와 저장 동선의 배치를 확인. 실제 서비스의 동작은 미실행. |
| Sentry / SigNoz | 공식 이미지 + 문서 | 구조화 필터·count/threshold와 로그 상세 Context 구조. 라이브 demo 접근은 완료하지 못했다. |

관련 근거 [G14](https://play.grafana.org/a/grafana-lokiexplore-app/explore) [A13](https://play.axiom.co/) [E12](https://www.elastic.co/demo-gallery/observability) [D4](https://docs.datadoghq.com/logs/explorer/) [B4](https://betterstack.com/docs/logs/using-logtail/live-tail-query-language/) [S1](https://docs.sentry.io/product/logs/) [Z11](https://signoz.io/docs/userguide/logs_query_builder/)

### 동일하게 보이는 필터의 의미도 확인해야 한다

Grafana Play의 패턴 목록은 라벨·level 중심이며 parsed field·structured metadata·문자열 필터가 목록 자체에는 적용되지 않는 안내를 표시했다. LogDock에서 화면을 전환할 때는 적용 가능한 조건과 제외된 조건을 숨기지 않아야 한다. 이는 실제 관찰에서 도출한 설계 쟁점이며 해당 기능을 복제한다는 뜻은 아니다. [G3](https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/simplified-exploration/logs/patterns/) [G14](https://play.grafana.org/a/grafana-lokiexplore-app/explore)

### 읽기와 쓰기를 구분하는 UX

저장된 탐색, URL 공유, alert 생성은 단순 조회와 권한·수명·실패 계약이 다르다. Axiom Play에서 disabled된 저장 기능은 실행하지 않았다. 같은 화면의 취소 버튼도 상위 서버 작업을 실제 취소한다는 증거로 보지 않았다.

## 공식 화면 사례 검색에서 상세로

![공식 화면 사례](https://docs.dd-static.net/images/logs/explore.b937574cd932232459c1c5746146a353.png)

Datadog 공식 문서 캡처. 출처: docs.datadoghq.com/logs/explorer/. 문서 이미지 관찰이며 현재 계정으로 검색을 실행한 증거는 아니다. [D4](https://docs.datadoghq.com/logs/explorer/)

### 관찰할 구성

- 탐색 전체를 지배하는 시간·검색·대상 선택과, 결과를 좁히는 facet을 구분한다.

- histogram과 결과 목록이 같은 조건을 공유하고, 상세 속성에서 다시 탐색 조건으로 돌아간다.

- 저장·공유·알림으로 이동해도 탐색 조건과 권한을 이어받는지가 제품 완성도의 기준이다.

위 항목은 화면과 공개 기능을 토대로 한 LogDock 설계 논점이다. 실제 앱의 DOM·가상화 라이브러리·상태 관리 구현을 역추정하지 않았다.

## 공식 화면 사례 원문에서 주변 문맥으로

![공식 화면 사례](https://d3nu8xzr1i9u95.cloudfront.net/web/img/docs/logs-management/ui/logs-detail-drawer-context.webp)

SigNoz 공식 로그 상세 Context 캡처. 출처: SigNoz Logs Query Builder 문서. 선택 로그 강조와 앞뒤 로딩 구조를 관찰했다. 현재 서비스 직접 실행 검증은 아니다. [Z11](https://signoz.io/docs/userguide/logs_query_builder/)

### 상세 화면이 해결해야 할 일

- 선택한 이벤트의 위치를 유지하면서 원문·정규화 필드·앞뒤 이벤트를 볼 수 있어야 한다.

- 인접 시간의 이벤트와 같은 요청/trace의 이벤트는 다른 관계다. 연결 기준과 필터 상속 범위를 표시해야 한다.

- 앞뒤를 더 불러오는 경계, 데이터 만료, 접근 권한 차이, multiline/긴 JSON의 표시를 설계해야 한다.

## 가격 비교는 단위와 기능 조건을 함께 본다

아래는 2026-10-30 공개표의 USD 표시를 요약한 것이다. 실제 사용량 견적이 아니며 세금·환율·계약 할인은 계산하지 않았다. 서로 다른 과금 단위를 GB 한 값으로 순위화하지 않았다.

| 제품 | 공개 가격·단위 | 비교에서 놓치기 쉬운 조건 | 근거 |
| --- | --- | --- | --- |
| Datadog | ingest 시작 $0.10/GB. Standard 15일 index $1.70/백만 event·월(연간 결제), on-demand $2.55. archive scan/Flex compute 등 별도. | GB와 event·보존·scan이 섞인다. 고객 object storage/transfer와 부가 보안 기능의 비용도 따로 본다. | [D8](https://www.datadoghq.com/pricing/?product=log-management) [D3](https://docs.datadoghq.com/logs/explorer/archive_search/) |
| Elastic | AWS us-east-1 Serverless: 첫 0-1,500GB ingest Essentials $0.35/GB, Complete $0.50. 첫 보관 0-10,000GB-month $0.036/$0.040. | 한국 리전 견적이 아니다. per-project, fully enriched normalized uncompressed ingest 기준이다. | [E10](https://cloud.elastic.co/cloud-pricing-table?productType=serverless&solution=observability&provider=aws&region=us-east-1) [E11](https://www.elastic.co/docs/deploy-manage/cloud-organization/billing/elastic-observability-billing-dimensions) |
| Grafana Cloud | Pro $19/월+사용량. 시작 단가 process $0.050/GB, write $0.400/GB, retain $0.100/GB. 공개 포함량·기본 보존 조건 존재. | query는 written volume 대비 fair use 100배 초과 시 별도 청구. 처리와 저장 후 감소량이 다르다. | [G6](https://grafana.com/docs/grafana-cloud/platform/pricing-and-usage/logs/) [G7](https://grafana.com/pricing/) |
| Better Stack | ingest $0.10/GB + retained $0.05/GB·월. standard query 포함, boost $0.001/GB scanned. Nano 지역별 묶음 시작가 존재. | on-call responder 좌석과 Telemetry 좌석, own bucket 요금은 구분한다. | [B9](https://betterstack.com/pricing) [B6](https://betterstack.com/docs/logs/host-data-in-your-own-bucket/) |
| Axiom | Cloud $25/조직·월, loading 1TB·query 100GB-hour·compressed storage 100GB 포함. 초과 시작 $0.12/GB·$0.20/GB-hour. | loading, query-compute, compressed storage와 RBAC/SSO 등의 조직 add-on이 다른 축이다. | [A11](https://axiom.co/pricing/llms.txt) [A12](https://axiom.co/pricing) |
| Sentry | Team $26/월, Business $80/월은 연간 결제·기본 prepaid 조건. Logs 5GB/월 포함, 유료 플랜 초과 $0.50/GB. | errors/spans/logs 등 별도 quota. 보관 기간과 플랜 query window를 분리한다. | [S9](https://sentry.io/pricing/) [S1](https://docs.sentry.io/product/logs/) [S2](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/) |
| SigNoz | Teams 최소 $49/월($49 usage 포함). logs/traces $0.30/GB, 15일 보관 기준. Enterprise 별도 조건. | 무료 self-host도 인프라·백업·업그레이드 비용이 있다. 가격표의 Coming Soon을 현재 기능으로 읽지 않는다. | [Z9](https://signoz.io/pricing/) |

### LogDock에 남는 질문

수집 bytes·accepted/rejected event·실제 보관량·scan/실행 비용·보존 기간을 어떻게 측정하고 공개할 것인가. spend cap에 도달했을 때 수집 중단, 영구 drop, 저장 유지, query 차단 중 어떤 동작을 할 것인가. 이는 요금표보다 먼저 정할 운영 계약이다.

## 아키텍처 논의 1 제품 객체와 경계

다음은 조사에서 도출한 논의 초안이다. 기술 스택이나 기능 범위를 확정한 명세가 아니다. service/source/dataset/server/tenant를 하나의 이름으로 합치면 권한·보존·비용 모델이 뒤엉킬 수 있다.

| 객체 | 책임과 결정해야 할 구분 |
| --- | --- |
| 조직/tenant | 데이터 소유·접근·과금의 경계. UI의 조직 선택과 backend의 강제 scope를 연결한다. |
| project/workspace | 운영팀의 탐색·협업 범위가 필요한지 결정한다. tenant와 같은 경계인지 별도인지 정의한다. |
| source | 수집 endpoint/key, parser, 기대 metadata, 마지막 수신·오류와 같은 온보딩/운영 객체. |
| service / server | 로그가 나온 애플리케이션과 인스턴스의 의미다. 한 service가 여러 source와 server에 걸칠 수 있다. |
| dataset/storage scope | 보존·색인·query scope를 어디에 적용할지 결정한다. source와 일대일이라고 가정하지 않는다. |
| event / issue | 원문 이벤트와 fingerprint로 묶인 문제 상태를 구분한다. issue 생성/회귀/해결 정책은 별도 제품 계약이다. |
| saved view / share | 조건·열·정렬의 저장과 결과 snapshot·공유 권한을 구분한다. URL이 인증을 대체하지 않도록 한다. |
| alert / delivery | rule, 평가 상태, group별 instance, 알림 전송·재시도·중복 방지를 별도 책임으로 본다. |

객체 차이의 시장 근거 [A1](https://axiom.co/docs/reference/datasets) [A7](https://axiom.co/docs/reference/settings) [B1](https://betterstack.com/docs/logs/logging-start/) [D2](https://docs.datadoghq.com/logs/log_configuration/indexes/) [S3](https://docs.sentry.io/product/drains/) [S5](https://docs.sentry.io/concepts/data-management/event-grouping/) [Z4](https://signoz.io/docs/userguide/exceptions/)

### 조직별 설정이 코어로 들어오는 경로

source key가 소속 조직·허용 데이터 범위를 결정하고, 서비스명·파일 경로·parser 규칙은 배포 설정으로 관리하는 구조를 검토할 수 있다. 인증된 자격에서 tenant scope를 결정하고 사용자 입력 tenant/header/label과의 불일치를 거부하는 경계를 검토해야 한다. [G11](https://grafana.com/docs/loki/latest/operations/authentication/) [G12](https://grafana.com/docs/loki/latest/operations/multi-tenancy/) [Z13](https://signoz.io/docs/ingestion/signoz-cloud/keys/)

## 아키텍처 논의 2 수집과 조회 운영을 분리한다

| 영역 | 제품 책임 | 설계 검토의 핵심 |
| --- | --- | --- |
| 수집 경로 | receiver, source 인증, metadata, multiline, parsing, redaction, queue, routing | ACK가 어느 내구성 지점을 뜻하는지, 부분 실패·중복·유실의 이유와 재처리 가능 여부 |
| 로그 저장/검색 | 색인 또는 column/object storage, 보존, query execution, 집계, context | 저장과 검색 가능한 기간, scan budget, 계층 이동, 삭제 및 query semantics |
| 관리 계층 | 조직·사용자·역할, source/key, 정책, saved view, alert, audit, usage | 로그 엔진과 별도의 상태·수명·권한이 필요한 객체가 무엇인지 |
| 조회 API 계층 | scope 검증, query validation, 엔진 호출, job/cursor, 결과 metadata | raw query의 권한 우회, 페이지 경계, 취소 전파, timeout/partial 계약 |
| 프런트엔드 | 탐색 상태, 가상 목록/표, 상세/context, live/pause, 공유·저장 | 오래된 요청 응답, selection/scroll 유지, 결과의 완전성·신선도 표시 |

공개 아키텍처 근거 [G9](https://grafana.com/docs/loki/latest/get-started/architecture/) [A3](https://axiom.co/docs/platform-overview/architecture) [S11](https://develop.sentry.dev/application-architecture/overview/) [Z1](https://signoz.io/docs/architecture/)

### 배포 단위는 논리 책임과 별도로 결정한다

독립적인 책임을 정의했다고 모두 별도 microservice로 배포해야 하는 것은 아니다. 관리 API·조회 실행·수집·알림의 독립 확장과 장애 격리가 어디서 필요한지 부하·보안·운영 능력으로 판단해야 한다. 복제된 object storage를 사용해도 앱 API·query frontend·alert worker·metadata 상태까지 자동으로 HA가 되지는 않는다.

### 엔진 후보는 workload로 검증한다

Loki의 label/time 중심 모델, Elasticsearch의 검색·집계 모델, ClickHouse 기반 columnar 분석 모델은 색인·권한·보존·API 비용 계약이 다르다. 엔진 어댑터 하나만 두면 모든 기능이 같아진다고 가정하지 않는다. 필요한 기능과 구현 가능한 기능을 명시하는 capability 경계부터 논의할 필요가 있다. [G10](https://grafana.com/docs/loki/latest/reference/loki-http-api/) [E6](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results) [B5](https://betterstack.com/docs/logs/query-api/connect-remotely/) [Z5](https://signoz.io/docs/logs-management/logs-api/search-logs/)

## 백엔드 논의 조회 API와 데이터 계약

| 계약 | 서비스 수준에서 검토할 내용 |
| --- | --- |
| query 의미 | 정규화된 filter/query 모델, field type, 허용 operator, regex·raw query 정책, 현재 view가 지원하는 기능 |
| scope | 조직·source·service 권한을 검색, histogram, facet, context, export, 공유, alert 평가 모두에 적용 |
| 시간 | event time/observed time/ingest time 구분, API 단위(ns/ms), UTC 저장과 표시 timezone, clock skew/late event |
| 페이지 | 정렬 방향과 안정적 tie-break, 고정 시간 범위 또는 snapshot, 동일 timestamp·late arrival·삭제/만료의 경계 |
| job/취소 | 진행률·부분 결과·만료, client abort와 서버 작업 취소 구분, cancel의 소유권과 자원 반환 |
| 실행 예산 | 기간/행/field/scan/time/concurrency 한도, tenant별 공정성, 429와 Retry-After, retry 가능한 오류 구분 |
| 응답 metadata | scan 범위·returned/matched·완료/부분/표본·최종 데이터 시각, warning과 제한 사유를 결과와 함께 반환 |
| 내구성 | 원문·정규화·schema/rule version·parse status, 전송 성공과 event별 저장 성공의 차이 |

계약 사례 [D6](https://docs.datadoghq.com/api/latest/logs/) [E6](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results) [E7](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-async-search-get) [A4](https://axiom.co/docs/restapi/endpoints/ingestToDataset) [A9](https://axiom.co/docs/restapi/pagination) [S6](https://docs.sentry.io/api/explore/query-explore-events-in-table-format/) [S7](https://docs.sentry.io/api/pagination/) [Z5](https://signoz.io/docs/logs-management/logs-api/search-logs/) [Z6](https://signoz.io/docs/logs-management/logs-api/payload-model/) [O1](https://opentelemetry.io/docs/specs/otel/logs/data-model/)

### 같은 timestamp의 다음 페이지

예를 들어 동일 시각에 3개 이벤트가 있는데 페이지 한도가 2개라면, 다음 페이지를 단순히 timestamp+1로 시작하면 나머지 1개가 빠질 수 있다. 같은 시각을 포함하면 반복·중복 경계를 해결해야 한다. 엔진의 stable ID·PIT·tie-break 또는 재조회 규칙을 검증해야 한다는 추론이며 특정 벤더의 결함 판정은 아니다.

Loki의 ns timestamp 문자열과 프런트엔드 정밀도도 함께 다뤄야 한다. ns epoch를 JavaScript Number로 무조건 변환하는 정책은 정밀도 계약을 잃을 수 있다. [G10](https://grafana.com/docs/loki/latest/reference/loki-http-api/)

## 프런트엔드 논의 탐색 상태와 비정상 상태

아래 항목은 외형의 화면 목록보다 먼저 검토할 상호작용 계약이다. 실제 벤더의 React 상태관리 코드나 가상화 라이브러리는 공개 근거 없이 특정하지 않았다.

| 영역 | 검토할 상태·동작 |
| --- | --- |
| 하나의 탐색 상태 | source·time·timezone·query·filters·sort·columns·view를 일관된 모델로 다룬다. URL과 저장 뷰로 재현 가능한 범위를 정한다. |
| Builder/Editor | 지원 범위를 명시한다. Editor에서 Builder로 돌아올 때 표현할 수 없는 조건의 손실·변형·읽기 전용 상태를 설계한다. |
| 요청 경쟁 | 이전 요청이 늦게 도착해 새 조건의 결과를 덮지 않도록 query identity와 취소/폐기 정책을 정의한다. |
| 목록·상세 | 가상 스크롤·긴 message·다중행·JSON에서 선택 행과 scroll anchor를 유지한다. 상세 열기/닫기로 탐색 문맥을 잃지 않게 한다. |
| Live | 조회와 stream 상태를 구분한다. pause, 재개 지점, 새 이벤트 수, 누락·표본·rate limit과 현재 화면의 신선도를 설명한다. |
| 결과의 의미 | 아직 미수집, 정상 0건, scan 미완료, 권한 제한, 기간 만료, index 제외, 일부 실패, 표본 추정, 오래된 결과를 구별한다. |
| 접근성 | 키보드 탐색·focus 복원·선택 상태·resize·반응형·색 이외의 severity 표시를 확인한다. 벤더별 실제 a11y 성능은 미실행이다. |
| 공유/복사 | 사용자가 권한 있는 데이터만 본다는 보장을 유지하고, URL·clipboard·export에 비밀 값이나 불필요한 원문이 들어가는 경로를 검토한다. |

관련 UX 근거 [G2](https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/simplified-exploration/logs/view-logs/) [G3](https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/simplified-exploration/logs/patterns/) [A5](https://axiom.co/docs/query-data/explore) [A6](https://axiom.co/docs/query-data/stream) [S1](https://docs.sentry.io/product/logs/) [E5](https://www.elastic.co/docs/solutions/observability/logs/discover-logs) [D5](https://docs.datadoghq.com/logs/explorer/side_panel/)

### 실측해야 할 프런트엔드 품질

큰 결과·stacktrace·빠른 stream에서 입력 반응, 렌더 지연, 메모리, frame drop, keyboard focus를 측정해야 한다. 화면에 버튼이 있다는 사실은 실제 취소·접근성·성능 보장을 뜻하지 않는다. 수치는 사용자 규모와 장비를 정한 뒤 합의해야 하며 이번 조사에서 임의 목표를 확정하지 않았다.

## 수집 신뢰도와 보안을 함께 검토한다

| 상황 | 의미와 LogDock 논의점 |
| --- | --- |
| 부분 reject | HTTP 성공 안에 event별 실패가 있을 수 있다. accepted/rejected/queued/retried/dropped를 나눠 관측한다. |
| queue 포화 | drop_newest·drop_oldest·block은 데이터 손실과 앱 영향이 다르다. key별 quota 영구 drop과 재시도 queue도 구분한다. |
| 파싱 실패 | 원문을 남길지, 격리할지, 버릴지 정책을 정한다. PII 마스킹 실패 때 원문 보존은 일반 parse 실패와 같은 결정을 적용할 수 없다. |
| 재시작/rotation | 파일 위치 저장과 전송 queue는 다른 상태다. multiline flush, 압축·삭제·truncate·컨테이너 교체를 함께 검증한다. |
| 키와 tenant | ingest-only·query·admin 자격을 구분하고 scope/만료/교체를 정의한다. 브라우저의 tenant header만으로 scope를 결정하지 않도록 한다. |
| 권한 합집합 | 좁은 제한 role을 추가해도 unrestricted role이 남으면 범위가 넓을 수 있다. UI 메뉴 숨김과 row/field 보안을 구분한다. |
| 보안 관측 | 누가 key·pipeline·retention·권한·export를 바꿨는지 audit한다. token 원문과 민감 query 값을 audit에 재노출하지 않도록 한다. |
| HA/비용 | 수집기의 WAL·object storage·다중 AZ가 각각 보호하는 장애를 구분한다. 비용 상한·삭제·장기 중단 시 데이터 정책을 설명한다. |

근거 [A4](https://axiom.co/docs/restapi/endpoints/ingestToDataset) [B2](https://betterstack.com/docs/logs/api/create-a-collector/) [B3](https://betterstack.com/docs/logs/using-logtail/transforming-ingested-data/logs-vrl/) [E4](https://www.elastic.co/docs/solutions/observability/streams/manage-data-quality) [E8](https://www.elastic.co/docs/deploy-manage/users-roles/serverless-custom-roles) [Z7](https://signoz.io/docs/manage/administrator-guide/iam/user-guides/scope-telemetry-access-by-ingestion-key/) [Z12](https://signoz.io/docs/cost-control/ingestion-limits/) [O2](https://opentelemetry.io/docs/collector/resiliency/)

### 관측할 제품 지표

source별 마지막 수신/발생/검색 가능 시각, 파싱 실패·drop 이유, queue 사용량/최고 대기시간, export 실패·재시도, query 대기/실행/scan/취소, tenant별 quota와 현재 retained 양을 함께 설계할 필요가 있다. 단순한 collector up 또는 API health는 end-to-end 수집 성공을 증명하지 않는다.

OpenTelemetry는 메모리 queue, persistent queue, 별도 메시지 queue의 보호 범위와 disk full·timeout·overflow 시 손실 가능성을 문서화한다. 어떤 수집기를 선택하더라도 무손실을 기본 전제로 두지 않아야 한다. [O2](https://opentelemetry.io/docs/collector/resiliency/)

## 다음 설계 논의에서 결정할 사항

| 결정 | 대안과 영향 |
| --- | --- |
| 제품의 중심 | 로그 탐색, 오류 issue triage, 또는 둘의 연결 중 무엇을 제품의 주된 가치로 둘지. scope는 수집 정확도와 별도로 정의한다. |
| 배포/서비스 모델 | 조직당 독립 설치형, 중앙 운영형 multi-org SaaS, 관리형+BYOC 등. 인증·격리·업그레이드·지원과 비용 책임이 달라진다. |
| 데이터 객체 | tenant/project/source/dataset/service/server/event/issue의 수명과 관계. 화면·권한·보존 정책의 단위를 맞춰야 한다. |
| 수집 경계 | 기존 파일/컨테이너 호환성, OTel/HTTP 등 표준 입력, gateway 필요성, parser/masking의 실행 위치와 실패 계약. |
| 엔진 선택 | 필수 query·집계·문맥·원문 보존·보관/비용·부하 패턴을 기준으로 Loki/검색형/columnar 후보를 대조한다. |
| 운영 품질 | 수집 지연·허용 손실·query 응답·복구 목표와 검증 시나리오를 합의한다. 임의의 보관일·SLO 숫자를 확정하지 않는다. |
| 제품 UX | 첫 로그까지 온보딩, 탐색 상태, 결과 완전성, source 건강, 상세 context, 알림·공유 권한의 흐름을 검토한다. |

### 가져올 수 있는 차별화 가설

서로 다른 실행 환경의 원문을 정확히 온보딩하고, 수집·검색·권한·비용 문제를 운영자가 설명 가능한 상태로 보여주는 경험은 검증할 가치가 있다. 이는 제품 가설이다. 이미 queryless 탐색·패턴·AI 보조가 있는 시장에서 기능 이름만 추가하는 것으로 차별화가 입증되지는 않는다. [G1](https://grafana.com/docs/grafana/latest/visualizations/simplified-exploration/logs/) [G3](https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/simplified-exploration/logs/patterns/) [E5](https://www.elastic.co/docs/solutions/observability/logs/discover-logs) [A5](https://axiom.co/docs/query-data/explore)

### 이번 조사로 확정하지 않은 것

NestJS/Python의 최종 선택, Loki의 최종 채택, metadata DB, 세부 endpoint/schema, queue 도입, 화면 설계, 유료/무료 경계와 실제 SLA는 확정하지 않았다. 기존 초기 저장소를 최종 설계의 제약으로 삼지 않았으며 구현·배포 작업은 진행하지 않았다.

## 실서비스 검증에서 필요한 시나리오

아래는 연구에서 도출한 검증 후보다. 이번에 실행한 테스트가 아니며, 승인된 구현 범위를 정한 뒤 acceptance criteria로 구체화할 대상이다.

| 시나리오 | 확인할 결과 |
| --- | --- |
| 최초 연결 | 올바른 source/key/tenant로 들어온 합성 이벤트가 timestamp·service·server와 함께 검색 가능해지는지 |
| 형식과 경계 | 빈 값·0·false·잘못된 JSON·긴 행·multiline·서로 다른 timezone·같은 timestamp 다건을 보존/표시하는지 |
| 부분 실패 | batch 일부 reject, parser 일부 ignored, 2xx+partial status에서 원인과 카운트가 일관되는지 |
| 전송 장애 | 429/401/413/5xx·단절·queue 포화·재시작·rotation 후 재시도/중복/유실을 설명하는지 |
| 검색 완전성 | 기간/행/scan 한도, timeout, 표본·partial, late event, retention 만료와 조회 0건을 구분하는지 |
| 취소와 경쟁 | 조건 변경·탭 닫기·연속 검색 때 stale 응답과 서버 작업이 올바르게 처리되는지 |
| 권한 | 로그·facet·histogram·context·saved view·alert·export 전체에서 org/source/field 경계를 지키는지 |
| 라이브 탐색 | pause/resume 중 새 이벤트, 뒤늦은 이벤트, 선택 행·scroll 위치와 drop 지표가 유지되는지 |
| 복구와 운영 | query/collector/storage/metadata/worker 장애와 AZ 장애의 범위, 백업/복구·업그레이드·키 교체를 검증하는지 |
| 사용량과 알림 | 실제 과금 단위와 UI 사용량, cap 도달 동작, alert 지속/회복/no-data·전송 중복 방지가 일치하는지 |

## 확인 범위와 남은 증거

| 범위 | 이번에 확보한 증거 | 남은 확인 |
| --- | --- | --- |
| 제품 기능 | 7개 서비스의 공식 문서·공개 요금·edition·API 계약 | 유료/인증된 실제 계정에서 제공되는 기능과 계약 |
| UI/UX | Grafana/Axiom 공개 live 탐색, Elastic guided tour, 공식 이미지 | 최신 SaaS 전체 flow·a11y·고빈도 렌더링·실제 취소 |
| 수집/API | 공개 수집·오류·paging·권한 계약의 문서 | collector 설치·실제 ingest·partial/limits/rotation·중복/손실 |
| 운영 | 공개 engine 구조·보존·HA 설명과 제한 | SLO·RTO/RPO·tenant isolation·부하·복구/업그레이드 시험 |
| 가격 | 현재 공개 단위·플랜·일부 지역 고정 표 | 실제 용량·계약·지역·세금·부가 기능·청구서 |
| LogDock | 설계 논점과 검증 후보를 연구자의 추론으로 정리 | 제품 정의·요구사항·아키텍처·UX의 사용자 검토와 합의 |

### 제품별 특히 남은 불확실성

- Datadog: SaaS 물리적 격리·내부 HA, 일반 indexed query 취소 및 계정별 실제 상한.

- Elastic: Observability Serverless의 전체 audit·archive UX와 허용 API subset, 최신 live tail 상세 동작.

- Grafana Cloud: 계정별 LBAC entitlement, 실제 ingest/drop·고부하·복구와 query 초과 요금의 상세 계약.

- Better Stack/Axiom: 일반 multiline 기본값·전용 stacktrace·query cancellation·정확한 HA와 일부 preview 기능.

- Sentry: Logs query window와 retention 범위의 실계정 확인, arbitrary log body scrub 효과와 현재 audit 범위.

- SigNoz: beta/Coming Soon의 실제 계정 범위, 전체 self-host HA와 public demo 동작.

문서에서 확인하지 못한 항목을 기능 부재로 분류하지 않았다. 공개 소스 제품의 구조도 해당 SaaS의 비공개 내부 구현 전체를 입증하지 않는다.

## 공식 출처

본문의 대괄호는 아래 공식 문서 또는 공개 데모로 연결된다. 모두 2026-10-30 기준 조회. 직접 탐색과 공식 이미지의 증거 수준은 본문에서 별도로 표시했다.

| 참조 | 공식 문서와 URL |
| --- | --- |
| D1 | [Datadog Log collection](https://docs.datadoghq.com/logs/log_collection/)<br>https://docs.datadoghq.com/logs/log_collection/ |
| D2 | [Datadog indexes and quotas](https://docs.datadoghq.com/logs/log_configuration/indexes/)<br>https://docs.datadoghq.com/logs/log_configuration/indexes/ |
| D3 | [Datadog Archive Search](https://docs.datadoghq.com/logs/explorer/archive_search/)<br>https://docs.datadoghq.com/logs/explorer/archive_search/ |
| D4 | [Datadog Log Explorer](https://docs.datadoghq.com/logs/explorer/)<br>https://docs.datadoghq.com/logs/explorer/ |
| D5 | [Datadog log detail panel](https://docs.datadoghq.com/logs/explorer/side_panel/)<br>https://docs.datadoghq.com/logs/explorer/side_panel/ |
| D6 | [Datadog logs search API](https://docs.datadoghq.com/api/latest/logs/)<br>https://docs.datadoghq.com/api/latest/logs/ |
| D7 | [Datadog log data access controls](https://docs.datadoghq.com/logs/guide/logs-rbac-permissions/)<br>https://docs.datadoghq.com/logs/guide/logs-rbac-permissions/ |
| D8 | [Datadog Log Management pricing](https://www.datadoghq.com/pricing/?product=log-management)<br>https://www.datadoghq.com/pricing/?product=log-management |
| D9 | [Datadog backend error grouping](https://docs.datadoghq.com/logs/error_tracking/error_grouping/)<br>https://docs.datadoghq.com/logs/error_tracking/error_grouping/ |
| D11 | [Datadog Agent log telemetry](https://docs.datadoghq.com/data_security/agent/)<br>https://docs.datadoghq.com/data_security/agent/ |
| E2 | [Elastic project settings](https://www.elastic.co/docs/deploy-manage/deploy/elastic-cloud/project-settings)<br>https://www.elastic.co/docs/deploy-manage/deploy/elastic-cloud/project-settings |
| E3 | [Elastic Filestream integration](https://www.elastic.co/docs/reference/integrations/filestream)<br>https://www.elastic.co/docs/reference/integrations/filestream |
| E4 | [Elastic data quality and failure stores](https://www.elastic.co/docs/solutions/observability/streams/manage-data-quality)<br>https://www.elastic.co/docs/solutions/observability/streams/manage-data-quality |
| E5 | [Elastic Discover logs](https://www.elastic.co/docs/solutions/observability/logs/discover-logs)<br>https://www.elastic.co/docs/solutions/observability/logs/discover-logs |
| E6 | [Elastic pagination and PIT](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results)<br>https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results |
| E7 | [Elastic async search](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-async-search-get)<br>https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-async-search-get |
| E8 | [Elastic Serverless custom roles](https://www.elastic.co/docs/deploy-manage/users-roles/serverless-custom-roles)<br>https://www.elastic.co/docs/deploy-manage/users-roles/serverless-custom-roles |
| E9 | [Elastic resilience in Serverless](https://www.elastic.co/docs/deploy-manage/production-guidance/availability-and-resilience/resilience-in-serverless)<br>https://www.elastic.co/docs/deploy-manage/production-guidance/availability-and-resilience/resilience-in-serverless |
| E10 | [Elastic Observability detailed price table AWS us-east-1](https://cloud.elastic.co/cloud-pricing-table?productType=serverless&solution=observability&provider=aws&region=us-east-1)<br>https://cloud.elastic.co/cloud-pricing-table?productType=serverless&solution=observability&provider=aws&region=us-east-1 |
| E11 | [Elastic Observability billing dimensions](https://www.elastic.co/docs/deploy-manage/cloud-organization/billing/elastic-observability-billing-dimensions)<br>https://www.elastic.co/docs/deploy-manage/cloud-organization/billing/elastic-observability-billing-dimensions |
| E12 | [Elastic official Observability guided demo](https://www.elastic.co/demo-gallery/observability)<br>https://www.elastic.co/demo-gallery/observability |
| E13 | [Elastic SAML SSO plans](https://www.elastic.co/docs/deploy-manage/users-roles/cloud-organization/configure-saml-authentication)<br>https://www.elastic.co/docs/deploy-manage/users-roles/cloud-organization/configure-saml-authentication |
| E14 | [Elastic Spaces](https://www.elastic.co/docs/deploy-manage/manage-spaces)<br>https://www.elastic.co/docs/deploy-manage/manage-spaces |
| G1 | [Grafana Logs Drilldown](https://grafana.com/docs/grafana/latest/visualizations/simplified-exploration/logs/)<br>https://grafana.com/docs/grafana/latest/visualizations/simplified-exploration/logs/ |
| G2 | [Grafana log details and views](https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/simplified-exploration/logs/view-logs/)<br>https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/simplified-exploration/logs/view-logs/ |
| G3 | [Grafana log patterns](https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/simplified-exploration/logs/patterns/)<br>https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/simplified-exploration/logs/patterns/ |
| G4 | [Grafana Cloud access policies](https://grafana.com/docs/grafana-cloud/platform/security-and-account-management/security-and-access/authentication-and-permissions/access-policies/)<br>https://grafana.com/docs/grafana-cloud/platform/security-and-account-management/security-and-access/authentication-and-permissions/access-policies/ |
| G5 | [Grafana data-source LBAC](https://grafana.com/docs/grafana/latest/administration/data-source-management/teamlbac/)<br>https://grafana.com/docs/grafana/latest/administration/data-source-management/teamlbac/ |
| G6 | [Grafana Cloud Logs billing dimensions](https://grafana.com/docs/grafana-cloud/platform/pricing-and-usage/logs/)<br>https://grafana.com/docs/grafana-cloud/platform/pricing-and-usage/logs/ |
| G7 | [Grafana Cloud pricing](https://grafana.com/pricing/)<br>https://grafana.com/pricing/ |
| G8 | [Grafana Adaptive Logs](https://grafana.com/docs/grafana-cloud/observe-and-act/adaptive-telemetry/adaptive-logs/introduction/)<br>https://grafana.com/docs/grafana-cloud/observe-and-act/adaptive-telemetry/adaptive-logs/introduction/ |
| G9 | [Loki write and read architecture](https://grafana.com/docs/loki/latest/get-started/architecture/)<br>https://grafana.com/docs/loki/latest/get-started/architecture/ |
| G10 | [Loki HTTP API](https://grafana.com/docs/loki/latest/reference/loki-http-api/)<br>https://grafana.com/docs/loki/latest/reference/loki-http-api/ |
| G11 | [Loki authentication](https://grafana.com/docs/loki/latest/operations/authentication/)<br>https://grafana.com/docs/loki/latest/operations/authentication/ |
| G12 | [Loki tenant isolation](https://grafana.com/docs/loki/latest/operations/multi-tenancy/)<br>https://grafana.com/docs/loki/latest/operations/multi-tenancy/ |
| G13 | [Loki query scheduling](https://grafana.com/docs/loki/latest/get-started/components/)<br>https://grafana.com/docs/loki/latest/get-started/components/ |
| G14 | [Grafana Play public demo](https://play.grafana.org/a/grafana-lokiexplore-app/explore)<br>https://play.grafana.org/a/grafana-lokiexplore-app/explore |
| B1 | [Better Stack source quickstart](https://betterstack.com/docs/logs/logging-start/)<br>https://betterstack.com/docs/logs/logging-start/ |
| B2 | [Better Stack Collector API and buffer limits](https://betterstack.com/docs/logs/api/create-a-collector/)<br>https://betterstack.com/docs/logs/api/create-a-collector/ |
| B3 | [Better Stack VRL transformations](https://betterstack.com/docs/logs/using-logtail/transforming-ingested-data/logs-vrl/)<br>https://betterstack.com/docs/logs/using-logtail/transforming-ingested-data/logs-vrl/ |
| B4 | [Better Stack Live tail language](https://betterstack.com/docs/logs/using-logtail/live-tail-query-language/)<br>https://betterstack.com/docs/logs/using-logtail/live-tail-query-language/ |
| B5 | [Better Stack SQL API](https://betterstack.com/docs/logs/query-api/connect-remotely/)<br>https://betterstack.com/docs/logs/query-api/connect-remotely/ |
| B6 | [Better Stack own object-storage bucket](https://betterstack.com/docs/logs/host-data-in-your-own-bucket/)<br>https://betterstack.com/docs/logs/host-data-in-your-own-bucket/ |
| B7 | [Better Stack HTTP ingestion](https://betterstack.com/docs/logs/ingesting-data/http/logs/)<br>https://betterstack.com/docs/logs/ingesting-data/http/logs/ |
| B8 | [Better Stack alert evaluation](https://betterstack.com/docs/logs/dashboards/alerts/)<br>https://betterstack.com/docs/logs/dashboards/alerts/ |
| B9 | [Better Stack pricing](https://betterstack.com/pricing)<br>https://betterstack.com/pricing |
| B10 | [Better Stack audit logs](https://betterstack.com/docs/uptime/audit-logs/)<br>https://betterstack.com/docs/uptime/audit-logs/ |
| B11 | [Better Stack team roles](https://betterstack.com/docs/uptime/team-management/manage-roles/)<br>https://betterstack.com/docs/uptime/team-management/manage-roles/ |
| A1 | [Axiom datasets](https://axiom.co/docs/reference/datasets)<br>https://axiom.co/docs/reference/datasets |
| A2 | [Axiom reference collection architectures](https://axiom.co/docs/send-data/reference-architectures)<br>https://axiom.co/docs/send-data/reference-architectures |
| A3 | [Axiom EventDB architecture](https://axiom.co/docs/platform-overview/architecture)<br>https://axiom.co/docs/platform-overview/architecture |
| A4 | [Axiom event ingestion API](https://axiom.co/docs/restapi/endpoints/ingestToDataset)<br>https://axiom.co/docs/restapi/endpoints/ingestToDataset |
| A5 | [Axiom query builder](https://axiom.co/docs/query-data/explore)<br>https://axiom.co/docs/query-data/explore |
| A6 | [Axiom stream and context](https://axiom.co/docs/query-data/stream)<br>https://axiom.co/docs/query-data/stream |
| A7 | [Axiom roles and settings](https://axiom.co/docs/reference/settings)<br>https://axiom.co/docs/reference/settings |
| A8 | [Axiom tokens](https://axiom.co/docs/reference/tokens)<br>https://axiom.co/docs/reference/tokens |
| A9 | [Axiom pagination preview](https://axiom.co/docs/restapi/pagination)<br>https://axiom.co/docs/restapi/pagination |
| A10 | [Axiom query cost limits](https://axiom.co/docs/console/intelligence/query-cost-limits)<br>https://axiom.co/docs/console/intelligence/query-cost-limits |
| A11 | [Axiom current pricing rate card](https://axiom.co/pricing/llms.txt)<br>https://axiom.co/pricing/llms.txt |
| A12 | [Axiom pricing](https://axiom.co/pricing)<br>https://axiom.co/pricing |
| A13 | [Axiom public Play](https://play.axiom.co/)<br>https://play.axiom.co/ |
| S1 | [Sentry Logs](https://docs.sentry.io/product/logs/)<br>https://docs.sentry.io/product/logs/ |
| S2 | [Sentry retention periods](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/)<br>https://docs.sentry.io/security-legal-pii/security/data-retention-periods/ |
| S3 | [Sentry drains and error-capture boundary](https://docs.sentry.io/product/drains/)<br>https://docs.sentry.io/product/drains/ |
| S4 | [Sentry PHP logs and flushing](https://docs.sentry.io/platforms/php/logs/)<br>https://docs.sentry.io/platforms/php/logs/ |
| S5 | [Sentry issue grouping](https://docs.sentry.io/concepts/data-management/event-grouping/)<br>https://docs.sentry.io/concepts/data-management/event-grouping/ |
| S6 | [Sentry Explore events API](https://docs.sentry.io/api/explore/query-explore-events-in-table-format/)<br>https://docs.sentry.io/api/explore/query-explore-events-in-table-format/ |
| S7 | [Sentry pagination](https://docs.sentry.io/api/pagination/)<br>https://docs.sentry.io/api/pagination/ |
| S8 | [Sentry SSO](https://docs.sentry.io/organization/authentication/sso/)<br>https://docs.sentry.io/organization/authentication/sso/ |
| S9 | [Sentry current pricing](https://sentry.io/pricing/)<br>https://sentry.io/pricing/ |
| S10 | [Sentry self-host and FSL](https://develop.sentry.dev/self-hosted/)<br>https://develop.sentry.dev/self-hosted/ |
| S11 | [Sentry architecture overview](https://develop.sentry.dev/application-architecture/overview/)<br>https://develop.sentry.dev/application-architecture/overview/ |
| Z1 | [SigNoz architecture](https://signoz.io/docs/architecture/)<br>https://signoz.io/docs/architecture/ |
| Z2 | [SigNoz multiline logs](https://signoz.io/docs/userguide/parse-multiline-logs/)<br>https://signoz.io/docs/userguide/parse-multiline-logs/ |
| Z3 | [SigNoz log pipelines](https://signoz.io/docs/logs-pipelines/introduction/)<br>https://signoz.io/docs/logs-pipelines/introduction/ |
| Z4 | [SigNoz Exceptions data source](https://signoz.io/docs/userguide/exceptions/)<br>https://signoz.io/docs/userguide/exceptions/ |
| Z5 | [SigNoz log search API](https://signoz.io/docs/logs-management/logs-api/search-logs/)<br>https://signoz.io/docs/logs-management/logs-api/search-logs/ |
| Z6 | [SigNoz query payload model](https://signoz.io/docs/logs-management/logs-api/payload-model/)<br>https://signoz.io/docs/logs-management/logs-api/payload-model/ |
| Z7 | [SigNoz telemetry IAM beta](https://signoz.io/docs/manage/administrator-guide/iam/user-guides/scope-telemetry-access-by-ingestion-key/)<br>https://signoz.io/docs/manage/administrator-guide/iam/user-guides/scope-telemetry-access-by-ingestion-key/ |
| Z8 | [SigNoz SSO editions](https://signoz.io/docs/manage/administrator-guide/sso/overview/)<br>https://signoz.io/docs/manage/administrator-guide/sso/overview/ |
| Z9 | [SigNoz pricing and roadmap markers](https://signoz.io/pricing/)<br>https://signoz.io/pricing/ |
| Z10 | [SigNoz root license](https://github.com/SigNoz/signoz/blob/main/LICENSE)<br>https://github.com/SigNoz/signoz/blob/main/LICENSE |
| Z11 | [SigNoz log explorer and context](https://signoz.io/docs/userguide/logs_query_builder/)<br>https://signoz.io/docs/userguide/logs_query_builder/ |
| Z12 | [SigNoz daily ingestion limits](https://signoz.io/docs/cost-control/ingestion-limits/)<br>https://signoz.io/docs/cost-control/ingestion-limits/ |
| Z13 | [SigNoz ingestion keys](https://signoz.io/docs/ingestion/signoz-cloud/keys/)<br>https://signoz.io/docs/ingestion/signoz-cloud/keys/ |
| Z14 | [SigNoz retention settings](https://signoz.io/docs/userguide/retention-period/)<br>https://signoz.io/docs/userguide/retention-period/ |
| O1 | [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)<br>https://opentelemetry.io/docs/specs/otel/logs/data-model/ |
| O2 | [OpenTelemetry Collector resilience](https://opentelemetry.io/docs/collector/resiliency/)<br>https://opentelemetry.io/docs/collector/resiliency/ |
