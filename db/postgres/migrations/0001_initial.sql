-- LogDock 관리 DB 첫 마이그레이션.
-- 2026-11-06 API 계약 초안 3.4절의 DDL 초안 블록 넷을 그대로 이어 붙여 옮겼다. 이 파일이 기준이다.
-- 2026-11-05 사용자가 개발용 DB(logdock_dev)에 같은 내용을 한 트랜잭션으로 적용했다.
-- 적용: 소유 역할(logdock_owner)로 psql --single-transaction -v ON_ERROR_STOP=1 -f 이 파일.

-- 초안. 2026-11-05 개발용 PostgreSQL 18.6에 적용 확인(사용자 실행).
-- 1. 공통과 계정
CREATE SCHEMA logdock;
SET search_path = logdock;

-- 이름 규칙(5.3절): 앞뒤 공백·빈 값·제어 문자 불가, NFC로 저장. 길이 상한은 앱이 검사한다
CREATE DOMAIN name_text AS text
    CHECK (VALUE = btrim(VALUE) AND VALUE <> '' AND VALUE !~ '[[:cntrl:]]'
           AND VALUE IS NFC NORMALIZED);

-- 메일 주소: 형식은 앱이 검사하고 DB는 공백·제어 문자와 @ 개수만 막는다
CREATE DOMAIN mail_address AS text
    CHECK (VALUE ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$');

CREATE TABLE accounts (
    id                  integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                name_text   NOT NULL,
    password_hash       text        NOT NULL,
    password_changed_at timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    version             integer     NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX accounts_name_uq ON accounts (lower(name));

CREATE TABLE sessions (
    id_hash        bytea       PRIMARY KEY,
    account_id     integer     NOT NULL REFERENCES accounts (id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_active_at timestamptz NOT NULL DEFAULT now(),
    reauth_at      timestamptz,
    revoked_at     timestamptz,
    revoke_reason  text,
    CONSTRAINT sessions_revoke CHECK (
        (revoked_at IS NULL) = (revoke_reason IS NULL)
        AND (revoke_reason IS NULL OR revoke_reason IN
             ('logout', 'terminate_all', 'password_change', 'password_reset_local')))
);
CREATE INDEX sessions_active_idx ON sessions (account_id) WHERE revoked_at IS NULL;

CREATE TABLE login_throttle (
    key_hash          bytea       PRIMARY KEY,
    failures          integer     NOT NULL DEFAULT 0,
    window_started_at timestamptz NOT NULL DEFAULT now(),
    blocked_until     timestamptz,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT login_throttle_failures CHECK (failures >= 0)
);

-- 2. 수집
CREATE TABLE services (
    id          integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        name_text   NOT NULL,
    state       text        NOT NULL DEFAULT 'active',
    archived_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    version     integer     NOT NULL DEFAULT 1,
    CONSTRAINT services_state CHECK (state IN ('active', 'archived')),
    CONSTRAINT services_archived_at CHECK ((state = 'archived') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX services_name_uq ON services (lower(name));

CREATE TABLE servers (
    id           integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    display_name name_text   NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    version      integer     NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX servers_display_name_uq ON servers (lower(display_name));

CREATE TABLE connections (
    id                    integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    service_id            integer     NOT NULL REFERENCES services (id),
    server_id             integer     REFERENCES servers (id),
    environment           name_text,
    target_type           text        NOT NULL,
    target_path           text,
    journald_kind         text,
    journald_name         text,
    target_identity       text        GENERATED ALWAYS AS (
                              CASE WHEN target_type = 'journald'
                                   THEN 'journald:' || journald_kind || ':' || journald_name
                                   ELSE 'path:' || target_path
                              END) STORED,
    format_type           text        NOT NULL,
    event_start_pattern   text,
    log_timezone          text,
    extraction_rule       jsonb,
    max_event_bytes       integer     NOT NULL,
    config_version        integer     NOT NULL DEFAULT 1,
    management_state      text        NOT NULL DEFAULT 'pending',
    agent_instance_id     text,
    duplicate_of          integer     REFERENCES connections (id),
    archived_at           timestamptz,
    archived_with_service boolean     NOT NULL DEFAULT false,
    created_at            timestamptz NOT NULL DEFAULT now(),
    config_issued_at      timestamptz,
    agent_applied_at      timestamptz,
    first_read_at         timestamptz,
    first_received_at     timestamptz,
    first_searchable_at   timestamptz,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    version               integer     NOT NULL DEFAULT 1,
    -- 수집 대상(2.8절): 절대 경로, 파일명 규칙은 이름 부분에만 * ?, journald는 종류와 이름
    CONSTRAINT connections_target CHECK (
        (target_type = 'file'
            AND target_path IS NOT NULL AND target_path LIKE '/%' AND target_path !~ '[*?]'
            AND journald_kind IS NULL AND journald_name IS NULL)
     OR (target_type = 'file_pattern'
            AND target_path IS NOT NULL AND target_path LIKE '/%' AND target_path ~ '[*?]'
            AND target_path !~ '[*?].*/'
            AND journald_kind IS NULL AND journald_name IS NULL)
     OR (target_type = 'journald'
            AND target_path IS NULL
            AND journald_kind IS NOT NULL AND journald_kind IN ('container', 'unit')
            AND journald_name IS NOT NULL AND journald_name <> ''
            AND journald_name !~ '[[:cntrl:]]')),
    CONSTRAINT connections_format CHECK (format_type IN ('text', 'json', 'multiline')),
    CONSTRAINT connections_event_start CHECK ((format_type = 'multiline') = (event_start_pattern IS NOT NULL)),
    CONSTRAINT connections_extraction_rule CHECK (extraction_rule IS NULL OR jsonb_typeof(extraction_rule) = 'object'),
    CONSTRAINT connections_max_event_bytes CHECK (max_event_bytes > 0),
    CONSTRAINT connections_config_version CHECK (config_version >= 1),
    CONSTRAINT connections_state CHECK (management_state IN ('pending', 'active', 'stopping', 'blocked', 'archived')),
    CONSTRAINT connections_archived_at CHECK ((management_state = 'archived') = (archived_at IS NOT NULL)),
    CONSTRAINT connections_archived_with_service CHECK (NOT archived_with_service OR management_state = 'archived')
);
-- 같은 서버·같은 대상의 보관되지 않은 연결은 하나(Q07-06). 서버 표시명이 없으면 2.7절 관측으로 확인한다
CREATE UNIQUE INDEX connections_same_target_uq ON connections (server_id, target_identity)
    WHERE server_id IS NOT NULL AND management_state <> 'archived';
CREATE INDEX connections_service_idx ON connections (service_id);

CREATE TABLE connection_configs (
    connection_id integer     NOT NULL REFERENCES connections (id),
    version       integer     NOT NULL,
    content       jsonb       NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (connection_id, version),
    CONSTRAINT connection_configs_content CHECK (jsonb_typeof(content) = 'object')
);

CREATE TABLE ingest_keys (
    key_id              text        PRIMARY KEY,
    connection_id       integer     NOT NULL REFERENCES connections (id),
    secret_hash         bytea       NOT NULL,
    state               text        NOT NULL DEFAULT 'valid',
    slot                smallint,
    issued_as           text        NOT NULL,
    issued_at           timestamptz NOT NULL DEFAULT now(),
    revoke_requested_at timestamptz,
    revoked_at          timestamptz,
    revoke_observed_at  timestamptz,
    invalidated_at      timestamptz,
    CONSTRAINT ingest_keys_key_id CHECK (key_id ~ '^[a-z0-9]+$'),
    CONSTRAINT ingest_keys_state CHECK (state IN ('valid', 'revoke_requested', 'revoked', 'invalidated')),
    CONSTRAINT ingest_keys_slot CHECK ((state = 'valid') = (slot IS NOT NULL) AND (slot IS NULL OR slot IN (1, 2))),
    CONSTRAINT ingest_keys_issued_as CHECK (issued_as IN ('register', 'issue', 'rotate')),
    CONSTRAINT ingest_keys_times CHECK (
        (state <> 'revoke_requested' OR revoke_requested_at IS NOT NULL)
        AND (state <> 'revoked' OR revoked_at IS NOT NULL)
        AND (state <> 'invalidated' OR invalidated_at IS NOT NULL))
);
-- 연결마다 유효 키는 둘까지(Q10-07). 앱의 연결 행 잠금과 함께 쓴다(PT-10)
CREATE UNIQUE INDEX ingest_keys_valid_slot_uq ON ingest_keys (connection_id, slot) WHERE state = 'valid';
CREATE INDEX ingest_keys_connection_idx ON ingest_keys (connection_id);

CREATE TABLE ingest_progress (
    connection_id integer     NOT NULL REFERENCES connections (id),
    generation    integer     NOT NULL,
    next_seq      bigint      NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (connection_id, generation),
    CONSTRAINT ingest_progress_generation CHECK (generation BETWEEN 1 AND 65535),
    CONSTRAINT ingest_progress_next_seq CHECK (next_seq >= 1)
);

CREATE TABLE deletion_blocks (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    connection_id integer     NOT NULL REFERENCES connections (id),
    ref_time_from timestamptz NOT NULL,
    ref_time_to   timestamptz NOT NULL,
    state         text        NOT NULL DEFAULT 'requested',
    requested_at  timestamptz NOT NULL DEFAULT now(),
    confirmed_at  timestamptz,
    CONSTRAINT deletion_blocks_range CHECK (ref_time_from < ref_time_to),
    CONSTRAINT deletion_blocks_state CHECK (state IN ('requested', 'confirmed', 'failed')),
    CONSTRAINT deletion_blocks_confirmed CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL))
);
CREATE INDEX deletion_blocks_connection_idx ON deletion_blocks (connection_id, ref_time_from);

CREATE TABLE connection_status (
    connection_id     integer     PRIMARY KEY REFERENCES connections (id),
    last_report_at    timestamptz NOT NULL,
    report            jsonb       NOT NULL,
    agent_instance_id text        NOT NULL,
    agent_version     text        NOT NULL,
    key_id            text        NOT NULL REFERENCES ingest_keys (key_id),
    clock_offset_ms   bigint,
    observed_states   text[]      NOT NULL DEFAULT '{}',
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE status_history (
    id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    connection_id    integer     NOT NULL REFERENCES connections (id),
    reported_at      timestamptz NOT NULL,
    changes          jsonb       NOT NULL,
    diag_write_error boolean     NOT NULL DEFAULT false
);
CREATE INDEX status_history_connection_idx ON status_history (connection_id, reported_at DESC);
CREATE INDEX status_history_reported_idx ON status_history (reported_at);

CREATE TABLE ingest_watermark (
    id                 smallint    PRIMARY KEY DEFAULT 1,
    searchable_through timestamptz NOT NULL,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ingest_watermark_single CHECK (id = 1)
);

-- 3. 검색·알림·메일
CREATE TABLE saved_searches (
    id               integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_account_id integer     NOT NULL REFERENCES accounts (id),
    name             name_text   NOT NULL,
    condition        jsonb       NOT NULL,
    time_mode        text        NOT NULL,
    time_range       jsonb       NOT NULL,
    time_basis       text        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    version          integer     NOT NULL DEFAULT 1,
    CONSTRAINT saved_searches_condition CHECK (jsonb_typeof(condition) = 'object'),
    CONSTRAINT saved_searches_time CHECK (
        (time_mode = 'relative' AND time_range ? 'last')
     OR (time_mode = 'absolute' AND time_range ?& ARRAY['from', 'to'])),
    CONSTRAINT saved_searches_time_basis CHECK (time_basis IN ('occurred', 'received'))
);
CREATE UNIQUE INDEX saved_searches_name_uq ON saved_searches (owner_account_id, lower(name));

CREATE TABLE alert_rules (
    id                   integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_account_id     integer     NOT NULL REFERENCES accounts (id),
    name                 name_text   NOT NULL,
    enabled              boolean     NOT NULL,
    condition            jsonb       NOT NULL,
    condition_version    integer     NOT NULL DEFAULT 1,
    window_minutes       integer     NOT NULL,
    threshold            integer     NOT NULL,
    resolve_wait_minutes integer,
    eval_state           text        NOT NULL DEFAULT 'normal',
    state_since          timestamptz NOT NULL DEFAULT now(),
    resolve_streak       integer     NOT NULL DEFAULT 0,
    quality              text,
    last_success_eval_at timestamptz,
    last_fired_at        timestamptz,
    deleted_at           timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    version              integer     NOT NULL DEFAULT 1,
    CONSTRAINT alert_rules_name CHECK (char_length(name) <= 100),
    CONSTRAINT alert_rules_condition CHECK (jsonb_typeof(condition) = 'object'),
    CONSTRAINT alert_rules_window CHECK (window_minutes BETWEEN 1 AND 1440),
    CONSTRAINT alert_rules_threshold CHECK (threshold >= 1),
    -- 비우면 시간 구간과 같은 길이(Q12-03)
    CONSTRAINT alert_rules_resolve_wait CHECK (resolve_wait_minutes IS NULL OR resolve_wait_minutes BETWEEN 1 AND 1440),
    CONSTRAINT alert_rules_eval_state CHECK (eval_state IN ('normal', 'firing', 'resolving')),
    CONSTRAINT alert_rules_resolve_streak CHECK (resolve_streak >= 0 AND (eval_state = 'resolving') = (resolve_streak >= 1)),
    CONSTRAINT alert_rules_quality CHECK (quality IS NULL OR quality IN ('complete', 'partially_unobserved', 'unmonitorable', 'no_targets')),
    CONSTRAINT alert_rules_deleted CHECK (deleted_at IS NULL OR NOT enabled)
);

CREATE TABLE alert_rule_recipients (
    id           bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rule_id      integer      NOT NULL REFERENCES alert_rules (id),
    address      mail_address NOT NULL,
    confirmed_at timestamptz,
    added_at     timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX alert_rule_recipients_uq ON alert_rule_recipients (rule_id, lower(address));

CREATE TABLE alert_incidents (
    id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_ref         text        NOT NULL UNIQUE,
    rule_id            integer     NOT NULL REFERENCES alert_rules (id),
    condition_version  integer     NOT NULL,
    rule_name          text        NOT NULL,
    condition          jsonb       NOT NULL,
    window_minutes     integer     NOT NULL,
    threshold          integer     NOT NULL,
    window_start       timestamptz NOT NULL,
    window_end         timestamptz NOT NULL,
    fired_at           timestamptz NOT NULL,
    matched_count      bigint      NOT NULL,
    unknown_count      bigint,
    oldest_occurred_at timestamptz,
    partial            boolean     NOT NULL DEFAULT false,
    quality            text        NOT NULL,
    closed_at          timestamptz,
    close_reason       text,
    CONSTRAINT alert_incidents_window CHECK (window_start < window_end),
    CONSTRAINT alert_incidents_quality CHECK (quality IN ('complete', 'partially_unobserved', 'unmonitorable', 'no_targets')),
    CONSTRAINT alert_incidents_close CHECK (
        (closed_at IS NULL) = (close_reason IS NULL)
        AND (close_reason IS NULL OR close_reason IN ('resolved', 'condition_changed', 'rule_disabled', 'rule_deleted'))),
    CONSTRAINT alert_incidents_round_uq UNIQUE (rule_id, condition_version, window_end)
);
CREATE UNIQUE INDEX alert_incidents_open_uq ON alert_incidents (rule_id) WHERE closed_at IS NULL;
CREATE INDEX alert_incidents_rule_idx ON alert_incidents (rule_id, fired_at DESC);
CREATE INDEX alert_incidents_fired_idx ON alert_incidents (fired_at);

CREATE TABLE alert_evaluations (
    rule_id           integer     NOT NULL REFERENCES alert_rules (id),
    window_end        timestamptz NOT NULL,
    window_start      timestamptz NOT NULL,
    condition_version integer     NOT NULL,
    status            text        NOT NULL,
    matched_count     bigint,
    unknown_count     bigint,
    partial           boolean     NOT NULL DEFAULT false,
    quality           text,
    error_code        text,
    evaluated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rule_id, window_end),
    CONSTRAINT alert_evaluations_window CHECK (window_start < window_end),
    CONSTRAINT alert_evaluations_status CHECK (status IN ('met', 'below', 'unevaluable', 'skipped'))
);
CREATE INDEX alert_evaluations_window_idx ON alert_evaluations (window_end);

CREATE TABLE ops_recipients (
    id           bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    address      mail_address NOT NULL,
    confirmed_at timestamptz,
    added_at     timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ops_recipients_uq ON ops_recipients (lower(address));

CREATE TABLE ops_recipient_list (
    id         smallint    PRIMARY KEY DEFAULT 1,
    version    integer     NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ops_recipient_list_single CHECK (id = 1)
);

CREATE TABLE ops_mail_batches (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ops_episodes (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind          text        NOT NULL,
    connection_id integer     REFERENCES connections (id),
    started_at    timestamptz NOT NULL,
    ops_batch_id  bigint      REFERENCES ops_mail_batches (id),
    ended_at      timestamptz,
    CONSTRAINT ops_episodes_kind CHECK (kind IN ('connection_unobserved', 'alert_eval_failed', 'disk_warning')),
    CONSTRAINT ops_episodes_connection CHECK ((kind = 'connection_unobserved') = (connection_id IS NOT NULL))
);
-- 같은 일은 이어지는 동안 하나만 열린다(Q12-06 지속 중 1회)
CREATE UNIQUE INDEX ops_episodes_open_uq ON ops_episodes (kind, coalesce(connection_id, 0)) WHERE ended_at IS NULL;

CREATE TABLE mail_jobs (
    id                 bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind               text         NOT NULL,
    incident_id        bigint       REFERENCES alert_incidents (id),
    ops_batch_id       bigint       REFERENCES ops_mail_batches (id),
    recipient          mail_address NOT NULL,
    message_id         text         NOT NULL UNIQUE,
    state              text         NOT NULL DEFAULT 'queued',
    attempts           integer      NOT NULL DEFAULT 0,
    next_attempt_at    timestamptz,
    last_attempt_at    timestamptz,
    last_error         text,
    accepted_at        timestamptz,
    sent_after_resolve boolean      NOT NULL DEFAULT false,
    cancel_reason      text,
    acknowledged_at    timestamptz,
    created_at         timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT mail_jobs_kind CHECK (
        (kind = 'alert' AND incident_id IS NOT NULL AND ops_batch_id IS NULL)
     OR (kind = 'ops' AND ops_batch_id IS NOT NULL AND incident_id IS NULL)
     OR (kind = 'test' AND incident_id IS NULL AND ops_batch_id IS NULL)),
    CONSTRAINT mail_jobs_state CHECK (state IN
        ('queued', 'sending', 'retry_wait', 'unknown', 'accepted', 'failed', 'cancelled')),
    CONSTRAINT mail_jobs_attempts CHECK (attempts >= 0),
    CONSTRAINT mail_jobs_accepted CHECK ((state = 'accepted') = (accepted_at IS NOT NULL)),
    CONSTRAINT mail_jobs_cancel CHECK (
        (state = 'cancelled') = (cancel_reason IS NOT NULL)
        AND (cancel_reason IS NULL OR cancel_reason IN ('rule_disabled', 'rule_deleted', 'recipient_removed'))),
    CONSTRAINT mail_jobs_ack CHECK (acknowledged_at IS NULL OR state = 'failed')
);
CREATE UNIQUE INDEX mail_jobs_incident_recipient_uq ON mail_jobs (incident_id, lower(recipient)) WHERE incident_id IS NOT NULL;
CREATE UNIQUE INDEX mail_jobs_ops_recipient_uq ON mail_jobs (ops_batch_id, lower(recipient)) WHERE ops_batch_id IS NOT NULL;
CREATE INDEX mail_jobs_due_idx ON mail_jobs (next_attempt_at) WHERE state IN ('queued', 'retry_wait', 'unknown');
CREATE INDEX mail_jobs_unacked_failure_idx ON mail_jobs (incident_id) WHERE state = 'failed' AND acknowledged_at IS NULL;
CREATE INDEX mail_jobs_created_idx ON mail_jobs (created_at);

CREATE TABLE mail_status (
    id              smallint    PRIMARY KEY DEFAULT 1,
    last_attempt_at timestamptz,
    last_success_at timestamptz,
    last_error      text,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mail_status_single CHECK (id = 1)
);

-- 4. 감사·운영
-- 감사는 허용한 열만 둔다(T06). 비밀번호·키·검색어·로그 본문·수신 주소 원문을 담을 열이 없다
CREATE TABLE audit_log (
    id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    logged_at      timestamptz NOT NULL DEFAULT now(),
    time_trusted   boolean     NOT NULL DEFAULT true,
    actor_type     text        NOT NULL,
    account_id     integer     REFERENCES accounts (id),
    action         text        NOT NULL,
    target_type    text,
    target_ref     text,
    result         text        NOT NULL,
    stage          text,
    changed_fields text[],
    reason_code    text,
    event_count    integer     NOT NULL DEFAULT 1,
    CONSTRAINT audit_log_actor CHECK (actor_type IN ('shared_account', 'local_operator', 'system')),
    CONSTRAINT audit_log_action CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
    CONSTRAINT audit_log_result CHECK (result IN ('success', 'failure', 'partial')),
    CONSTRAINT audit_log_stage CHECK (stage IS NULL OR stage IN ('requested', 'confirmed', 'agent_observed')),
    CONSTRAINT audit_log_event_count CHECK (event_count >= 1)
);
CREATE INDEX audit_log_logged_idx ON audit_log (logged_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, logged_at DESC);

CREATE TABLE audit_gaps (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at timestamptz NOT NULL,
    ended_at   timestamptz,
    CONSTRAINT audit_gaps_range CHECK (ended_at IS NULL OR started_at <= ended_at)
);

CREATE TABLE audit_cleanups (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cleaned_at   timestamptz NOT NULL DEFAULT now(),
    removed_from timestamptz NOT NULL,
    removed_to   timestamptz NOT NULL,
    removed_rows bigint      NOT NULL,
    early        boolean     NOT NULL,
    CONSTRAINT audit_cleanups_range CHECK (removed_from <= removed_to)
);

CREATE TABLE storage_metrics (
    measured_at           timestamptz PRIMARY KEY,
    log_bytes             bigint,
    log_limit_bytes       bigint,
    disk_free_bytes       bigint,
    estimated             boolean     NOT NULL DEFAULT false,
    earliest_available_at timestamptz
);

CREATE TABLE early_deletions (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    happened_at   timestamptz NOT NULL DEFAULT now(),
    received_from timestamptz NOT NULL,
    received_to   timestamptz NOT NULL,
    bytes         bigint,
    CONSTRAINT early_deletions_range CHECK (received_from < received_to)
);
CREATE INDEX early_deletions_happened_idx ON early_deletions (happened_at DESC);

CREATE TABLE notices (
    id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind            text        NOT NULL,
    raised_at       timestamptz NOT NULL DEFAULT now(),
    cleared_at      timestamptz,
    acknowledged_at timestamptz,
    item_count      integer,
    CONSTRAINT notices_kind CHECK (kind IN ('mail_connection_error', 'alert_eval_stopped', 'mail_final_failures',
        'audit_unavailable', 'audit_gap', 'disk_warning', 'early_deletion', 'storage_unmeasurable',
        'ops_recipients_missing'))
);
-- 종류마다 떠 있는 배너는 하나. 지나간 일이 또 생기면 같은 행의 건수를 늘린다
CREATE UNIQUE INDEX notices_open_uq ON notices (kind) WHERE cleared_at IS NULL AND acknowledged_at IS NULL;

CREATE TABLE idempotency_keys (
    account_id   integer     NOT NULL REFERENCES accounts (id),
    idem_key     text        NOT NULL,
    request_kind text        NOT NULL,
    request_hash bytea       NOT NULL,
    status_code  smallint    NOT NULL,
    result       jsonb       NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, idem_key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
