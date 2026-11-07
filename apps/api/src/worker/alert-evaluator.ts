// 알림 평가(계약 5.4절, Q12, TD-02·TD-04·TD-11~TD-14·TD-18·TD-19). worker가 짧은 주기로 새 평가 창이 생겼는지 보고, 생겼으면
// 켜진 규칙을 모두 평가한다. 창 끝 W는 검색 가능 확정 수신 시각을 1분 단위로 내린 값이고 창은 수신 시각 `[W-구간, W)`다.
// - 상태 전이·사건·메일 작업은 한 트랜잭션에 쓴다(TD-11). 평가하는 사이 규칙이 바뀌었으면 그 결과는 버린다.
// - 같은 규칙의 같은 창은 한 번만 평가하고 사건도 하나다(alert_evaluations 기본 키, alert_incidents 회차 유일 제약).
// - 회차가 주기를 넘겨 밀린 창은 `건너뜀`으로 남기고, 다시 시작하면 놓친 창을 평가하지 않고 지금 창부터 한다(TD-12).
// - 평가가 실패하거나 검색 가능 시각이 멈추면 `alert_eval_failed` 운영 일을 열고, 성공하면 닫는다(Q12-06).
import { randomBytes } from 'node:crypto';

import { type WindowCount, countWindow } from '../alerts/alert-count.js';
import { type Quality, loadTargets, qualityOf } from '../alerts/targets.js';
import { ClickHouse, ClickHouseAborted, ClickHouseError } from '../clickhouse/clickhouse.js';
import type { AppConfig } from '../config.js';
import { decodeConnectionId } from '../connections/public-id.js';
import type { Database } from '../db/database.js';
import { deliveryRecipients } from '../mail/outcome.js';
import { newMessageId } from '../mail/message.js';
import { Stop } from '../search/ch-runner.js';
import type { Condition } from '../search/condition.js';
import { rfcOf, usOf } from '../search/run-time.js';
import { loadBlocks, loadLimits } from '../search/scope.js';
import type { Params } from '../search/search-sql.js';

interface RuleRow {
  id: number;
  condition: Condition;
  condition_version: number;
  window_minutes: number;
  threshold: number;
}

export interface RoundResult {
  window_end: string | null;
  evaluated: number;
  failed: number;
  skipped: number;
}

/** 밀린 창을 `건너뜀`으로 남길 때 규칙마다 남기는 최대 수. 오래 멈췄다 돌아와도 기록이 한꺼번에 늘지 않게 한다. */
const MAX_SKIPPED = 60;

export class AlertEvaluator {
  private lastEnd: bigint | null = null;

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly ch: ClickHouse = new ClickHouse(config.clickhouse),
  ) {}

  async round(): Promise<RoundResult> {
    const rules = (
      await this.db.query<RuleRow>(
        `SELECT id, condition, condition_version, window_minutes, threshold
           FROM alert_rules WHERE enabled AND deleted_at IS NULL ORDER BY id`,
      )
    ).rows;
    const none: RoundResult = { window_end: null, evaluated: 0, failed: 0, skipped: 0 };
    if (rules.length === 0) {
      await this.episode(false);
      return none;
    }
    const limits = await loadLimits(this.db, this.config);
    const step = BigInt(this.config.alertEval.intervalSeconds) * 1_000_000n;
    const end = (usOf(limits.receivedThrough) / step) * step;
    if (this.lastEnd !== null && end <= this.lastEnd) {
      // 새 창이 없다. 검색 가능 시각이 멈춰 있으면 평가가 멈춘 것이다.
      await this.episode(limits.watermark === 'stale');
      return none;
    }
    let skipped = 0;
    if (this.lastEnd !== null) {
      const missed: bigint[] = [];
      for (let w = this.lastEnd + step; w < end && missed.length < MAX_SKIPPED; w += step) missed.push(w);
      for (const rule of rules) for (const w of missed) skipped += await this.record(rule, w, 'skipped', null, null);
    }
    this.lastEnd = end;
    const deadline = Date.now() + this.config.alertEval.budgetMs;
    let evaluated = 0;
    let failed = 0;
    for (const rule of rules) {
      try {
        if (await this.evaluate(rule, end, limits.availableFrom, deadline)) evaluated++;
      } catch {
        failed++;
        await this.record(rule, end, 'unevaluable', null, 'eval_failed').catch(() => 0);
      }
    }
    await this.episode(failed > 0 || limits.watermark === 'stale');
    return { window_end: rfcOf(end), evaluated, failed, skipped };
  }

  /** 규칙 하나를 창 하나로 평가한다. 결과를 썼으면 true다(평가 중 규칙이 바뀌었거나 이미 평가한 창이면 false). */
  private async evaluate(rule: RuleRow, end: bigint, availableFrom: string, deadline: number): Promise<boolean> {
    const cond = rule.condition;
    const win = { from: end - BigInt(rule.window_minutes) * 60_000_000n, to: end };
    const connectionIds = cond.sources.connection_ids.map((x) => decodeConnectionId(x)).filter((x): x is number => x !== null);
    const quality = qualityOf(await loadTargets(this.db, cond, this.config));
    const count = await countWindow(
      this.ch.logs,
      cond,
      win,
      {
        availableFrom,
        connectionIds,
        blocks: await loadBlocks(this.db, connectionIds, null),
        firstSliceUs: BigInt(this.config.searchRun.firstSliceMinutes) * 60_000_000n,
      },
      (sql, p) => this.query(sql, p, deadline),
    );
    const met = count.matched >= rule.threshold;
    // 부분 결과가 임계 미만이면 판정하지 않는다(TD-13).
    const status = met ? 'met' : count.partial ? 'unevaluable' : 'below';
    return this.db.tx(async (c) => {
      const cur = (
        await c.query<{ ok: boolean; eval_state: string; resolve_streak: number; resolve_wait_minutes: number | null; name: string }>(
          `SELECT enabled AND deleted_at IS NULL AND condition_version = $2 AND window_minutes = $3 AND threshold = $4 AS ok,
                  eval_state, resolve_streak, resolve_wait_minutes, name
             FROM alert_rules WHERE id = $1 FOR UPDATE`,
          [rule.id, rule.condition_version, rule.window_minutes, rule.threshold],
        )
      ).rows[0];
      if (!cur?.ok) return false;
      const wrote = await c.query(
        `INSERT INTO alert_evaluations (rule_id, window_end, window_start, condition_version, status, matched_count, unknown_count, partial, quality, error_code)
         VALUES ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (rule_id, window_end) DO NOTHING`,
        [rule.id, rfcOf(win.to), rfcOf(win.from), rule.condition_version, status, count.matched, count.partial ? null : count.unknown, count.partial, quality, status === 'unevaluable' ? 'budget' : null],
      );
      if (!wrote.rowCount || status === 'unevaluable') return Boolean(wrote.rowCount);
      await c.query('UPDATE alert_rules SET last_success_eval_at = now(), quality = $2 WHERE id = $1', [rule.id, quality]);
      await this.transition(c, rule, cur, met, quality, win, count);
      return true;
    });
  }

  /** 상태 전이(5.4절). 메일은 정상→지속 때만 만든다. 감시 불가면 해소 계산을 멈춘다(Q12-05). */
  private async transition(
    c: Pick<Database, 'query'>,
    rule: RuleRow,
    cur: { eval_state: string; resolve_streak: number; resolve_wait_minutes: number | null; name: string },
    met: boolean,
    quality: Quality,
    win: { from: bigint; to: bigint },
    count: WindowCount,
  ): Promise<void> {
    const set = (state: string, streak: number, extra = '') =>
      c.query(`UPDATE alert_rules SET eval_state = $2, resolve_streak = $3, state_since = now()${extra} WHERE id = $1`, [rule.id, state, streak]);
    if (met) {
      if (cur.eval_state === 'normal') {
        await this.fire(c, rule, cur.name, quality, win, count);
        await set('firing', 0, ', last_fired_at = now()');
      } else if (cur.eval_state === 'resolving') {
        await set('firing', 0);
      }
      return;
    }
    if (quality === 'unmonitorable' || cur.eval_state === 'normal') return;
    const streak = cur.resolve_streak + 1;
    const waitSeconds = (cur.resolve_wait_minutes ?? rule.window_minutes) * 60;
    if (streak * this.config.alertEval.intervalSeconds >= waitSeconds) {
      await c.query(
        `UPDATE alert_incidents SET closed_at = now(), close_reason = 'resolved' WHERE rule_id = $1 AND closed_at IS NULL`,
        [rule.id],
      );
      await set('normal', 0);
    } else if (cur.eval_state === 'firing') {
      await set('resolving', 1);
    } else {
      await c.query('UPDATE alert_rules SET resolve_streak = $2 WHERE id = $1', [rule.id, streak]);
    }
  }

  /** 사건을 열고 받는 사람마다 메일 작업을 만든다. 수신처 고정 설정이 있으면 그 주소 하나로 보낸다. */
  private async fire(
    c: Pick<Database, 'query'>,
    rule: RuleRow,
    name: string,
    quality: Quality,
    win: { from: bigint; to: bigint },
    count: WindowCount,
  ): Promise<void> {
    const inc = await c.query<{ id: string }>(
      `INSERT INTO alert_incidents (public_ref, rule_id, condition_version, rule_name, condition, window_minutes, threshold,
                                    window_start, window_end, fired_at, matched_count, unknown_count, oldest_occurred_at, partial, quality)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, now(), $10, $11, $12::timestamptz, $13, $14)
       ON CONFLICT (rule_id, condition_version, window_end) DO NOTHING
       RETURNING id::text`,
      [
        randomBytes(12).toString('base64url'),
        rule.id,
        rule.condition_version,
        name,
        rule.condition,
        rule.window_minutes,
        rule.threshold,
        rfcOf(win.from),
        rfcOf(win.to),
        count.matched,
        count.partial ? null : count.unknown,
        count.oldest === null ? null : count.oldest.replace(' ', 'T') + 'Z',
        count.partial,
        quality,
      ],
    );
    if (!inc.rowCount) return;
    const addresses = (await c.query<{ address: string }>('SELECT address FROM alert_rule_recipients WHERE rule_id = $1 ORDER BY id', [rule.id])).rows.map((r) => r.address);
    const mail = this.config.mail;
    const recipients = mail ? deliveryRecipients(mail, addresses) : addresses;
    for (const to of recipients) {
      await c.query(
        `INSERT INTO mail_jobs (kind, incident_id, recipient, message_id, state, next_attempt_at) VALUES ('alert', $1::bigint, $2, $3, 'queued', now())`,
        [inc.rows[0].id, to, newMessageId(mail?.from ?? 'logdock@logdock.invalid')],
      );
    }
  }

  /** 평가하지 않은 창을 남긴다. 이미 있으면 그대로 둔다. */
  private async record(rule: RuleRow, end: bigint, status: 'skipped' | 'unevaluable', quality: Quality | null, error: string | null): Promise<number> {
    const r = await this.db.query(
      `INSERT INTO alert_evaluations (rule_id, window_end, window_start, condition_version, status, quality, error_code)
       VALUES ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7)
       ON CONFLICT (rule_id, window_end) DO NOTHING`,
      [rule.id, rfcOf(end), rfcOf(end - BigInt(rule.window_minutes) * 60_000_000n), rule.condition_version, status, quality, error],
    );
    return r.rowCount ?? 0;
  }

  /** 평가 실패 운영 일(Q12-06). 이어지는 동안 하나만 연다. 묶어 보내는 것은 운영 메일 확인(OpsEpisodes)이 한다. */
  private async episode(failing: boolean): Promise<void> {
    if (failing) {
      await this.db.query(
        `INSERT INTO ops_episodes (kind, started_at) VALUES ('alert_eval_failed', now())
         ON CONFLICT (kind, (coalesce(connection_id, 0))) WHERE ended_at IS NULL DO NOTHING`,
      );
    } else {
      await this.db.query(`UPDATE ops_episodes SET ended_at = now() WHERE kind = 'alert_eval_failed' AND ended_at IS NULL`);
    }
  }

  /** 평가 질의. 회차 예산의 남은 시간을 서버 실행 상한으로 건다(TD-19). */
  private async query<T>(sql: string, p: Params, deadline: number): Promise<T[]> {
    const left = deadline - Date.now();
    if (left <= 0) throw new Stop('budget');
    const cfg = this.config.alertEval;
    const settings: Record<string, string | number> = { max_execution_time: Math.max(0.1, left / 1000).toFixed(3) };
    if (cfg.maxThreads !== null) settings.max_threads = cfg.maxThreads;
    if (cfg.maxMemoryBytes !== null) settings.max_memory_usage = cfg.maxMemoryBytes;
    try {
      return await this.ch.rows<T>(sql, { params: p.values, settings, timeoutMs: left + 5000 });
    } catch (e) {
      if (e instanceof ClickHouseAborted || (e instanceof ClickHouseError && e.timedOut)) throw new Stop('budget');
      throw e;
    }
  }
}

