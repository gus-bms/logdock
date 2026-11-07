// 화면용 설정값, 전역 배너, 조건 편집기의 값 목록(계약 4.2·4.3·4.4절, CM-01·CM-03, UI-13~15).
import { Inject, Injectable } from '@nestjs/common';

import { errors } from '../common/api-error.js';
import type { AppConfig } from '../config.js';
import { encodeConnectionId } from '../connections/public-id.js';
import { Database, type Queryable, utc } from '../db/database.js';
import { APP_CONFIG } from '../tokens.js';
import { PRODUCT_VERSION } from '../version.js';

/** 배너 종류(4.4절 표 순서). `계속`은 원인이 풀리면 내려가고 `지나간 일`은 사람이 확인할 때까지 남는다. */
const NOTICE_ORDER = [
  'mail_connection_error',
  'alert_eval_stopped',
  'mail_final_failures',
  'audit_unavailable',
  'audit_gap',
  'disk_warning',
  'early_deletion',
  'storage_unmeasurable',
  'ops_recipients_missing',
] as const;
type NoticeKind = (typeof NOTICE_ORDER)[number];

/** 사람이 확인해야 내려가는 `지나간 일` 배너. */
const PAST_EVENTS: NoticeKind[] = ['audit_gap', 'early_deletion'];

/**
 * API가 관리 DB의 지금 값으로 바로 판단하는 배너. 원인을 그때그때 다시 보므로 풀리면 저절로 내려간다. 나머지 종류는 그 일을
 * 아는 쪽(감사·저장 공간 측정)이 `notices`에 쓴 행을 그대로 보인다.
 */
const DERIVED: NoticeKind[] = ['mail_connection_error', 'alert_eval_stopped', 'mail_final_failures', 'ops_recipients_missing'];

/** 연결·설정 문제라 메일 서버 쪽을 고쳐야 하는 사유(5.5절). 주소 문제와 전송 여부 불명은 배너를 올리지 않는다. */
const CONNECTION_ERRORS = ['mail_connect_timeout', 'mail_dns_error', 'mail_tls_failed', 'mail_auth_failed', 'mail_sender_rejected', 'mail_temporary_failure'];

interface Notice {
  /** 관리 DB에 저장된 배너의 ID. API가 판단한 배너는 `null`이다. */
  id: string | null;
  kind: NoticeKind;
  raised_at: string | null;
  item_count: number | null;
  /** 사람이 확인해 내릴 수 있다(`지나간 일`). */
  acknowledgeable: boolean;
}

@Injectable()
export class SystemService {
  constructor(
    private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 화면에 필요한 읽기 전용 설정값. 비밀 값은 없다(4.3절). */
  settings() {
    const c = this.config;
    return {
      display_timezone: c.displayTimezone,
      log_retention: { months: c.logRetentionMonths },
      session: { idle_seconds: c.sessionIdleSeconds, absolute_seconds: c.sessionAbsoluteSeconds, reauth_seconds: c.reauthSeconds },
      limits: {
        saved_searches: c.savedSearchLimit,
        alert_rules: c.alertRuleLimit,
        recipients_per_rule: c.alertRecipientLimit,
        ops_recipients: c.alertRecipientLimit,
      },
      mail_configured: c.mail !== null,
      product_version: PRODUCT_VERSION,
    };
  }

  /** 지금 떠 있는 전역 배너(CM-01). 4.4절 표 순서로 준다. */
  async notices(): Promise<{ items: Notice[] }> {
    return this.db.tx(async (c) => {
      const stored = (
        await c.query<{ id: string; kind: NoticeKind; raised_at: string; item_count: number | null }>(
          `SELECT id::text, kind, ${utc('raised_at')} AS raised_at, item_count FROM notices
            WHERE cleared_at IS NULL AND acknowledged_at IS NULL AND NOT (kind = ANY($1::text[]))`,
          [DERIVED],
        )
      ).rows.map((r) => ({ ...r, acknowledgeable: PAST_EVENTS.includes(r.kind) }));
      const items: Notice[] = [...stored, ...(await this.derived(c))];
      items.sort((a, b) => NOTICE_ORDER.indexOf(a.kind) - NOTICE_ORDER.indexOf(b.kind) || (a.raised_at ?? '').localeCompare(b.raised_at ?? ''));
      return { items };
    });
  }

  /** `지나간 일` 배너를 확인해 내린다. `계속` 배너는 원인이 풀려야 내려가므로 `409 invalid_state`다. */
  async ackNotice(id: string) {
    return this.db.tx(async (c) => {
      const row = (
        await c.query<{ kind: NoticeKind }>('SELECT kind FROM notices WHERE id = $1 AND cleared_at IS NULL AND acknowledged_at IS NULL FOR UPDATE', [id])
      ).rows[0];
      if (!row) throw errors.notFound();
      if (!PAST_EVENTS.includes(row.kind)) throw errors.invalidState({ kind: row.kind });
      await c.query('UPDATE notices SET acknowledged_at = now() WHERE id = $1', [id]);
      return { id, kind: row.kind, acknowledged: true };
    });
  }

  private async derived(c: Queryable): Promise<Notice[]> {
    const out: Notice[] = [];
    const add = (kind: NoticeKind, raised_at: string | null, item_count: number | null) =>
      out.push({ id: null, kind, raised_at, item_count, acknowledgeable: false });

    // 메일 서버 연결·설정 문제로 마지막 발송이 실패했다(5.5절 `설정 문제`와 연결 실패). 다음 발송이 성공하면 내려간다.
    if (this.config.mail) {
      const m = (
        await c.query<{ at: string; last_error: string }>(`SELECT ${utc('last_attempt_at')} AS at, last_error FROM mail_status WHERE id = 1`)
      ).rows[0];
      if (m?.last_error && CONNECTION_ERRORS.includes(m.last_error)) add('mail_connection_error', m.at, null);
    }

    // 켜진 규칙의 마지막 성공 평가가 기준보다 오래됐다. 한 번도 평가하지 않은 규칙은 켠 때(상태 시작 시각)부터 잰다.
    const stale = (
      await c.query<{ n: number; since: string | null }>(
        `SELECT count(*)::int AS n, ${utc('min(coalesce(last_success_eval_at, state_since))')} AS since FROM alert_rules
          WHERE enabled AND deleted_at IS NULL AND coalesce(last_success_eval_at, state_since) < now() - make_interval(secs => $1)`,
        [this.config.alertEvalStaleSeconds],
      )
    ).rows[0];
    if (stale.n > 0) add('alert_eval_stopped', stale.since, stale.n);

    // 확인하지 않은 알림 메일 최종 실패. 사건에서 모두 확인하면 내려간다(WQ-49).
    const failed = (
      await c.query<{ n: number; since: string | null }>(
        `SELECT count(*)::int AS n, ${utc('min(coalesce(last_attempt_at, created_at))')} AS since FROM mail_jobs
          WHERE kind = 'alert' AND state = 'failed' AND acknowledged_at IS NULL`,
      )
    ).rows[0];
    if (failed.n > 0) add('mail_final_failures', failed.since, failed.n);

    // 운영 수신 주소가 하나도 없다(WQ-83). 주소가 하나 이상 생기면 내려간다. 수신처 고정이 있으면 운영 메일은 그 주소로 가므로
    // 띄우지 않는다.
    const ops = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM ops_recipients')).rows[0];
    if (ops.n === 0 && !this.config.mail?.redirectTo) add('ops_recipients_missing', null, null);
    return out;
  }

  /**
   * 조건 편집기의 값 목록(CM-03, SD-12, SD-37). 보관된 서비스·연결도 고를 수 있어 상태와 함께 준다(4.2절 특수 값). `미입력`은
   * 값 목록 안의 `null`이고, 그런 연결이 있을 때만 넣는다. 수집 대상은 서비스별로 묶고 서버 표시명과 대상을 함께 준다.
   */
  async sources() {
    return this.db.tx(async (c) => {
      const services = (
        await c.query<{ id: number; name: string; state: string }>('SELECT id, name, state FROM services ORDER BY lower(name), id')
      ).rows;
      const servers = (
        await c.query<{ id: number; display_name: string }>(
          `SELECT id, display_name FROM servers WHERE id IN (SELECT server_id FROM connections WHERE server_id IS NOT NULL)
            ORDER BY lower(display_name), id`,
        )
      ).rows;
      const unset = (
        await c.query<{ server: boolean; environment: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM connections WHERE server_id IS NULL) AS server,
                  EXISTS (SELECT 1 FROM connections WHERE environment IS NULL) AS environment`,
        )
      ).rows[0];
      const environments = (
        await c.query<{ environment: string }>(
          'SELECT DISTINCT environment FROM connections WHERE environment IS NOT NULL ORDER BY environment',
        )
      ).rows.map((r) => r.environment);
      const conns = (
        await c.query<{
          id: number;
          service_id: number;
          display_name: string | null;
          target_type: string;
          target_path: string | null;
          journald_kind: string | null;
          journald_name: string | null;
          management_state: string;
        }>(
          `SELECT c.id, c.service_id, s.display_name, c.target_type, c.target_path, c.journald_kind, c.journald_name, c.management_state
             FROM connections c LEFT JOIN servers s ON s.id = c.server_id
            ORDER BY c.service_id, lower(coalesce(s.display_name, '')), c.id`,
        )
      ).rows;
      return {
        services,
        servers: [...servers, ...(unset.server ? [{ id: null, display_name: null }] : [])],
        environments: [...environments, ...(unset.environment ? [null] : [])],
        targets: services
          .map((s) => ({
            service_id: s.id,
            connections: conns
              .filter((x) => x.service_id === s.id)
              .map((x) => ({
                id: encodeConnectionId(x.id),
                server_display_name: x.display_name,
                target: { type: x.target_type, path: x.target_path, kind: x.journald_kind, name: x.journald_name },
                management_state: x.management_state,
              })),
          }))
          .filter((g) => g.connections.length > 0),
      };
    });
  }
}
