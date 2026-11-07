-- 로그 테이블(계약 3.2절, 측정 V6 구성). 계약 DDL의 `GRANULARITY N`은 시제품 값 4로 둔다.
-- 조회 API·수신 서버 시험은 이 파일의 `CREATE TABLE logs`를 시험 표 이름으로 바꿔 만든다. 운영 적용은 설치 절차에서 한다.
-- 보관 기간(TTL)은 합의값 6개월이며 서버 설정으로 바꾸면 TTL도 같이 바꾼다(3.3절).
CREATE TABLE logs
(
    connection_id      UInt32,
    generation         UInt16,
    seq                UInt64,
    kind               Enum8('event' = 1, 'rejected' = 2, 'boundary' = 3),

    service_id         UInt32,
    server_id          Nullable(UInt32),
    environment        LowCardinality(String),

    stream_type        Enum8('file' = 1, 'journald' = 2),
    stream_id          String,
    stream_label       String,
    stream_offset      Nullable(UInt64),
    journald_cursor    String,

    received_at        DateTime64(6, 'UTC'),
    observed_at        DateTime64(6, 'UTC'),
    occurred_at        Nullable(DateTime64(6, 'UTC')),
    ref_time           DateTime64(6, 'UTC'),
    ref_time_source    Enum8('body' = 1, 'envelope' = 2, 'observed' = 3),
    time_flags         UInt8,

    level              Enum8('UNKNOWN' = 0, 'TRACE' = 1, 'DEBUG' = 2, 'INFO' = 3,
                             'WARN' = 4, 'ERROR' = 5, 'FATAL' = 6),
    level_raw          String,

    body               String CODEC(ZSTD(3)),
    body_unescaped     String CODEC(ZSTD(3)),
    body_is_base64     Bool,
    parse_status       Enum8('none' = 0, 'ok' = 1, 'partial' = 2, 'failed' = 3),
    parse_rule_version UInt32,
    fields             JSON CODEC(ZSTD(3)),
    field_paths        Array(String),
    fields_truncated   Bool,

    reject_reason      LowCardinality(String),
    reject_limit_bytes Nullable(UInt64),
    boundary_kind      LowCardinality(String),
    boundary_detail    String,

    INDEX idx_received   received_at   TYPE minmax GRANULARITY 1,
    INDEX idx_connection connection_id TYPE set(0) GRANULARITY 4,
    INDEX idx_service    service_id    TYPE set(0) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toDate(received_at)
ORDER BY (service_id, ref_time, connection_id, generation, seq)
TTL toDateTime(received_at) + INTERVAL 6 MONTH DELETE
SETTINGS ttl_only_drop_parts = 1;
