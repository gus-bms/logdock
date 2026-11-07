// 알림 규칙(계약 4.3·5.4절, Q12, TD-01·05·06·07·08, UI-06~08). 재확인 없이 쓰고, 바꾸는 동작은 감사에 남기며 감사를 쓸 수 없으면
// 아무것도 바꾸지 않는다(409 held_audit_unavailable). 동시 편집은 덮어쓰지 않고 다시 불러오게 한다(TD-06, `force` 없음).
// 상태 전이(5.4절): 조건(필터·시간 구간·임계)을 고치면 `정상`으로 초기화하고 열린 사건을 `조건 수정`으로 닫되 남은 메일은 보낸다.
// 끄거나 지우면 열린 사건을 닫고 보내지 않은 메일을 취소한다. 이름·수신 주소·해소 대기만 고치면 상태를 유지한다.
import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { sha256 } from '../auth/tokens.js';
import { errors } from '../common/api-error.js';
import { claimIdempotency, completeIdempotency } from '../common/idempotency.js';
import type { AppConfig } from '../config.js';
import type { FieldProblem } from '../connections/connection-input.js';
import { CONNECTION_ROWS, observationParams } from '../connections/connection-views.service.js';
import { decodeConnectionId, encodeConnectionId } from '../connections/public-id.js';
import { Database, lockCount, type Queryable, utc } from '../db/database.js';
import { checkConditionReferences, type Condition } from '../search/condition.js';
import { loadReferences, type ReferenceMaps, resolveReferences, sourcesOf } from '../search/references.js';
import { APP_CONFIG } from '../tokens.js';
import { type CheckedRule, checkRuleFields, type CreateRuleBody, hasNoFilter, sameJson, type UpdateRuleBody } from './alert-input.js';
import { type DeliverySummary, listRuleIncidents } from './incidents.service.js';

/** 관측되지 않는 대상으로 보는 관측 상태(5.4절 관측 판단). `연결 대기`는 판단에서 빼고, `관측됨·무로그`·`복구 중`은 관측된다. */
const UNOBSERVED = ['stale', 'send_error', 'read_paused', 'disk_unavailable', 'needs_check'];

interface RuleRow {
  id: number;
  name: string;
  sort_name: string;
  enabled: boolean;
  condition: Condition;
  condition_version: number;
  window_minutes: number;
  threshold: number;
  resolve_wait_minutes: number | null;
  eval_state: 'normal' | 'firing' | 'resolving';
  state_since: string;
  resolve_streak: number;
  quality: string | null;
  last_success_eval_at: string | null;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  recipient_count: number;
  final_failure_unacked: number;
  last_delivery: (Omit<DeliverySummary, 'failed_unacked'> & { incident_id: string; fired_at: string }) | null;
}

const RULE_COLUMNS = `
  r.id, r.name, lower(r.name) AS sort_name, r.enabled, r.condition, r.condition_version, r.window_minutes, r.threshold,
  r.resolve_wait_minutes, r.eval_state, ${utc('r.state_since')} AS state_since, r.resolve_streak, r.quality,
  ${utc('r.last_success_eval_at')} AS last_success_eval_at, ${utc('r.last_fired_at')} AS last_fired_at,
  ${utc('r.created_at')} AS created_at, ${utc('r.updated_at')} AS updated_at, r.version,
  (SELECT count(*)::int FROM alert_rule_recipients p WHERE p.rule_id = r.id) AS recipient_count,
  (SELECT count(*)::int FROM mail_jobs j JOIN alert_incidents i ON i.id = j.incident_id
    WHERE i.rule_id = r.id AND j.state = 'failed' AND j.acknowledged_at IS NULL) AS final_failure_unacked,
  (SELECT jsonb_build_object(
            'incident_id', i.public_ref, 'fired_at', ${utc('i.fired_at')},
            'accepted', count(j.id) FILTER (WHERE j.state = 'accepted'),
            'pending', count(j.id) FILTER (WHERE j.state IN ('queued', 'sending', 'retry_wait', 'unknown')),
            'failed', count(j.id) FILTER (WHERE j.state = 'failed'),
            'cancelled', count(j.id) FILTER (WHERE j.state = 'cancelled'))
     FROM (SELECT id, public_ref, fired_at FROM alert_incidents WHERE rule_id = r.id ORDER BY fired_at DESC, id DESC LIMIT 1) i
     LEFT JOIN mail_jobs j ON j.incident_id = i.id
    GROUP BY i.id, i.public_ref, i.fired_at) AS last_delivery`;

/** 목록 항목(UI-06). 조건은 저장한 형태와, 가리키는 대상의 지금 이름·상태를 함께 준다. */
function ruleView(r: RuleRow, refs: ReferenceMaps) {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    eval_state: r.eval_state,
    state_since: r.state_since,
    quality: r.quality,
    condition: r.condition,
    ...resolveReferences(r.condition, refs),
    window_minutes: r.window_minutes,
    threshold: r.threshold,
    resolve_wait_minutes: r.resolve_wait_minutes,
    recipient_count: r.recipient_count,
    last_fired_at: r.last_fired_at,
    last_delivery: r.last_delivery,
    last_success_eval_at: r.last_success_eval_at,
    final_failure_unacked: r.final_failure_unacked,
    created_at: r.created_at,
    updated_at: r.updated_at,
    version: r.version,
  };
}

function cursorOf(r: RuleRow): string {
  return Buffer.from(JSON.stringify([r.sort_name, r.id])).toString('base64url');
}

function parseCursor(s: string): [string, number] {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1])) return v as [string, number];
  } catch {
    // 아래에서 입력 오류로 돌려준다
  }
  throw errors.validation([{ path: 'cursor', reason: 'invalid' }]);
}

@Injectable()
export class AlertRulesService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * 이름순(대소문자 무시)·ID 순. 켬/끔·평가 상태·확인하지 않은 최종 실패로 거른다(UI-06, 4.4절). 화면이 상한 도달과
   * `메일 설정이 없어 켤 수 없음`을 그릴 수 있게 전체 수·상한·메일 설정 여부를 함께 준다.
   */
  async list(accountId: number, q: { enabled?: boolean; evalState?: string; finalFailureUnacked?: boolean; limit: number; cursor?: string }) {
    const values: unknown[] = [accountId];
    const where: string[] = [];
    if (q.enabled !== undefined) {
      values.push(q.enabled);
      where.push(`enabled = $${values.length}`);
    }
    if (q.evalState) {
      values.push(q.evalState);
      where.push(`eval_state = $${values.length}`);
    }
    if (q.finalFailureUnacked) where.push('final_failure_unacked > 0');
    if (q.cursor) {
      const [name, id] = parseCursor(q.cursor);
      values.push(name, id);
      where.push(`(sort_name, id) > ($${values.length - 1}, $${values.length})`);
    }
    values.push(q.limit + 1);
    return this.db.tx(async (c) => {
      const r = await c.query<RuleRow>(
        `SELECT * FROM (SELECT ${RULE_COLUMNS} FROM alert_rules r WHERE r.owner_account_id = $1 AND r.deleted_at IS NULL) x
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sort_name, id LIMIT $${values.length}`,
        values,
      );
      const rows = r.rows.slice(0, q.limit);
      const refs = await loadReferences(c, rows.map((x) => x.condition));
      return {
        items: rows.map((x) => ruleView(x, refs)),
        next_cursor: r.rows.length > q.limit ? cursorOf(rows[rows.length - 1]) : null,
        total: await this.count(c, accountId),
        limit: this.config.alertRuleLimit,
        mail_configured: this.config.mail !== null,
      };
    });
  }

  /**
   * 상세(UI-08). 목록 항목에 수신 주소와 `받았음` 시각, 해소 대기 진행(연속 회차와 필요 회차, 평가는 1분마다라 분과 같다),
   * 최근 미평가 구간, 대상 연결 수와 관측되지 않는 대상 연결, 최근 사건 10건을 더한다.
   */
  async detail(accountId: number, id: number) {
    return this.db.tx(async (c) => {
      const row = await this.find(c, accountId, id);
      if (!row) throw errors.notFound();
      const unevaluated = (
        await c.query(
          `SELECT ${utc('window_start')} AS window_start, ${utc('window_end')} AS window_end, status, error_code
             FROM alert_evaluations WHERE rule_id = $1 AND status IN ('unevaluable', 'skipped')
            ORDER BY window_end DESC LIMIT 20`,
          [id],
        )
      ).rows;
      return {
        ...(await this.viewOf(c, row)),
        recipients: await this.recipients(c, id),
        resolve: { streak: row.resolve_streak, needed: row.resolve_wait_minutes ?? row.window_minutes },
        unevaluated_windows: unevaluated,
        targets: await this.targets(c, row.condition),
        recent_incidents: (await listRuleIncidents(c, id, 10)).items,
      };
    });
  }

  /**
   * 만들기(UI-07). Idempotency-Key가 필요하다. 꺼짐/켬을 꼭 받고, 켜려면 메일 설정이 있어야 한다(`mail_not_configured`).
   * 개수 상한은 꺼진 규칙도 세고(`409 limit_reached`), 같은 이름은 막지 않고 `warnings`에 `name_duplicate`로 알린다(TD-01).
   */
  async create(body: CreateRuleBody, idemKey: string, accountId: number) {
    const checked = this.check(body) as Required<CheckedRule>;
    if (hasNoFilter(checked.condition) && !body.confirm_no_filter) {
      throw errors.validation([{ path: 'condition', reason: 'no_filter_needs_confirm' }]);
    }
    if (body.enabled && !this.config.mail) throw errors.mailNotConfigured();
    const input = {
      name: checked.name,
      enabled: body.enabled,
      condition: checked.condition,
      window_minutes: body.window_minutes,
      threshold: body.threshold,
      resolve_wait_minutes: body.resolve_wait_minutes ?? null,
      recipients: checked.recipients,
    };
    const requestHash = sha256('alert_rule.create', JSON.stringify(input));
    return this.db.tx(async (c) => {
      const claim = await claimIdempotency(c, accountId, idemKey, 'alert_rule.create', requestHash);
      if (claim.kind === 'replay') {
        const row = await this.find(c, accountId, Number(claim.result.alert_rule_id));
        if (!row) throw errors.notFound();
        return { ...(await this.viewOf(c, row)), warnings: await this.nameWarnings(c, accountId, row.name, row.id) };
      }
      await lockCount(c, 'alertRules', accountId);
      this.throwIf(await checkConditionReferences(c, input.condition));
      if ((await this.count(c, accountId)) >= this.config.alertRuleLimit) throw errors.limitReached(this.config.alertRuleLimit);
      const warnings = await this.nameWarnings(c, accountId, input.name, 0);
      const id = (
        await c.query<{ id: number }>(
          `INSERT INTO alert_rules (owner_account_id, name, enabled, condition, window_minutes, threshold, resolve_wait_minutes)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [accountId, input.name, input.enabled, input.condition, input.window_minutes, input.threshold, input.resolve_wait_minutes],
        )
      ).rows[0].id;
      await c.query('INSERT INTO alert_rule_recipients (rule_id, address) SELECT $1, unnest($2::text[])', [id, input.recipients]);
      await this.audit.writeOrHold(c, { action: 'alert_rule.create', result: 'success', accountId, targetType: 'alert_rule', targetRef: String(id) });
      await completeIdempotency(c, accountId, idemKey, 201, { alert_rule_id: id });
      return { ...(await this.viewOf(c, (await this.find(c, accountId, id))!)), warnings };
    });
  }

  /**
   * 수정과 켬/끔(UI-07·UI-06). 읽을 때 받은 `version`이 다르면 덮어쓰지 않고 `409 version_conflict`와 지금 값을 준다(TD-06).
   * 수신 주소는 목록 전체를 바꾸며, 남는 주소의 `받았음` 표시는 그대로 두고 뺀 주소로 아직 보내지 않은 메일은 취소한다(F-13).
   * 감사는 바뀐 항목 종류만 남긴다(`alert_rule.update`, 켬·끔은 따로). 바뀐 것이 없으면 아무것도 하지 않는다.
   */
  async update(id: number, body: UpdateRuleBody, accountId: number) {
    const checked = this.check(body);
    return this.db.tx(async (c) => {
      const row = await this.find(c, accountId, id, true);
      if (!row) throw errors.notFound();
      if (row.version !== body.version) throw errors.versionConflict({ ...(await this.viewOf(c, row)) });
      const next = {
        name: checked.name ?? row.name,
        enabled: body.enabled ?? row.enabled,
        condition: checked.condition ?? row.condition,
        window: body.window_minutes ?? row.window_minutes,
        threshold: body.threshold ?? row.threshold,
        resolveWait: body.resolve_wait_minutes === undefined ? row.resolve_wait_minutes : body.resolve_wait_minutes,
      };
      const changed: string[] = [];
      if (next.name !== row.name) changed.push('name');
      if (!sameJson(next.condition, row.condition)) changed.push('condition');
      if (next.window !== row.window_minutes) changed.push('window_minutes');
      if (next.threshold !== row.threshold) changed.push('threshold');
      if (next.resolveWait !== row.resolve_wait_minutes) changed.push('resolve_wait_minutes');
      const current = await this.recipients(c, id);
      let removed: string[] = [];
      let added: string[] = [];
      if (checked.recipients) {
        const have = new Set(current.map((r) => r.address.toLowerCase()));
        const want = new Set(checked.recipients.map((a) => a.toLowerCase()));
        removed = current.map((r) => r.address).filter((a) => !want.has(a.toLowerCase()));
        added = checked.recipients.filter((a) => !have.has(a.toLowerCase()));
        if (removed.length || added.length) changed.push('recipients');
      }
      const enabling = !row.enabled && next.enabled;
      const disabling = row.enabled && !next.enabled;
      if (!changed.length && !enabling && !disabling) return { ...(await this.viewOf(c, row)), warnings: [] as string[] };

      if (changed.includes('condition')) {
        if (hasNoFilter(next.condition) && !body.confirm_no_filter) {
          throw errors.validation([{ path: 'condition', reason: 'no_filter_needs_confirm' }]);
        }
        this.throwIf(await checkConditionReferences(c, next.condition));
      }
      if (enabling && !this.config.mail) throw errors.mailNotConfigured();

      const conditionChanged = ['condition', 'window_minutes', 'threshold'].some((f) => changed.includes(f));
      const reset = conditionChanged || enabling || disabling;
      await c.query(
        `UPDATE alert_rules
            SET name = $2, enabled = $3, condition = $4, window_minutes = $5, threshold = $6, resolve_wait_minutes = $7,
                condition_version = condition_version + CASE WHEN $8 THEN 1 ELSE 0 END,
                eval_state = CASE WHEN $9 THEN 'normal' ELSE eval_state END,
                resolve_streak = CASE WHEN $9 THEN 0 ELSE resolve_streak END,
                state_since = CASE WHEN $9 THEN now() ELSE state_since END,
                updated_at = now(), version = version + 1
          WHERE id = $1`,
        [id, next.name, next.enabled, next.condition, next.window, next.threshold, next.resolveWait, conditionChanged, reset],
      );
      if (disabling) {
        await this.closeOpenIncident(c, id, 'rule_disabled');
        await this.cancelMails(c, id, 'rule_disabled');
      } else if (conditionChanged) {
        // 조건을 고쳐 닫은 사건의 남은 메일은 계속 보낸다(WQ-40, Q12-11과 같은 방향).
        await this.closeOpenIncident(c, id, 'condition_changed');
      }
      if (removed.length) {
        await c.query('DELETE FROM alert_rule_recipients WHERE rule_id = $1 AND lower(address) = ANY($2::text[])', [id, removed.map((a) => a.toLowerCase())]);
        await this.cancelMails(c, id, 'recipient_removed', removed);
      }
      if (added.length) await c.query('INSERT INTO alert_rule_recipients (rule_id, address) SELECT $1, unnest($2::text[])', [id, added]);

      const base = { result: 'success' as const, accountId, targetType: 'alert_rule', targetRef: String(id) };
      if (changed.length) await this.audit.writeOrHold(c, { ...base, action: 'alert_rule.update', changedFields: changed });
      if (enabling) await this.audit.writeOrHold(c, { ...base, action: 'alert_rule.enable' });
      if (disabling) await this.audit.writeOrHold(c, { ...base, action: 'alert_rule.disable' });
      const warnings = changed.includes('name') ? await this.nameWarnings(c, accountId, next.name, id) : [];
      return { ...(await this.viewOf(c, (await this.find(c, accountId, id))!)), warnings };
    });
  }

  /** 삭제(UI-07). 열린 사건을 `규칙 삭제`로 닫고 보내지 않은 메일을 취소한다. 사건 이력과 메일 링크는 남는다. */
  async remove(id: number, accountId: number): Promise<void> {
    await this.db.tx(async (c) => {
      const row = await this.find(c, accountId, id, true);
      if (!row) throw errors.notFound();
      await c.query(
        `UPDATE alert_rules SET deleted_at = now(), enabled = false, eval_state = 'normal', resolve_streak = 0, state_since = now(),
                updated_at = now(), version = version + 1
          WHERE id = $1`,
        [id],
      );
      await this.closeOpenIncident(c, id, 'rule_deleted');
      await this.cancelMails(c, id, 'rule_deleted');
      await this.audit.writeOrHold(c, { action: 'alert_rule.delete', result: 'success', accountId, targetType: 'alert_rule', targetRef: String(id) });
    });
  }

  /**
   * 테스트 메일을 받은 사람이 `받았음`을 누르면 그 주소를 `확인됨`으로 둔다(WQ-42·82). 자동으로 판정하지 않는다. 이미 확인한
   * 주소는 처음 시각을 지키고 감사도 다시 남기지 않는다. 규칙의 버전은 올리지 않아 편집 중인 화면과 부딪히지 않는다.
   */
  async confirmRecipient(id: number, address: string, accountId: number) {
    return this.db.tx(async (c) => {
      const row = await this.find(c, accountId, id, true);
      if (!row) throw errors.notFound();
      const a = address.trim();
      const found = (await c.query<{ confirmed: boolean }>(
        'SELECT confirmed_at IS NOT NULL AS confirmed FROM alert_rule_recipients WHERE rule_id = $1 AND lower(address) = lower($2)',
        [id, a],
      )).rows[0];
      if (!found) throw errors.notFound();
      if (!found.confirmed) {
        await c.query('UPDATE alert_rule_recipients SET confirmed_at = now() WHERE rule_id = $1 AND lower(address) = lower($2)', [id, a]);
        await this.audit.writeOrHold(c, {
          action: 'alert_rule.update',
          result: 'success',
          accountId,
          targetType: 'alert_rule',
          targetRef: String(id),
          changedFields: ['recipient_confirmed'],
        });
      }
      return { id, recipients: await this.recipients(c, id) };
    });
  }

  private check(body: { name?: string; condition?: CreateRuleBody['condition']; recipients?: string[] }): CheckedRule {
    const r = checkRuleFields(body, this.config);
    if (!r.ok) throw errors.validation(r.problems);
    return r.value;
  }

  private throwIf(problems: FieldProblem[]): void {
    if (problems.length) throw errors.validation(problems);
  }

  /** 지우지 않은 규칙 수. 꺼진 규칙도 센다(4.4절). */
  private async count(c: Queryable, accountId: number): Promise<number> {
    return (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM alert_rules WHERE owner_account_id = $1 AND deleted_at IS NULL', [accountId])).rows[0].n;
  }

  private async nameWarnings(c: Queryable, accountId: number, name: string, exceptId: number): Promise<string[]> {
    const r = await c.query(
      'SELECT 1 FROM alert_rules WHERE owner_account_id = $1 AND deleted_at IS NULL AND lower(name) = lower($2) AND id <> $3 LIMIT 1',
      [accountId, name, exceptId],
    );
    return r.rowCount ? ['name_duplicate'] : [];
  }

  /** 지우지 않은 규칙을 읽는다. `lock`이면 먼저 행을 잠가 같은 규칙의 동시 변경을 줄 세운다. */
  private async find(c: Queryable, accountId: number, id: number, lock = false): Promise<RuleRow | undefined> {
    if (lock) {
      const l = await c.query('SELECT id FROM alert_rules WHERE id = $1 AND owner_account_id = $2 AND deleted_at IS NULL FOR UPDATE', [id, accountId]);
      if (!l.rowCount) return undefined;
    }
    return (
      await c.query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM alert_rules r WHERE r.id = $1 AND r.owner_account_id = $2 AND r.deleted_at IS NULL`, [id, accountId])
    ).rows[0];
  }

  private async viewOf(c: Queryable, row: RuleRow) {
    return ruleView(row, await loadReferences(c, [row.condition]));
  }

  private async recipients(c: Queryable, id: number): Promise<{ address: string; confirmed_at: string | null }[]> {
    return (
      await c.query<{ address: string; confirmed_at: string | null }>(
        `SELECT address, ${utc('confirmed_at')} AS confirmed_at FROM alert_rule_recipients WHERE rule_id = $1 ORDER BY added_at, id`,
        [id],
      )
    ).rows;
  }

  private async closeOpenIncident(c: Queryable, ruleId: number, reason: 'condition_changed' | 'rule_disabled' | 'rule_deleted'): Promise<void> {
    await c.query('UPDATE alert_incidents SET closed_at = now(), close_reason = $2 WHERE rule_id = $1 AND closed_at IS NULL', [ruleId, reason]);
  }

  /** 아직 보내지 않은 메일(대기·재시도 대기)만 취소한다. 전송 중이거나 전송 여부를 모르는 메일은 그대로 둔다(5.5절). */
  private async cancelMails(c: Queryable, ruleId: number, reason: 'rule_disabled' | 'rule_deleted' | 'recipient_removed', addresses?: string[]) {
    const values: unknown[] = [ruleId, reason];
    let only = '';
    if (addresses) {
      values.push(addresses.map((a) => a.toLowerCase()));
      only = ' AND lower(recipient) = ANY($3::text[])';
    }
    await c.query(
      `UPDATE mail_jobs SET state = 'cancelled', cancel_reason = $2, next_attempt_at = NULL
        WHERE state IN ('queued', 'retry_wait') AND incident_id IN (SELECT id FROM alert_incidents WHERE rule_id = $1)${only}`,
      values,
    );
  }

  /** 규칙의 출처 조건에 맞는 보관되지 않은 연결과, 그 가운데 관측되지 않는 연결(5.4절 감시 품질의 대상). */
  private async targets(c: Queryable, cond: Condition) {
    const s = sourcesOf(cond);
    const values: unknown[] = observationParams(this.config);
    const where = [`management_state <> 'archived'`];
    const add = (sql: (p: string) => string, v: unknown) => {
      values.push(v);
      where.push(sql(`$${values.length}`));
    };
    if (s.service_ids.length) add((p) => `service_id = ANY(${p}::int[])`, s.service_ids);
    if (s.server_ids.length) {
      const orNull = s.server_ids.includes(null) ? ' OR server_id IS NULL' : '';
      add((p) => `(server_id = ANY(${p}::int[])${orNull})`, s.server_ids.filter((x) => x !== null));
    }
    if (s.environments.length) {
      const orNull = s.environments.includes(null) ? ' OR environment IS NULL' : '';
      add((p) => `(environment = ANY(${p}::text[])${orNull})`, s.environments.filter((x) => x !== null));
    }
    if (s.connection_ids.length) add((p) => `id = ANY(${p}::int[])`, s.connection_ids.map((x) => decodeConnectionId(x)).filter((x) => x !== null));
    const rows = (
      await c.query<{
        id: number;
        service_name: string;
        display_name: string | null;
        target_type: string;
        target_path: string | null;
        journald_kind: string | null;
        journald_name: string | null;
        observation: string[];
      }>(
        `SELECT id, service_name, display_name, target_type, target_path, journald_kind, journald_name, observation
           FROM (${CONNECTION_ROWS}) x WHERE ${where.join(' AND ')} ORDER BY lower(service_name), id`,
        values,
      )
    ).rows;
    const unobserved = rows.filter((r) => r.observation.some((o) => UNOBSERVED.includes(o)));
    return {
      total: rows.length,
      unobserved: unobserved.map((r) => ({
        id: encodeConnectionId(r.id),
        service_name: r.service_name,
        server_display_name: r.display_name,
        target: { type: r.target_type, path: r.target_path, kind: r.journald_kind, name: r.journald_name },
        observation: r.observation,
      })),
    };
  }
}
