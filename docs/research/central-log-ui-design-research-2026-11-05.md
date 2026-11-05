# 중앙 로그 시각화 서비스 디자인 참고 조사

기준일: 2026-11-05. 목적은 LogDock 디자인 체크다. **57개 제품·도구·역사 자료 항목을 조사하고, 12개 제품의 공식 이미지 16건을 직접 관찰했다.** 상용·오픈소스/설치형·클라우드·개발자 도구·보안 인접 영역을 포함했다. 전 세계 서비스의 완전한 전수 목록이나 서로 독립적인 UI 57종을 뜻하지 않는다.

- [화면 모음과 나란히 비교](central-log-ui-reference-2026-11-05.html)
- [전체 구조화 조사 데이터](central-log-ui-catalog-2026-11-05.json)
- [기존 7개 상용 서비스 조사](commercial-services-2026-10-30.md)
- [현재 LogDock 시안](../design/sample-ui02-log-search.html)

## 1. 먼저 볼 레퍼런스

**전체 인상은 Sentry·Last9, 원문 읽기는 Axiom, 상세·문맥은 SigNoz·Grafana, 밀도와 필터는 Datadog·Elastic을 우선 비교하는 것을 추천한다.** 아래 추천은 이미지 관찰에서 도출한 설계 의견이다. 제품의 우열이나 새 기능 채택 결정이 아니다.

| 점검 대상 | 우선 비교 | 실제로 볼 부분 |
| --- | --- | --- |
| 밝은 화면의 전체 인상 | Sentry, Last9 | 검색·분포·목록 위계, 선택 행, 표 선과 배경 |
| 넓은 원문 읽기 | Axiom | 시간과 원문의 폭 배분, 줄바꿈, 필드·원문 탭 |
| 정보 밀도와 필터 | Datadog, Elastic | 필드 사이드바, 작은 행 높이, 열과 본문 비율 |
| 상세와 주변 로그 | SigNoz, Grafana, Last9 | 선택 유지, 상세의 폭, 원문·속성·주변 문맥 분리 |
| 중립적인 도구 구성 | Dash0 | 검색·차트·표의 정렬, 레벨 문자와 막대 |
| 행 위 작업과 패널 층위 | Better Stack | 선택·hover 상태와 상세 패널; 홍보 연출 구분 |
| 시간·조회 범위 설명 | Google Cloud, Grafana | 적용 기간, 표시된 결과 범위·처리 상태 |

각 제품의 공식 근거와 실제 관찰 내용은 3·4절에 있다. HTML에서는 두 제품을 선택해 나란히 보고, 전체 목록을 검색할 수 있다.

## 2. 범위와 증거 수준

| 표기 | 확인한 것 | 확인하지 않은 것 |
| --- | --- | --- |
| 공식 이미지 관찰 | 공식 문서·블로그·제품 페이지의 픽셀을 직접 확인 | 최신 실계정의 전체 화면, hover·키보드 동작, 실제 대비·성능 |
| 공식 문서 | 제품 제공자가 설명한 기능과 조작 | 화면의 실제 외형이나 서비스 실행 결과 |
| 설계 의견 | 관찰을 바탕으로 한 LogDock 참고 제안 | 사용자 합의·현재 디자인 변경·구현 승인 |

이미지 공개일·이미지 속 날짜·이번 확인일은 다를 수 있다. 특히 Axiom Stream, Seq, Quickwit과 구 Scalyr 자료는 과거 화면이다. UI가 안 보인다는 이유로 기능 부재를 단정하지 않았다. 테마 표기는 관찰한 캡처의 테마이며 제품 전체의 테마 지원 판정이 아니다.

HTML은 **외부 공식 이미지 주소를 불러온다.** 인터넷이 필요하며 제공자 변경·접근 제한으로 이미지가 안 뜨면 함께 둔 원문 링크로 확인한다. 외부 이미지는 제공자 저작물이며 LogDock의 Apache-2.0 라이선스로 재허락하지 않는다. 원본 이미지를 저장소에 복사하지 않았다. 화면 안의 예시는 해당 제공자가 공개한 자료다.

Grafana Cloud·Grafana OSS·Loki, HyperDX·ClickStack은 각각 같은 UI 계열로 묶었다. Logit.io처럼 기존 UI를 호스팅하는 서비스와 Sentinel처럼 다른 제품의 쿼리 표면을 쓰는 항목도 따로 성격을 표시했다. Logdy는 로컬 뷰어, Quickwit은 검색·관리 UI이며 완성형 중앙 로그 SaaS와 동일하지 않다. 수집 전용 Fluent Bit·Vector·Logstash와 저장 엔진 단독은 별도 UI 서비스로 세지 않았다.

## 3. 대표 화면 직접 관찰

### 3.1. Sentry Logs — 밝은 화면

- 관찰: 프로젝트·환경·시간과 긴 검색창이 같은 줄에 있고, 얕은 보라색 차트 아래에 목록이 이어진다. 고정 행은 연한 보라색 배경과 핀으로 구분된다.
- 참고 의견: 색보다 행 선택과 정보 위계가 먼저 보인다. 밝은 LogDock의 전체 인상 참고 1순위.
- 주의: 보라색 외곽 홍보 배경과 AI·export·고정 기능은 그대로 가져올 대상이 아니다.
- 근거: [공식 화면 출처](https://blog.sentry.io/sentry-logs-summer-2026-roundup/) · [원본 이미지](https://blog.sentry.io/_vercel/image?url=_astro%2Flogs-pinned-log-line.CS-w9kA9.webp&w=1920&q=100)

### 3.2. Last9 — 밝은 화면

- 관찰: 검색 모드·시간·실행을 상단에 모으고, 분포 아래 왼쪽 필터와 오른쪽 원문 목록을 놓았다. 행은 가는 레벨 막대와 구분선으로 나뉜다.
- 참고 의견: 밝은 바탕에서 필터와 로그 본문의 위계를 점검하기 좋다.
- 주의: 도구막대가 여러 줄이다. 그대로 옮기면 검색 영역이 커질 수 있다.
- 근거: [공식 화면 출처](https://last9.io/docs/logs-explorer/) · [원본 이미지](https://last9.io/_astro/last9-logs-toggle-columns.NdTMZvIc_1gMgPw.webp)
- 추가 관찰: Related Logs가 열린 공식 상세 화면. 큰 측면 패널이 원래 목록을 가리므로 폭과 복귀 동선도 비교한다. [추가 이미지](https://last9.io/_astro/last9-log-details.5kWQN_Ag_LbtYU.webp)

### 3.3. Dash0 — 어두운 화면

- 관찰: 왼쪽은 필드가 아닌 저장 뷰 목록이다. 본문에는 긴 필터, 넓은 레벨 차트, 보기 전환, severity·time·resource·body 표가 순서대로 놓였다.
- 참고 의견: 차트와 목록의 정렬 및 레벨 문자·가는 막대의 중복 표시를 참고한다.
- 주의: 필드 필터 사이드바와 저장 뷰 사이드바를 같은 역할로 해석하지 않는다.
- 근거: [공식 화면 출처](https://www.dash0.com/docs/dash0/telemetry/logging/about-logging) · [원본 이미지](https://www.dash0.com/_next/image?url=%2Fimages%2Fdocumentation%2Ftelemetry%2Flogging%2Fexplorer%2Ftelemetry-logging-explorer.webp&w=3840&q=75&dpl=dpl_BbNj9u4JikU57hdpNyhPBTfhvzit)

### 3.4. Better Stack — 어두운 화면

- 관찰: 홍보 이미지에 왼쪽 제품 메뉴, 상단 source·검색·시간, 분포·목록, 겹쳐 열린 오른쪽 JSON 상세가 보인다. 문서의 행 확대 이미지에는 선택 배경과 행 오른쪽 도구가 있다.
- 참고 의견: 행에서 작업을 드러내는 방식과 상세 패널의 층위를 참고한다.
- 주의: 기울임·큰 그림자·배경·페이드는 홍보용 연출이다. 이 이미지로 앱의 실제 대비를 평가하지 않는다.
- 근거: [공식 화면 출처](https://betterstack.com/log-management) · [원본 이미지](https://betterstack.com/assets/v2/log-management/hero-6e5c079c.jpg)
- 추가 관찰: 문서의 행 확대 이미지. 선택 행의 배경과 hover 도구 위치를 확인한다. 바깥 그라데이션은 홍보 연출이다. [추가 이미지](https://imagedelivery.net/xZXo0QFi-1_4Zimer-T0XQ/058eb0cf-d9be-4497-40db-6e4e7c0dc500/orig)

### 3.5. Axiom — 밝은 화면

- 관찰: Stream 문서 캡처는 dataset·필터를 위에 놓고, 시간과 Raw Data 두 열에 폭을 거의 전부 쓴다. 상세 이미지는 Event Properties와 Raw Data 탭 및 View in context·Copy JSON을 보여 준다.
- 참고 의견: 원문 읽기 폭과 상세의 역할 구분을 참고한다.
- 주의: 캡처는 이전 내비게이션이다. 이 상태에 그래프가 없다고 제품에 그래프가 없다고 판단하지 않는다.
- 근거: [공식 화면 출처](https://axiom.co/docs/query-data/stream) · [원본 이미지](https://axiom.co/docs/doc-assets/shots/event-stream-1.png)
- 추가 관찰: 속성·원문 탭과 주변 로그·JSON 복사를 분리한 공식 이벤트 상세. [추가 이미지](https://axiom.co/docs/doc-assets/shots/event-slideout-1.png)

### 3.6. SigNoz — 어두운 화면

- 관찰: 왼쪽 필터와 중앙 목록이 구분되고 상단에 List·Time Series·Table 탭이 있다. 상세는 Overview·Context·Metrics와 Pretty·JSON, 필드 검색을 나눈다.
- 참고 의견: 검색 결과에서 상세·주변 로그로 내려가는 구조를 참고한다.
- 주의: Overview 이미지에는 빈도 차트가 꺼져 있다. 다른 상태의 차트 이미지를 합쳐 하나의 실제 화면이라고 설명하지 않는다.
- 근거: [공식 화면 출처](https://signoz.io/docs/userguide/logs_query_builder/) · [원본 이미지](https://signoz.io/_next/image/?url=https%3A%2F%2Fd3nu8xzr1i9u95.cloudfront.net%2Fweb%2Fimg%2Fdocs%2Flogs-management%2Fui%2Flogs-explorer-overview-quick-filters.webp&w=3840&q=75)
- 추가 관찰: 공식 상세 드로어. 본문·탭·필드 검색과 JSON 계층의 분리. [추가 이미지](https://signoz.io/_next/image/?url=https%3A%2F%2Fd3nu8xzr1i9u95.cloudfront.net%2Fweb%2Fimg%2Fdocs%2Flogs-management%2Fui%2Flogs-detail-drawer-overview.webp&w=3840&q=75)

### 3.7. Grafana Logs Drilldown / Explore — 어두운 화면

- 관찰: 왼쪽 필드, 중앙 원문, 오른쪽 상세가 한 화면에 보인다. 목록 위에는 표시 행 수와 검색 구간 중 비율, 처리 바이트가 표시된다.
- 참고 의견: 로그 원문과 필드를 오가면서 읽는 흐름, 조회 상태 문구를 참고한다.
- 주의: 공식 상세 이미지 일부만 관찰했다. 서비스 카드나 전체 Drilldown 진입 화면과 동일 화면으로 합치지 않는다.
- 근거: [공식 화면 출처](https://grafana.com/docs/grafana/latest/visualizations/simplified-exploration/logs/view-logs/) · [원본 이미지](https://grafana.com/media/docs/explore-logs/v2/logs-drilldown-logs-details-copy-menu.png)

### 3.8. Elastic / Kibana — 밝은 화면

- 관찰: 검색·시간 선택 아래 왼쪽 필드, 오른쪽 히스토그램·문서 표가 놓였다. 각 행은 요약 칩과 원문을 조합하고 행 배경과 얇은 선으로 구분된다.
- 참고 의견: 필드·분포·표의 정렬과 넓은 화면에서의 정보 밀도를 참고한다.
- 주의: 필드와 행 안의 칩이 많다. LogDock에는 필수 출처와 본문부터 드러내는 편이 읽기 쉽다는 설계 추론이다.
- 근거: [공식 화면 출처](https://www.elastic.co/docs/solutions/observability/logs/discover-logs) · [원본 이미지](https://www.elastic.co/docs/solutions/images/observability-log-explorer.png)

### 3.9. Datadog — 밝은 화면

- 관찰: 상단 검색·집계·시각화 도구, 중간 분포, 하단 왼쪽 facet과 오른쪽 로그 표가 배치된다. 날짜·호스트·서비스·본문 열과 가는 레벨 막대가 보인다.
- 참고 의견: 도구와 결과를 나누는 위계, 로그 행 밀도·열 구성을 참고한다.
- 주의: 도구 수가 많으므로 전체 메뉴 복제보다 정보 계층만 참고한다.
- 근거: [공식 화면 출처](https://docs.datadoghq.com/logs/explorer/) · [원본 이미지](https://docs.dd-static.net/images/logs/explore.b937574cd932232459c1c5746146a353.png?auto=format&fit=max&w=1700)

### 3.10. OpenObserve — 밝은 화면

- 관찰: SQL·함수 편집기가 위쪽에 있고 왼쪽 필드, 히스토그램, 원본 행과 펼친 JSON이 아래 이어진다.
- 참고 의견: 행 내부 상세와 별도 패널의 공간 차이를 비교하기 좋다.
- 주의: 이 캡처는 SQL 모드다. 아이콘 중심 도구막대를 기본 검색 UX로 곧바로 채택할 근거는 아니다.
- 근거: [공식 화면 출처](https://openobserve.ai/docs/user-guide/data-exploration/logs/logs/) · [원본 이미지](https://openobserve.ai/docs/images/logs-query-sql-mode.png)

### 3.11. Google Cloud Logging Logs Explorer — 밝은 화면

- 관찰: 텍스트 검색과 리소스 메뉴·쿼리 편집기, 왼쪽 필드·건수, 시간축, 결과 표가 구분된다. 결과 아래 적용 시간 안내도 보인다.
- 참고 의견: 입력 시간과 적용 시간 안내, 필터 값·건수의 관계를 참고한다.
- 주의: 공식 캡처 자체에 가림 처리된 값이 있다. 검색 영역이 높아 처음 보이는 로그 행이 줄 수 있다.
- 근거: [공식 화면 출처](https://docs.cloud.google.com/logging/docs/view/logs-explorer-interface) · [원본 이미지](https://docs.cloud.google.com/static/logging/docs/images/logs-explorer-interface.png)

### 3.12. Pydantic Logfire — 어두운 화면

- 관찰: 주석 달린 공식 캡처는 상단 검색·기간, 시간 분포와 연결 상태, 접히는 트리 형태 기록 및 오른쪽 기간 막대를 보여 준다.
- 참고 의견: 연속 기록의 기준 시점과 계층을 읽는 방식을 비교한다.
- 주의: 기간 막대는 span의 소요시간이다. 트레이스 없는 일반 로그 표에 같은 막대를 붙일 이유는 없다.
- 근거: [공식 화면 출처](https://pydantic.dev/docs/logfire/observe/live/) · [원본 이미지](https://pydantic.dev/docs/logfire/images/guide/live-view-collapsed-annotated.png)

## 4. 전체 조사 목록

아래 UI 설명은 각 행의 공식 출처에 근거한다. 참고점은 설계 비교 관점이며, 이미지 관찰 여부는 `근거` 열로 구분한다. 설치 가능성·가격·라이선스·보안·성능의 비교는 이번 목적에 포함하지 않았다.

### 상용·기업형

| 제품·도구 | UI 설명과 참고점 | 근거·공식 출처 | 범위·주의 |
| --- | --- | --- | --- |
| Datadog | 왼쪽 facet 패널, 로그 목록의 열 및 표시 높이 설정, 오른쪽 로그 패널. 패널의 필드 값으로 포함·제외 검색 또는 열 추가; 주변 로그 보기.<br>참고: 목록에서 필드 탐색과 상세 검색을 연결 | 이미지+문서<br>[문서](https://docs.datadoghq.com/logs/explorer/visualize/) · [추가 근거](https://docs.datadoghq.com/logs/explorer/side_panel/) | Facet은 사용자 정의이며 정렬 신뢰도는 필드 상태에 따라 다름. |
| Elastic / Kibana | Discover의 필드 패널, 차트 및 검색 결과 테이블. 행 상세에서 필드 검색과 값 필터, 열 추가·제거; Table/JSON 상세 보기.<br>참고: 필드 목록·차트·테이블과 상세 연결 | 이미지+문서<br>[문서](https://www.elastic.co/docs/solutions/observability/logs/discover-logs) · [추가 근거](https://www.elastic.co/docs/explore-analyze/discover/discover-get-started) | 서버리스와 Stack 버전에 따라 인터페이스 차이가 있음. |
| Splunk | 검색창과 시간 범위, 이벤트 수 타임라인, 왼쪽 필드 사이드바, 이벤트 목록. 타임라인 막대를 클릭해 기존 결과 시간 범위 탐색.<br>참고: 타임라인과 필드 요약을 통한 결과 탐색 | 문서 설명<br>[문서](https://help.splunk.com/en/splunk-cloud-platform/search/search-manual/10.6/using-the-search-app/about-the-search-app) · [추가 근거](https://help.splunk.com/en/splunk-enterprise/search/search-manual/9.2/retrieve-events/use-the-timeline-to-investigate-events) | 문서는 Splunk Cloud 10.6 검색 앱 및 Enterprise 9.2를 설명함. |
| New Relic | 키워드 및 속성 자동완성 검색, 속성 탐색, 차트에서 기간 선택. 로그 행을 한 줄 또는 확장 표시하고 상세를 오른쪽 패널 또는 행 내부에서 Table/JSON으로 확인.<br>참고: 행 밀도와 상세 위치를 선택하는 설정 | 문서 설명<br>[문서](https://docs.newrelic.com/docs/logs/ui-data/use-logs-ui/) | 문서 설명 기준이며 배포 화면과 기능은 계정 설정에 따라 다를 수 있음. |
| Dynatrace | Logs 앱에서 필터와 DQL, 기간 선택, 상태별 로그 분포 차트, facet, 주변 로그 및 상세에서 관련 데이터 탐색.<br>참고: 분포 차트와 주변 로그 탐색 | 문서 설명<br>[문서](https://docs.dynatrace.com/docs/analyze-explore-automate/logs/lma-logs-app) · [추가 근거](https://docs.dynatrace.com/docs/analyze-explore-automate/logs/lma-logs-app/query-and-filter) | 현행 Logs 앱 기준. 별도 Logs Classic 문서와 구분. |
| Sumo Logic | Basic/Advanced 검색 편집기와 시간 선택, 히스토그램, Messages 및 Aggregates 탭. 메시지 표의 열 이동·고정·너비 조절, 행 확장 및 히스토그램에서 페이지 이동.<br>참고: 원본 메시지와 집계 결과의 탭 전환 | 문서 설명<br>[문서](https://www.sumologic.com/help/docs/search/get-started-with-search/search-page/) · [추가 근거](https://www.sumologic.com/help/docs/search/get-started-with-search/search-page/navigate-through-search-results/) | 일부 동작은 검색 상태 및 쿼리 유형에 따라 달라짐. |
| LogicMonitor Logs | 로그 검색과 시간 필터, Fields 패널에서 필드 및 근사 빈도 확인, 표 열 추가와 순서 변경. 행 선택으로 전체 로그와 메타데이터 패널 열기.<br>참고: 필드에서 쿼리와 표시 열로 이어지는 작업 | 문서 설명<br>[문서](https://www.logicmonitor.com/support/lm-logs/viewing-logs-and-log-anomalies) | Fields 패널 빈도는 근사치임; 제품 문서는 LM Logs 명칭도 사용. |
| Logz.io | Explore Logs는 Lucene 자동완성·구문 강조 및 Simple Search, 필터 패널·필드 즐겨찾기·로그 표 제공. 별도 OpenSearch Discover에는 히스토그램 범위 선택이 있음.<br>참고: 필드 즐겨찾기와 자연스러운 검색 범위 좁히기 | 문서 설명<br>[문서](https://docs.logz.io/docs/open360/explore/new-explore/) · [추가 근거](https://docs.logz.io/docs/user-guide/log-management/opensearch-dashboards/) | Explore와 OpenSearch Dashboards는 별도 화면이므로 히스토그램 설명을 Explore에 일반화하지 않음. |
| Coralogix | Explore 결과 그리드에서 로그 행을 선택하면 오른쪽 상세 패널이 열림. 필드 값을 포함·제외해 쿼리를 좁히고, 표 셀에서 값 분포를 차트로 탐색.<br>참고: 표 셀과 상세 패널에서 검색 전환 | 문서 설명<br>[문서](https://coralogix.com/docs/user-guides/data_exploration/search/) · [추가 근거](https://coralogix.com/docs/user-guides/data_exploration/logs/info_panel/) | 공식 릴리스 노트에 2026년 Explore 재설계가 명시됨; 화면 버전에 유의. |
| Mezmo | Log Viewer에 Views, Tags/Sources/Apps/Levels 필터, 검색창 및 타임라인. 타임라인에서 드래그해 구간을 선택하면 뷰와 시간 척도가 갱신됨.<br>참고: 필터 도구막대와 타임라인 범위 선택 | 문서 설명<br>[문서](https://docs.mezmo.com/docs/view-log-data) · [추가 근거](https://docs.mezmo.com/docs/view-log-data-by-timeline) | 공식 문서의 앱 링크는 logdna.com 도메인을 사용하나 현 제품 문서 명칭은 Mezmo. |
| SolarWinds Papertrail | 기존 Event Viewer는 실시간 로그, 일시정지, 검색, 메시지 속도 그래프, 시간 이동과 주변 로그를 제공. 글꼴·줄 밀도·밝은/어두운 테마 설정 가능.<br>참고: 라이브 테일과 시간 이동 및 표시 밀도 | 문서 설명<br>[문서](https://www.papertrail.com/help/event-viewer/) · [추가 근거](https://documentation.solarwinds.com/en/success_center/observability/content/configure/analyze-logs.htm) | Papertrail 문서의 Event Viewer와 SolarWinds의 Papertrail logs-only Analyze 화면은 별도 경험으로 확인해야 함. |
| SolarWinds Loggly | 검색 상자·시간 선택·Field Explorer, 시간 히스토그램과 이벤트 수, Events/Grid/Trends 보기. 필드 상위 값 선택으로 결과 필터링하고 히스토그램 구간을 확대.<br>참고: 필드별 빈도에서 필터로 연결 | 문서 설명<br>[문서](https://documentation.solarwinds.com/en/success_center/loggly/content/admin/search-overview.htm) · [추가 근거](https://documentation.solarwinds.com/en/success_center/loggly/content/admin/dynamic-field-explorer.htm) | APM Integrated Experience 사용 여부에 따라 탐색 경로가 달라질 수 있음. |

### 클라우드·플랫폼

| 제품·도구 | UI 설명과 참고점 | 근거·공식 출처 | 범위·주의 |
| --- | --- | --- | --- |
| AWS CloudWatch Logs | Log Analytics는 Logs Insights 쿼리·탭·facets·결과 시각화와 Live Tail을 한 경험으로 묶는다. Live Tail은 필터·강조, 이벤트 창 클릭으로 일시정지, 개별 이벤트 펼침과 측면 상세 창을 설명한다.<br>참고: 과거 검색과 실시간 탐색의 연결, 스트림 일시정지 후 상세 비교 | 문서 설명<br>[문서](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/LogAnalytics.html) · [추가 근거](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CloudWatchLogs_LiveTail.html) | 문서상 통합 경험을 기준으로 정리; 실제 계정 화면이나 배치 미확인. |
| Google Cloud Logging Logs Explorer | 툴바·쿼리·필드·타임라인·결과 창으로 구성. 검색어와 필터 메뉴가 쿼리에 반영되고, 타임라인에서 시간 이동 또는 확대와 결과의 필드 포함·제외를 제공한다.<br>참고: 결과·필드·시간축이 함께 작동하는 조사 흐름 | 이미지+문서<br>[문서](https://docs.cloud.google.com/logging/docs/view/logs-explorer-interface) | 문서의 화면 구성과 동작을 근거로 함; 제품 UI 버전에 따라 달라질 수 있음. |
| Azure Monitor Logs (Log Analytics) | Simple mode는 표에서 필터·정렬·집계하며, KQL mode는 쿼리 창을 추가한다. 결과 창에서 행 펼치기, 열 선택, 그룹화, 표와 차트 전환을 설명한다.<br>참고: 시각적 탐색과 쿼리 편집을 단계별로 연결하는 모드 구성 | 문서 설명<br>[문서](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/log-analytics-overview) · [추가 근거](https://learn.microsoft.com/en-us/azure/log-analytics/log-analytics-tutorial-viewdata) | 문서상 두 모드 설명; 실제 콘솔 조작이나 화면 배치 직접 검증 안 함. |
| Oracle Cloud Logging | Basic 필터와 Advanced 쿼리를 제공한다. Explore에서 시간별 막대와 로그 행, JSON 펼치기, Before & After 주변 로그를 볼 수 있다.<br>참고: 쿼리 작성 없이 조건을 좁힌 후 이벤트 전후 맥락을 보는 흐름 | 문서 설명<br>[문서](https://docs.oracle.com/en-us/iaas/Content/Logging/Concepts/searchinglogs.htm) · [추가 근거](https://docs.oracle.com/en-us/iaas/Content/Logging/Concepts/work_with_search_results.htm) | Advanced에서 Basic으로 전환하면 쿼리가 사라지며 경고를 표시한다고 문서에 설명. |
| IBM Cloud Logs | Explore Logs 화면에서 확장·접기 가능한 필터와 값 선택, Add Filter, Lucene 또는 DataPrime 검색을 결합한다. 필터와 쿼리를 포함한 보기를 저장할 수 있다.<br>참고: 필터 선택 상태를 저장 가능한 탐색 보기로 다루는 방식 | 문서 설명<br>[문서](https://cloud.ibm.com/docs/cloud-logs?topic=cloud-logs-query-data-filter) | 로그 결과의 전체 시각 배치는 확인하지 못함. |
| Alibaba Cloud Simple Log Service | Search & Analyze는 상단 쿼리와 시간 선택, 결과 수와 시간 히스토그램, 왼쪽 필드, Raw Logs·Statistical Charts·LogReduce 탭을 제공한다. 히스토그램 블록을 더블클릭해 시간 범위를 좁힌다.<br>참고: 쿼리·필드·분포·원본 결과를 한 화면에 연결 | 문서 설명<br>[문서](https://www.alibabacloud.com/help/en/sls/quick-guide-to-query-and-analysis) | 가이드는 예시 Logstore의 색인 구성을 전제로 함. |
| Tencent Cloud CLS | 검색 분석에서 리전·로그 토픽·시간을 선택하고 쿼리를 입력한다. 왼쪽 필드 목록에서 통계가 활성화된 필드를 선택하면 빠른 분석 대화상자와 쿼리·차트 생성을 제공한다.<br>참고: 필드 값 분포에서 쿼리와 차트로 진입하는 탐색 | 문서 설명<br>[문서](https://cloud.tencent.com/document/product/614/49360/) · [추가 근거](https://cloud.tencent.com/document/product/614/59015) | 중국어 공식 문서 기준. 빠른 분석은 해당 필드의 통계 설정이 필요하다. |
| Huawei Cloud LTS | Log Search에서 시간과 검색어·필드를 선택하고 시간 구간별 로그 수 막대를 확인한다. 로그 필드에서 포함·제외 검색을 만들고 목록 또는 원본 로그 형태를 선택할 수 있다.<br>참고: 이벤트의 필드 값으로 검색 조건을 직접 확장하는 조작 | 문서 설명<br>[문서](https://support.huaweicloud.com/intl/en-us/usermanual-lts/lts_05_0005.html) | 문서는 구조화와 색인 설정을 전제로 하며 복잡한 OR 조건의 강조가 실제 일치와 다를 수 있다고 명시한다. |
| NAVER Cloud Cloud Log Analytics | Keyword와 Lucene Query 탭, 시간 선택, Log Count 막대, 선택 필드와 검색 결과, Table·JSON 보기가 있다. 필드 값 선택 또는 포함·제외 필터가 Lucene 검색에 반영된다.<br>참고: 기본 키워드와 고급 쿼리의 진입점을 구분하고 결과에서 필터 생성 | 문서 설명<br>[문서](https://guide.ncloud-docs.com/docs/cla-use-search) | 캡처 이미지 주소는 일시 서명 URL이라 문서 페이지를 참조. 콘솔 직접 확인 안 함. |
| NHN Cloud Log & Crash Search | Lucene 검색 쿼리와 기간, 시간별 막대 차트, 선택 필드 및 결과 레코드가 있다. 차트 막대 클릭 시 해당 기간으로 재검색하고 레코드 항목 클릭으로 검색 쿼리를 바꾼다.<br>참고: 차트와 로그 값에서 검색 조건을 좁히는 왕복 흐름 | 문서 설명<br>[문서](https://docs.gov-nhncloud.com/ko/Data%20%26%20Analytics/Log%20%26%20Crash%20Search/ko/gov-console-guide/) · [추가 근거](https://docs.gov-nhncloud.com/ko/Data%20%26%20Analytics/Log%20%26%20Crash%20Search/ko/overview-gov/) | 공공기관용 서비스 문서이므로 일반 상용 콘솔과 동일하다고 단정하지 않음. |
| Observe | Log Explorer에서 데이터셋을 고르고 왼쪽 필터를 선택하면 쿼리 빌더에 반영된다. Raw 행을 선택하면 오른쪽 상세 패널이 열리고 Patterns와 Chart로 전환한다.<br>참고: 원본 로그·패턴·시각화 사이의 조사 전환과 측면 상세 | 문서 설명<br>[문서](https://docs.observeinc.com/docs/log-explorer) · [추가 근거](https://docs.observeinc.com/docs/use-live-mode-in-logs-explorer) | Live Mode는 라이선스 조건이 있으며 15분 후 자동 비활성화된다고 문서에 설명. |
| Cribl Search | Logs 화면에 KQL 쿼리 상자, 시간 선택, 샘플링, 데이터셋 목록, 최근 History와 Sample Searches를 배치한다고 설명한다. History에서 지난 검색의 결과를 다시 보거나 재사용한다.<br>참고: 검색 작성 공간과 데이터셋·검색 이력을 가까이 둔 재탐색 | 문서 설명<br>[문서](https://docs.cribl.io/search/tour/) · [추가 근거](https://docs.cribl.io/search/history/) | 공식 UI Tour는 버전별 UI 변경 가능; 이미지 직접 확인이나 검색 실행은 하지 않음. |

### 오픈소스·설치형·개발 도구

| 제품·도구 | UI 설명과 참고점 | 근거·공식 출처 | 범위·주의 |
| --- | --- | --- | --- |
| Grafana Logs Drilldown / Explore | 서비스별 로그량 시계열과 최근 로그 미리보기에서 시작하고 Logs·Labels·Fields·Patterns 탭으로 좁힌다. 로그 행의 주변 맥락·유사 로그를 열고 상세 필드와 필터를 조작할 수 있다. Logs·Table·JSON 모드를 전환한다.<br>참고: 서비스 요약에서 필드와 패턴으로 이어지는 탐색 흐름 | 이미지+문서<br>[문서](https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/simplified-exploration/logs/get-started/) · [추가 근거](https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/simplified-exploration/logs/view-logs/) | Loki는 저장 엔진이며 별도 UI 제품으로 세지 않는다. Drilldown은 Loki 데이터 소스 전용이고 Explore와 같은 Grafana 계열이다. |
| Graylog | Search에서 스트림 조건과 쿼리를 적용하고 사이드바의 사전 정의 위젯으로 Log View·Message Table·집계를 추가한다. 메시지 행을 클릭해 필드 상세를 보고 필드를 열로 추가할 수 있다.<br>참고: 검색 결과와 위젯·필드 동작의 연결 | 문서 설명<br>[문서](https://go2docs.graylog.org/current/interacting_with_your_log_data/widgets.html) · [추가 근거](https://go2docs.graylog.org/current/making_sense_of_your_log_data/search_your_log_data.html) | 설명은 공식 문서의 현재 위젯 기준이며 실제 화면 배치나 버전별 차이를 확인하지 않았다. |
| OpenSearch Dashboards | Discover는 필드 선택, 시간 범위, 검색과 필터, 시간 히스토그램, 결과 테이블로 구성된다. 행을 펼쳐 Table·JSON을 보고 주변 문서로 이동하며 히스토그램에서 시간대를 드래그한다. 새 Observability Stack 문서는 Builder와 PPL Code 모드를 설명한다.<br>참고: 필드 선택과 시간 분포를 통한 검색 범위 축소 | 문서 설명<br>[문서](https://docs.opensearch.org/latest/dashboards/discover/index-discover/) · [추가 근거](https://docs.opensearch.org/latest/observing-your-data/event-analytics/) · [추가 근거](https://observability.opensearch.org/docs/investigate/discover-logs/) | Discover는 범용 문서 탐색 UI다. Event Analytics는 별도 고전 관측성 앱이며 새 워크스페이스 구성에서 사용 가능성이 다르다. 새 Observability Stack 문서와 기존 Dashboards 앱을 동일 버전·배치로 합치지 않는다. |
| OpenObserve | 스트림과 시간을 선택하고 쿼리를 실행하며 비SQL과 SQL 편집 모드를 전환한다. 히스토그램과 차트를 켜고 끄며 결과 행에서 Table·JSON 상세를 연다.<br>참고: 쿼리 모드 전환과 결과 상세 | 이미지+문서<br>[문서](https://openobserve.ai/docs/user-guide/data-exploration/logs/logs/) | 로그·메트릭·트레이스 상관 탭은 문서상 Enterprise Edition 및 상관 설정에 의존한다. |
| SigNoz | 왼쪽 빠른 필터와 필터 표현식, List·Time Series·Table 보기를 제공한다. 심각도별 빈도 차트와 Live 일시정지·재개가 있으며 상세 드로어의 Overview·Context·Metrics 탭을 사용한다.<br>참고: 목록에서 상세·전후 맥락으로 이어지는 드로어 | 이미지+문서<br>[문서](https://signoz.io/docs/userguide/logs_query_builder/) · [추가 근거](https://signoz.io/docs/logs-management/querying-logs/) | Live는 List View에 한정되며 Metrics 문맥은 관련 리소스 속성에 의존한다. |
| HyperDX / ClickStack UI | 검색 페이지에서 필터 사이드바와 히스토그램 Group by로 필드별 로그량을 살펴본다. 이벤트 사이드 패널 및 Trace logs의 시간순 테이블을 통해 로그를 선택하거나 동일 맥락의 검색으로 이동한다.<br>참고: 필터 필드와 히스토그램 분해 연결 | 문서 설명<br>[문서](https://clickhouse.com/blog/whats-new-in-clickstack-october-2026) · [추가 근거](https://clickhouse.com/videos/02-2026-webinar-managed-clickstack) | ClickStack UI는 인수된 HyperDX 기반으로 한 계열이다. 2026년 10월 발표의 기능은 구버전과 다를 수 있다. |
| Parseable | 왼쪽 필드 그룹에서 필드 값과 건수를 확인하고 필터를 적용하면 상단 필터 칩과 범주별 로그량 차트 및 테이블이 갱신된다. 열 추가와 행 확장, Show context에서 기준 로그 전후를 확인한다.<br>참고: 필드 값의 빈도, 차트 범례와 결과 표 연결 | 문서 설명<br>[문서](https://www.parseable.com/docs/user-guide/logs) | 이미지 링크는 접근 시간 초과로 화면을 직접 확인하지 못했다. |
| VictoriaLogs VMUI | 왼쪽 스트림 필드나 값을 클릭해 필터를 적용하고 LogsQL을 실행한다. 결과는 Group·Table·JSON·Live 모드이며 Table에서 행을 펼쳐 필드를 본다.<br>참고: 스트림 필드 기반 필터와 결과 표현 전환 | 문서 설명<br>[문서](https://docs.victoriametrics.com/victorialogs/querying/) · [추가 근거](https://docs.victoriametrics.com/playgrounds/) | VictoriaLogs 기본 UI는 VMUI 또는 VLUI로도 불린다. 공개 플레이그라운드는 직접 조작하지 않았다. |
| Seq (Datalust) | 필터 바에서 텍스트·속성을 검색하고 이벤트를 펼쳐 속성 옆 선택으로 필터를 만든다. 검색 아래 히스토그램으로 시간 탐색하고 선택한 signal은 결과 위 태그로 표시된다.<br>참고: 구조화 속성에서 필터를 만드는 상호작용 | 문서 설명<br>[문서](https://docs.datalust.co/docs/query-syntax) · [추가 근거](https://docs.datalust.co/v2024.1/docs/whats-new) | signal 태그 설명은 2024.1 문서의 2022.1 기능 설명이다. 현재 설치 화면을 검증하지 않았다. |
| Logdy | 실시간 로그의 테이블 열 표시를 바꾸고 행을 표시하거나 읽음·읽지 않음으로 필터링한다. 로그 드로어에서 방향키로 이전·다음 메시지로 이동한다.<br>참고: 실시간 목록의 읽음 상태와 빠른 행 탐색 | 문서 설명<br>[문서](https://logdy.dev/docs/explanation/features/miscellaneous) · [추가 근거](https://github.com/logdyhq/logdy-core) | 공식 저장소는 로컬 뷰어와 TypeScript 사용자 정의 파서·열을 설명한다. 데모는 직접 실행하지 않았다. |
| Quickwit | 2022년 0.3 발표 기준 Discover에 왼쪽 인덱스 선택, 상단 검색창과 날짜 선택, 중앙 결과 문서 테이블이 있다. 관리 섹션은 인덱스와 클러스터를 표시한다.<br>참고: 인덱스 선택과 검색·결과의 기본 구성 | 문서 설명<br>[문서](https://quickwit.io/blog/quickwit-0.3) · [추가 근거](https://quickwit.io/docs/deployment/deployment-modes) | 과거 0.3 발표 기준의 UI로 현재 배치·기능은 확인하지 못했다. 검색·관리 UI를 관측성 전용 완성형 UI로 간주하지 않는다. |
| highlight.io | 과거 공식 자료는 로그 검색, 로그와 관련된 세션·오류 연결을 설명한다. 구 문서 검색 설명에는 메시지 기본 검색과 속성 비교·저장 검색이 있다.<br>참고: 로그와 세션·오류 맥락 연결 | 문서 설명<br>[문서](https://github.com/highlight/highlight/blob/main/docs-content/general/1_welcome.md) · [추가 근거](https://github.com/highlight/highlight/blob/main/blog-content/launchdarkly-migration.md) | LaunchDarkly가 2025년 인수했고 공식 이관 안내는 Highlight.io 서비스 종료일을 2026-02-28로 명시한다. 구 문서 주소는 현재 LaunchDarkly로 리디렉션되며 화면 구성은 직접 확인하지 못했다. |

### 인프라·보안 인접

| 제품·도구 | UI 설명과 참고점 | 근거·공식 출처 | 범위·주의 |
| --- | --- | --- | --- |
| CrowdStrike Falcon LogScale (Humio) | Query Editor, 왼쪽 필드, 시간 히스토그램 및 이벤트 목록. 이벤트 선택으로 Fields·Message·JSON 검사 패널 및 필드 포함·제외 동작 제공.<br>참고: 필드와 원문을 잇는 이벤트 검사 | 문서 설명<br>[문서](https://library.humio.com/logscale-getting-started/product-tutorial.html) · [추가 근거](https://library.humio.com/logscale-gdo/searching-data-inspecting-events.html) | 공식 문서는 Falcon LogScale 명칭과 humio.com 문서 도메인을 병용. 내장 튜토리얼 언급은 문서 설명이며 직접 실행하지 않음. |
| SentinelOne DataSet / Scalyr | 공식 Scalyr 자료는 검색 결과 이벤트에서 Inspect Fields를 선택해 파싱된 필드 확인을 설명한다. 다른 공식 자료는 DataSet의 시각화 및 라이브 테일을 설명한다.<br>참고: 이벤트의 파싱 결과 검사 | 문서 설명<br>[문서](https://www.sentinelone.com/blog/sending-logs-scalyr-fluentd/) · [추가 근거](https://www.sentinelone.com/press/sentinelone-launches-dataset-a-revolutionary-live-enterprise-data-platform/) | 2022 공식 발표에 따르면 DataSet은 인수한 Scalyr를 기반으로 출시됨. 연결된 검색 UI 사례는 이전 Scalyr 자료여서 현행 UI·상품명과 동일하다고 확인되지 않음. |
| Devo | Data Search에서 데이터 테이블 또는 LINQ 텍스트 쿼리를 선택하고, 검색창 결과 표의 필드나 셀 값으로 포함·제외 필터를 적용한다. 타임라인은 쿼리에 맞춰 갱신된다.<br>참고: 표 셀 값에서 검색 필터 적용 | 문서 설명<br>[문서](https://docs.devo.com/space/latest/95191041/Filter%2Bdata) · [추가 근거](https://devodocs.atlassian.net/wiki/spaces/latest/pages/94764264/Accessing%2Bdata%2Btables) | 공식 문서 설명 기준. 선택한 데이터 및 쿼리에 따라 화면은 달라질 수 있음. |
| Broadcom VCF Operations for Logs | Explore Logs (Interactive Analytics)에서 호스트명 및 시간 범위 필터로 이벤트를 찾는 흐름을 문서화한다.<br>참고: 인프라별 로그 탐색 | 문서 설명<br>[문서](https://knowledge.broadcom.com/external/article/461107/how-to-validate-the-esxi-syslog-configur.html) · [추가 근거](https://vrlisizer.vmware.com/) | 공식 명칭은 VCF Operations for Logs이며 과거 Aria Operations for Logs와 vRealize Log Insight로 불림. UI 근거는 Aria 8.x 문서이므로 현 VCF 화면과 동일하다고 단정할 수 없음. Aria Operations for Logs SaaS는 2025-08-01 종료됐으며 별도 온프레미스 제품과 구분: https://blogs.vmware.com/cloud-foundation/2024/09/18/vmware-cloud-on-aws-sddc-logs-update/ |
| ManageEngine EventLog Analyzer | Basic 직접 입력 및 Advanced 조건 빌더, 원본 로그 결과와 그래프를 문서화한다. 그래프의 지점을 클릭하거나 영역을 드래그해 시간 범위와 결과 표를 좁힌다.<br>참고: 차트 선택과 결과 표 연동 | 문서 설명<br>[문서](https://www.manageengine.com/log-management/help/working-with-log360/search/how-to-search-logs.html) · [추가 근거](https://www.manageengine.com/products/eventlog/help/search-log/eventlog-analyzer-how-to-search-logs.html) | 첫 공식 문서는 EventLog Analyzer와 Log360 모두에 적용된다고 명시. 두 번째 구형 도움말의 화면은 현재 버전과 다를 수 있음. |
| Wazuh dashboard | Office 365 Events 화면에서 구조화 검색과 필드 필터를 사용하고 경보 행을 확장해 전체 로그 및 디코더 등 상세를 본다. 아카이브는 Explore > Discover에서 인덱스와 시간 범위로 탐색한다.<br>참고: 보안 경보 행의 상세와 원본 로그 | 문서 설명<br>[문서](https://documentation.wazuh.com/current/cloud-security/office365/monitoring-office365-activity.html) · [추가 근거](https://documentation.wazuh.com/current/user-manual/manager/event-logging.html) | Events는 일반적으로 규칙이 만든 경보이며, 경보가 발생하지 않은 아카이브 이벤트와 다름. 아카이브 확인에는 별도 설정이 필요. |
| Microsoft Sentinel Logs | Sentinel Logs의 KQL 편집기에서 쿼리를 실행해 결과를 확인한다. Hunting 쿼리의 결과 링크는 Log Analytics 화면을 열고 쿼리 아래 일치 항목을 표시한다.<br>참고: 보안 헌팅 결과와 원본 쿼리 연결 | 문서 설명<br>[문서](https://learn.microsoft.com/en-us/azure/sentinel/powerbi) · [추가 근거](https://learn.microsoft.com/en-us/azure/sentinel/hunting) | 포털별 탐색 경로가 다름. Microsoft는 2027-03-31 이후 Azure 포털 지원 종료 및 Defender 포털 전환을 안내: https://learn.microsoft.com/en-us/azure/sentinel/investigate-large-datasets |
| Google Security Operations UDM Search | SIEM Search의 쿼리와 시간 선택, 이벤트 표 및 집계 패널, 이벤트·경보 시간 차트. 행을 선택하면 Event Viewer에서 필드 트리, Raw Log, Alerts, Entities 탭을 볼 수 있다.<br>참고: 정규화 이벤트와 원본 로그·엔터티 연결 | 문서 설명<br>[문서](https://docs.cloud.google.com/chronicle/docs/investigation/udm-search) · [추가 근거](https://docs.cloud.google.com/chronicle/docs/investigation/udm-search-investigate-entity) | Basic 모드는 차트와 히트맵을 숨기며 Advanced와 표시가 다르다. UDM은 보안 중심 정규화 데이터 모델임. |

### 개발자 중심·신흥 서비스

| 제품·도구 | UI 설명과 참고점 | 근거·공식 출처 | 범위·주의 |
| --- | --- | --- | --- |
| Better Stack | Source·검색·시간 선택으로 로그를 좁히고, Live tail의 레벨 분포와 로그 행에서 상세를 연다. 공식 변경 안내는 Presets와 히스토그램을 설명한다.<br>참고: 로그 행의 읽기와 선택 상태, 상세 패널 | 이미지+문서<br>[문서](https://betterstack.com/docs/logs/using-logtail/live-tail-query-language/) · [추가 근거](https://betterstack.com/community/blog/live-tail-presets/) | 제품 소개의 기울임·배경·페이드는 홍보용 연출이다. 앱 전체의 실제 대비나 크기를 뜻하지 않는다. |
| Axiom | Stream은 dataset·필터·시간 범위·일시정지와 이벤트 상세를 제공한다. Builder는 source·filter·summarize를 구성하고 실행 중 검사·일치·반환 행 수를 표시한다.<br>참고: 원문에 넓은 폭을 주고 필드·원문 상세를 분리 | 이미지+문서<br>[문서](https://axiom.co/docs/query-data/stream) · [추가 근거](https://axiom.co/docs/query-data/explore) | Stream 문서 이미지는 이전 내비게이션을 포함한다. 최신 Builder와 같은 화면으로 합치지 않는다. |
| Sentry Logs | 검색과 시간 선택, 발생량 그래프, 로그 목록과 집계 전환. 2026 여름 안내는 행 고정·검색어 강조·필터 칩 및 상세 개선을 설명한다.<br>참고: 검색·그래프·목록의 위계, 선택·고정 행 구분 | 이미지+문서<br>[문서](https://blog.sentry.io/sentry-logs-summer-2026-roundup/) · [추가 근거](https://docs.sentry.io/product/explore/logs/) | 블로그 캡처 외곽의 보라색 배경은 제품 내부 색상과 구분한다. |
| Honeycomb | Home의 Logs 뷰는 로그량·레벨·상위 메시지를 시각화한다. 차트에서 필터·원본 이벤트로 이동하고 Explore Data에서 로그 행 표현을 사용한다.<br>참고: 집계에서 원문으로 내려가는 동선 | 문서 설명<br>[문서](https://docs.honeycomb.io/investigate/observe/honeycomb-home) · [추가 근거](https://docs.honeycomb.io/investigate/debug/log-data-in-honeycomb) | 전용 로그 목록과 Home의 집계 대시보드는 서로 다른 표면이다. |
| Dash0 | 왼쪽 저장 뷰, 상단 필터·시간 선택, 레벨별 차트와 Table·Groups·Patterns·Triage 보기. 목록의 severity·time·resource·body 열을 설정한다.<br>참고: 큰 장식 없이 도구막대·차트·표를 분리 | 이미지+문서<br>[문서](https://www.dash0.com/docs/dash0/telemetry/logging/about-logging) | 공식 캡처는 어두운 테마의 한 상태다. 테마 전체 지원 여부를 이 이미지로 판정하지 않는다. |
| Pydantic Logfire | Live에서 로그와 span을 함께 읽고 SQL 검색 패널을 연다. 시간 분포·접기·상세 패널로 조사한다.<br>참고: 연속 기록·계층·상세를 잇는 화면 | 이미지+문서<br>[문서](https://pydantic.dev/docs/logfire/observe/live/) | 기간 막대는 span 소요시간이다. 순수 로그 행의 기본 장식으로 옮길 근거는 아니다. |
| Uptrace | Groups와 개별 Logs 및 Timeseries 보기를 나눈다. 필터·검색·분포와 이벤트 상세의 속성·JSON·관련 trace 및 context를 설명한다.<br>참고: 반복 패턴 요약과 원문 목록 구분 | 문서 설명<br>[문서](https://uptrace.dev/features/logs) | 그룹화·트레이스 연계는 LogDock 첫 출시 기능 채택이 아니다. |
| KloudMate | 상단 검색과 시간 선택, 사이드 필터, 로그량 그래프와 결과 목록, 전체 payload 상세. Saved Queries는 이름·설명·폴더로 저장한다.<br>참고: 필터·그래프·목록의 기본 구조 | 문서 설명<br>[문서](https://docs.kloudmate.com/logs/log-explorer/) | Assistant와 아카이브 검색 등은 이번 디자인 비교의 기능 확정 범위 밖이다. |
| Last9 | Builder·Editor, 필터 칩·시간 선택·레벨별 차트·동적 열. 클릭하면 본문·속성·리소스·Related Logs 등을 담은 측면 상세가 열린다.<br>참고: 밝은 화면의 밀도와 목록·상세 역할 구분 | 이미지+문서<br>[문서](https://last9.io/docs/logs-explorer/) | Builder에서 Editor로 변환되지만 반대 방향은 같지 않다. 오래된 beta 발표 대신 현 문서를 기준으로 삼았다. |
| Logit.io | 공식 문서는 OpenSearch Dashboards·검색과 Grafana·Kibana 시각화 경로를 안내한다. Dashboard Library는 데이터 소스별 대시보드를 고른다.<br>참고: 관리 콘솔과 내장 시각화 도구의 경계 | 문서 설명<br>[문서](https://logit.io/docs/log-management/opensearch/) · [추가 근거](https://logit.io/docs/log-management/opensearch/opensearch-dashboards/dashboard-library/) | 독자적인 새 로그 탐색 UI로 세지 않고 호스팅 서비스 항목으로 기록한다. |
| groundcover | 쿼리 빌더로 검색·필터하고 특정 시각 주변 로그와 관련 메트릭·trace를 조사하는 흐름을 공식 제품 페이지가 설명한다.<br>참고: 로그와 운영 리소스 문맥의 연결 | 문서 설명<br>[문서](https://www.groundcover.com/product/logs) | 공개 제품 설명 근거이며 전체 UI 배치와 실제 조작은 확인하지 않았다. |
| Cloudflare Workers Logs | Query Builder는 key·operator·value 필터와 텍스트 검색, Visualizations·Invocations·Events 뷰를 제공한다. Events에는 표시 필드를 더할 수 있다.<br>참고: 조건 빌더와 실행 단위·개별 이벤트 보기의 구분 | 문서 설명<br>[문서](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) · [추가 근거](https://developers.cloudflare.com/workers/observability/query-builder/) | Workers 범위의 로그 도구다. 임의 서버 로그 수집 서비스와 범위가 같지 않다. Baselime과 별개로 기록한다. |
| LaunchDarkly Observability | 로그·오류·세션·trace에 속성 비교와 논리식을 적용한다. 로그의 키 없는 입력은 message 검색으로 처리한다.<br>참고: 신호 종류를 넘나드는 일관된 검색 문법 | 문서 설명<br>[문서](https://launchdarkly.com/docs/home/observability/search) · [추가 근거](https://github.com/highlight/highlight/blob/main/blog-content/launchdarkly-migration.md) | Highlight.io의 후속 경로다. 검색 문법 근거이며 현행 로그 화면의 상세 외형은 미확인. |

## 5. LogDock v0.2를 점검할 순서

다음은 설계 의견이며 적용하지 않았다. 현재 합의인 정보 밀도 높은 운영 도구형·첫 출시 밝은 테마·v0.2 유지가 기준이다. 실시간, trace 연계, AI 분석, 패턴 그룹, 임의 대시보드, 행 고정, export를 새로 채택한 것이 아니다.

1. **검색과 결과의 관계:** 검색 조건·시간 선택·실행·적용 범위가 한 흐름으로 읽히는지 본다. Axiom·Sentry의 단순한 상단과 Google Cloud의 적용 시간 안내를 비교한다. LogDock의 입력 중 조건과 실행된 조건 구분을 유지한다.
2. **행 읽기:** 본문 폭, 시간·레벨·출처의 정렬, 한 줄과 여러 줄 처리, 긴 JSON·stack trace를 확인한다. Datadog·Elastic의 밀도와 Axiom의 원문 폭을 같은 브라우저 폭에서 비교한다. 원본 이미지의 글자 크기를 실제 CSS 픽셀로 단정하지 않는다.
3. **색의 역할:** 중립 바탕 위에 상태·선택·일치 강조가 겹쳐도 구분되는지 본다. Sentry의 선택 배경, Dash0·Last9의 레벨 막대, Grafana의 본문 강조를 비교한다. LogDock의 레벨·수집 상태·품질은 서로 다른 의미이고 색만으로 표시하지 않는다.
4. **상세 패널:** 원래 선택 행과 목록 맥락이 남는지, 패널이 본문을 얼마나 가리는지, 본문·필드·시각 품질·주변 조회가 구분되는지 본다. Axiom·SigNoz·Grafana·Last9를 비교한다.
5. **분포와 필터:** 차트가 로그 목록을 지나치게 아래로 밀지 않는지, 범례와 집계 범위가 명확한지, 필터 건수가 확정·근사·미확인 중 무엇인지 확인한다. 현재 명세의 건수·조회 일관성 계약을 다른 제품의 캡처에 맞춰 바꾸지 않는다.
6. **화면 상태:** 0건, 로딩, 오류, 취소, 시간 만료, 시각 대체·의심, 일부 미확인, 수집 지연을 각각 검토한다. 공개 이미지가 정상 결과 중심이라 이 상태들의 외형은 대부분 비교 증거가 부족하다. LogDock 명세를 우선한다.
7. **장식의 역할:** 카드·알약·그림자·반투명 효과가 정보 그룹·선택·패널 층위를 실제로 설명하는지 하나씩 본다. Better Stack의 홍보 배경과 Sentry의 이미지 외곽을 앱 부품으로 해석하지 않는다. 이번 조사만으로 기존 v0.2를 되돌리거나 덜어내는 결정을 내리지 않는다.

실제 검토를 이어간다면 Sentry → Last9 → Axiom → SigNoz/Grafana → Datadog/Elastic 순서가 효율적이다. 전체 미감, 밝은 목록, 원문, 상세, 고밀도 순으로 비교 대상을 좁힐 수 있기 때문이다.

## 6. 명칭·수명주기와 남은 한계

- **Highlight.io:** 공식 이관 안내는 2026-02-28 종료와 LaunchDarkly Observability 이전을 안내한다. 현재 서비스 후보와 과거 참고 자료를 구분했고 후속 LaunchDarkly 항목도 넣었다. [공식 이관 안내](https://github.com/highlight/highlight/blob/main/blog-content/launchdarkly-migration.md)
- **Baselime:** 공식 사이트는 Cloudflare 합류를 안내하지만 이번 조사에서는 독립 서비스의 현재 이용 가능 상태를 확정하지 않았다. 과거 참고 경로로만 언급하며 Workers Logs와 같은 UI라고 간주하지 않는다. [공식 사이트](https://baselime.io/)
- **DataSet/Scalyr·Broadcom:** 이전 명칭 자료와 현행 상품을 구분한다. 공개 근거가 제한적이라 현재 화면의 외형 평가를 보류했다. 관련 공식 자료는 전체 목록에 연결했다.
- **Quickwit·Seq:** 과거 UI 설명을 현재 화면이라고 주장하지 않는다. 제품 자체의 서비스 종료를 뜻하는 표기도 아니다.
- **보안 인접:** Wazuh·Sentinel·Google SecOps 등은 경보·정규화 이벤트·보안 조사에 초점을 둔다. 일반 앱 로그 탐색과 동일한 요구라고 간주하지 않는다.
- **확인 한계:** 각 제품 로그인, 실제 검색·실시간 스트림, 키보드·낭독기, 반응형, 성능, 설치·수집은 실행하지 않았다. 대표 이미지 밖 화면과 접근 제한 자료는 미확인이다. 이 목록 밖의 지역 서비스·소규모 도구·전용 Kubernetes 뷰어까지 시장 전체를 다 확인한 것은 아니다.

## 7. 검증 기록

공식 웹 자료를 조사하고 대표 이미지 16건을 내려받아 임시 위치에서 직접 관찰했다. 외부 이미지는 저장소에 복사하지 않았다. 구조화 데이터의 제품 57개·중복 이름 없음·이미지 관찰 제품 12개·이미지 16건, 공식 출처 URL 99개의 형식, 문서의 로컬 링크 누락 없음, HTML 목록 57행을 정적으로 확인했다. 프로젝트 pin인 Node 24.22.2의 `node --check`로 HTML의 JavaScript 문법 검사를 통과했다. 브라우저 접근 호스트가 없고 네이티브 앱 연결도 시간 초과되어 HTML 렌더링·선택·검색의 브라우저 실행 확인은 완료하지 못했다. 정적 검사와 공식 이미지 관찰을 제품 실행 검증으로 확대하지 않는다.
