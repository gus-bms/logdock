// 알림·운영 메일 발송(계약 5.5절, Q12-09·10·11, TD-09·19, F-08). mail_jobs 표에서 보낼 시각이 된 작업을 행 잠금으로 꺼내
// 보내고 결과를 적는다. 별도 메시지 브로커는 두지 않는다(D17). 테스트 메일(`test`)은 API가 바로 보내므로 다루지 않는다.
import type { AppConfig } from '../config.js';
import { Database, lockCount, type Queryable, utc } from '../db/database.js';
import { buildMessage } from '../mail/message.js';
import { alertMessage, type EpisodeForMail, type IncidentForMail, opsMessage } from '../mail/notify-message.js';
import { deliveryRecipients, recordMailStatus } from '../mail/outcome.js';
import { sendMail, type SendOutcome } from '../mail/smtp.js';
import { loadReferences } from '../search/references.js';

interface ClaimedJob {
  id: string;
  kind: 'alert' | 'ops';
  incident_id: string | null;
  ops_batch_id: string | null;
  recipient: string;
  message_id: string;
  attempts: number;
  /** 첫 시도부터 지난 초. 재시도 상한(총 4시간)을 잰다. */
  age_seconds: number;
}

/** 한 번에 꺼내는 최대 작업 수. 발송 속도 상한이 더 작으면 그만큼만 꺼낸다. */
const BATCH = 10;

export class MailSender {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * 다시 시작할 때 한 번 부른다. `전송 중`에 멈춘 작업은 서버가 받았는지 모르므로 `전송 여부 불명`으로 바꿔 같은 Message-ID로
   * 다시 보낸다(F-08, Q12-10).
   */
  async recover(): Promise<number> {
    const r = await this.db.query(
      `UPDATE mail_jobs SET state = 'unknown', next_attempt_at = now() WHERE state = 'sending' AND kind IN ('alert', 'ops')`,
    );
    return r.rowCount ?? 0;
  }

  /** 보낼 시각이 된 작업을 발송 속도 상한 안에서 꺼내 보낸다. 보낸 수를 돌려준다. */
  async sendDue(): Promise<number> {
    const mail = this.config.mail;
    if (!mail) return 0;
    const jobs = await this.claim();
    for (const job of jobs) {
      let outcome: SendOutcome;
      try {
        const msg = await this.compose(job);
        // 수신처 고정이 있으면 고정 전에 만든 작업도 그 주소로 보낸다.
        const [to] = deliveryRecipients(mail, [job.recipient]);
        outcome = await sendMail(
          { ...mail, timeoutMs: this.config.mailTimeoutSeconds * 1000 },
          { from: mail.from, to, data: buildMessage({ from: mail.from, to, ...msg, messageId: job.message_id, date: new Date() }) },
        );
      } catch {
        // 본문을 만들 수 없거나 예상하지 못한 오류. 연결 문제처럼 다시 시도한다.
        outcome = { ok: false, reason: 'mail_temporary_failure', permanent: false, unknown: false };
      }
      await this.record(job, outcome);
    }
    return jobs.length;
  }

  /** 발송 속도 상한(설치 전체, 분당)을 지키며 작업을 꺼내 `전송 중`으로 바꾼다. 여러 worker가 돌아도 한 작업은 한 번만 꺼낸다. */
  private async claim(): Promise<ClaimedJob[]> {
    return this.db.tx(async (c) => {
      await lockCount(c, 'mailRate', 0);
      const recent = (
        await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM mail_jobs WHERE last_attempt_at > now() - interval '1 minute'`)
      ).rows[0].n;
      const room = Math.min(BATCH, this.config.mailRatePerMinute - recent);
      if (room <= 0) return [];
      return (
        await c.query<ClaimedJob>(
          `UPDATE mail_jobs SET state = 'sending', attempts = attempts + 1, last_attempt_at = now()
            WHERE id IN (
              SELECT id FROM mail_jobs
               WHERE kind IN ('alert', 'ops') AND state IN ('queued', 'retry_wait', 'unknown')
                 AND (next_attempt_at IS NULL OR next_attempt_at <= now())
               ORDER BY coalesce(next_attempt_at, created_at), id
               LIMIT $1 FOR UPDATE SKIP LOCKED)
            RETURNING id::text, kind, incident_id::text, ops_batch_id::text, recipient, message_id, attempts,
                      extract(epoch FROM now() - created_at)::float8 AS age_seconds`,
          [room],
        )
      ).rows;
    });
  }

  private async compose(job: ClaimedJob): Promise<{ subject: string; text: string }> {
    const o = {
      timezone: this.config.displayTimezone,
      baseUrl: this.config.publicBaseUrl,
      now: new Date(),
      delayNoticeSeconds: this.config.mailDelayNoticeSeconds,
    };
    return this.db.tx(async (c) => {
      if (job.kind === 'alert') {
        const inc = await incidentForMail(c, job.incident_id!);
        return alertMessage(inc, await loadReferences(c, [inc.condition]), o);
      }
      return opsMessage(await episodesForMail(c, job.ops_batch_id!), o);
    });
  }

  /**
   * 결과를 적는다(5.5절 발송 결과표). 수락은 끝, 수신자 거부·본문 뒤 거부는 그 수신자만 바로 최종 실패, 본문 뒤 무응답은
   * `전송 여부 불명`으로 같은 Message-ID를 다시 보내고, 나머지는 재시도 대기다. 시도가 상한(12회)에 닿거나 첫 시도부터 4시간이
   * 지나면 `mail_retry_exhausted`로 최종 실패다. 재시도 간격은 1·2·5·10·20분 뒤 30분씩이고 ±10% 흔들림을 준다.
   */
  private async record(job: ClaimedJob, outcome: SendOutcome): Promise<void> {
    const retry = this.config.mailRetry;
    await this.db.tx(async (c) => {
      if (outcome.ok) {
        await c.query(
          `UPDATE mail_jobs SET state = 'accepted', accepted_at = now(), last_error = NULL, next_attempt_at = NULL WHERE id = $1`,
          [job.id],
        );
      } else if (outcome.permanent) {
        await c.query(`UPDATE mail_jobs SET state = 'failed', last_error = $2, next_attempt_at = NULL WHERE id = $1`, [job.id, outcome.reason]);
      } else {
        const delayMs = this.delayMs(job.attempts);
        const exhausted = job.attempts >= retry.maxAttempts || (job.age_seconds * 1000 + delayMs) / 3600000 > retry.maxHours;
        if (exhausted) {
          await c.query(`UPDATE mail_jobs SET state = 'failed', last_error = 'mail_retry_exhausted', next_attempt_at = NULL WHERE id = $1`, [job.id]);
        } else {
          await c.query(
            `UPDATE mail_jobs SET state = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`,
            [job.id, outcome.unknown ? 'unknown' : 'retry_wait', outcome.reason, delayMs / 1000],
          );
        }
      }
      await recordMailStatus(c, outcome.ok ? null : outcome.reason);
    });
  }

  /** k번째 시도가 실패했을 때 다음 시도까지의 간격(밀리초). */
  private delayMs(attempts: number): number {
    const list = this.config.mailRetry.intervalsMinutes;
    const minutes = list[Math.min(attempts, list.length) - 1] ?? list[list.length - 1];
    return Math.round(minutes * 60000 * (0.9 + this.random() * 0.2));
  }
}

async function incidentForMail(c: Queryable, id: string): Promise<IncidentForMail> {
  const r = await c.query<IncidentForMail>(
    `SELECT public_ref, rule_name, condition, window_minutes, threshold, ${utc('window_start')} AS window_start,
            ${utc('window_end')} AS window_end, ${utc('fired_at')} AS fired_at, matched_count::float8 AS matched_count,
            unknown_count::float8 AS unknown_count, ${utc('oldest_occurred_at')} AS oldest_occurred_at, partial, quality,
            ${utc('closed_at')} AS closed_at, close_reason
       FROM alert_incidents WHERE id = $1`,
    [id],
  );
  if (!r.rows[0]) throw new Error('incident not found');
  return r.rows[0];
}

async function episodesForMail(c: Queryable, batchId: string): Promise<EpisodeForMail[]> {
  return (
    await c.query<EpisodeForMail>(
      `SELECT e.kind, ${utc('e.started_at')} AS started_at, s.name AS service_name, v.display_name AS server_display_name,
              CASE WHEN c.target_type = 'file' THEN c.target_path ELSE c.journald_kind || ':' || c.journald_name END AS target
         FROM ops_episodes e
         LEFT JOIN connections c ON c.id = e.connection_id
         LEFT JOIN services s ON s.id = c.service_id
         LEFT JOIN servers v ON v.id = c.server_id
        WHERE e.ops_batch_id = $1 ORDER BY e.started_at, e.id`,
      [batchId],
    )
  ).rows;
}

