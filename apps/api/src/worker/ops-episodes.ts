// 운영 메일(계약 5.5절 운영 메일, Q12-06, TD-21). 관측되지 않는 연결을 일(`ops_episodes`)로 열고, 유예(10분)를 넘긴 일을 확인
// 회차마다 모아 운영 수신 주소마다 한 통으로 보낸다. 같은 일은 이어지는 동안 다시 싣지 않고, 끝나면 닫으며 회복 메일은 없다.
// 보관된 연결과 첫 보고 전(`연결 대기`)인 연결은 넣지 않는다. 알림 평가 실패와 디스크 경고는 그 일을 아는 작업이 연다.
import type { AppConfig } from '../config.js';
import { CONNECTION_ROWS, observationParams } from '../connections/connection-views.service.js';
import { Database } from '../db/database.js';
import { newMessageId } from '../mail/message.js';
import { deliveryRecipients } from '../mail/outcome.js';

/** 관측되지 않는 대상으로 보는 관측 상태(5.4절 관측 판단과 같다). */
const UNOBSERVED = ['stale', 'send_error', 'read_paused', 'disk_unavailable', 'needs_check'];

export class OpsEpisodes {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  /** 한 회차. 새로 관측되지 않는 연결의 일을 열고, 다시 관측되는 연결의 일을 닫고, 유예를 넘긴 일을 묶어 메일 작업을 만든다. */
  async check(): Promise<{ opened: number; closed: number; batched: number }> {
    return this.db.tx(async (c) => {
      const unobserved = (
        await c.query<{ id: number }>(
          `SELECT id FROM (${CONNECTION_ROWS}) x WHERE management_state <> 'archived' AND observation && $3::text[]`,
          [...observationParams(this.config), UNOBSERVED],
        )
      ).rows.map((r) => r.id);
      const opened = await c.query(
        `INSERT INTO ops_episodes (kind, connection_id, started_at)
         SELECT 'connection_unobserved', id, now() FROM unnest($1::int[]) AS id
         ON CONFLICT (kind, (coalesce(connection_id, 0))) WHERE ended_at IS NULL DO NOTHING`,
        [unobserved],
      );
      const closed = await c.query(
        `UPDATE ops_episodes SET ended_at = now()
          WHERE kind = 'connection_unobserved' AND ended_at IS NULL AND NOT (connection_id = ANY($1::int[]))`,
        [unobserved],
      );
      const due = (
        await c.query<{ id: string }>(
          `SELECT id::text FROM ops_episodes
            WHERE ended_at IS NULL AND ops_batch_id IS NULL
              AND (kind = 'disk_warning' OR started_at <= now() - make_interval(secs => $1))
            ORDER BY started_at, id FOR UPDATE`,
          [this.config.opsGraceSeconds],
        )
      ).rows.map((r) => r.id);
      const mail = this.config.mail;
      const recipients = mail
        ? deliveryRecipients(mail, (await c.query<{ address: string }>('SELECT address FROM ops_recipients ORDER BY added_at, id')).rows.map((r) => r.address))
        : [];
      // 메일 설정이나 받을 주소가 없으면 묶지 않는다. 주소가 생기면 아직 이어지는 일을 그때 보낸다.
      if (!due.length || !mail || !recipients.length) return { opened: opened.rowCount ?? 0, closed: closed.rowCount ?? 0, batched: 0 };
      const batch = (await c.query<{ id: string }>('INSERT INTO ops_mail_batches DEFAULT VALUES RETURNING id::text')).rows[0].id;
      await c.query('UPDATE ops_episodes SET ops_batch_id = $1 WHERE id = ANY($2::bigint[])', [batch, due]);
      for (const to of recipients) {
        await c.query(
          `INSERT INTO mail_jobs (kind, ops_batch_id, recipient, message_id, state, next_attempt_at) VALUES ('ops', $1, $2, $3, 'queued', now())`,
          [batch, to, newMessageId(mail.from)],
        );
      }
      return { opened: opened.rowCount ?? 0, closed: closed.rowCount ?? 0, batched: due.length };
    });
  }
}
