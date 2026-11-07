// 메일 상태·테스트 발송·운영 수신 주소(계약 4.3·4.4·5.5절, UI-14, Q12-06·08·12, TD-08·19·20·21).
// 메일 서버 설정은 서버 설정으로만 바꾸고 화면에는 비밀이 아닌 값만 준다. 테스트 메일은 설치 전체 발송 속도 상한 안에서 보내고,
// 결과의 실패 사유는 5.5절 코드를 그대로 쓰며 연결 문제와 주소 문제를 가른다.
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { checkRecipients } from '../alerts/alert-input.js';
import { AuditService } from '../audit/audit.service.js';
import { sha256 } from '../auth/tokens.js';
import { errors } from '../common/api-error.js';
import { claimIdempotency, completeIdempotency } from '../common/idempotency.js';
import type { AppConfig } from '../config.js';
import type { FieldProblem } from '../connections/connection-input.js';
import { Database, lockCount, type Queryable, utc } from '../db/database.js';
import { buildMessage, newMessageId } from './message.js';
import { APP_CONFIG } from '../tokens.js';
import { type MailReason, problemOf, sendMail } from './smtp.js';

export const TestMailBody = z.object({ address: z.string() });
export const RuleTestMailBody = z.object({
  addresses: z.array(z.string()),
  /** 편집 중인 규칙 이름. 본문에 넣어 어느 규칙의 확인 메일인지 알린다. 저장 전이라도 된다(WQ-41). */
  rule_name: z.string().max(200).optional(),
});
export const OpsRecipientsBody = z.object({ version: z.number().int().positive(), addresses: z.array(z.string()) });
export const ConfirmBody = z.object({ address: z.string() });

interface JobRow {
  id: string;
  recipient: string;
  state: string;
  last_error: MailReason | null;
}

/** 테스트 메일 한 통의 결과. `sending`은 같은 Idempotency-Key로 다시 물었을 때 아직 보내는 중인 경우다. */
function resultOf(j: JobRow) {
  const result = j.state === 'accepted' ? 'accepted' : j.state === 'failed' ? 'failed' : 'sending';
  return {
    address: j.recipient,
    result,
    reason: result === 'failed' ? j.last_error : null,
    problem: result === 'failed' && j.last_error ? problemOf(j.last_error) : null,
  };
}

@Injectable()
export class MailService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * 메일 상태(UI-14). 비밀이 아닌 서버 주소·포트·방식·발신 주소만 준다(TD-20). 연결 상태는 마지막 발송 시도로 정한다:
   * 시도가 없으면 `unknown`, 연결·설정 문제로 실패했으면 `error`, 아니면 `connected`. 주소 문제로 실패한 것은 연결 문제가 아니다.
   */
  async status() {
    const m = this.config.mail;
    const s = (
      await this.db.query<{ last_attempt_at: string | null; last_success_at: string | null; last_error: string | null }>(
        `SELECT ${utc('last_attempt_at')} AS last_attempt_at, ${utc('last_success_at')} AS last_success_at, last_error FROM mail_status WHERE id = 1`,
      )
    ).rows[0];
    return {
      configured: m !== null,
      server: m ? { host: m.host, port: m.port, security: m.security, from: m.from } : null,
      plain_relay: m?.security === 'plain_relay',
      connection: !s?.last_attempt_at ? 'unknown' : s.last_error ? 'error' : 'connected',
      last_attempt_at: s?.last_attempt_at ?? null,
      last_success_at: s?.last_success_at ?? null,
      last_error: s?.last_error ?? null,
    };
  }

  /** UI-14 테스트 발송. 받을 주소 하나. */
  async testOne(body: z.infer<typeof TestMailBody>, idemKey: string, accountId: number) {
    const problems: FieldProblem[] = [];
    const [address] = checkRecipients([body.address], 1, problems, 'address');
    if (problems.length) throw errors.validation(problems.map((p) => ({ ...p, path: 'address' })));
    const r = await this.sendTests('mail.test', [address], null, idemKey, accountId);
    return { status: r.status, body: { ...r.body.results[0] } };
  }

  /** 규칙 편집 화면의 테스트 메일(WQ-41). 저장 전 주소도 형식 검사를 통과하면 보낸다. 주소마다 따로 보낸다(TD-09). */
  async testRule(body: z.infer<typeof RuleTestMailBody>, idemKey: string, accountId: number) {
    const problems: FieldProblem[] = [];
    const addresses = checkRecipients(body.addresses, this.config.alertRecipientLimit, problems, 'addresses');
    if (problems.length) throw errors.validation(problems);
    const ruleName = body.rule_name?.replace(/\p{Cc}+/gu, ' ').trim() || null;
    return this.sendTests('alert_rule.test_mail', addresses, ruleName, idemKey, accountId);
  }

  /**
   * 테스트 메일을 보낸다. 발송은 네트워크를 기다리므로 트랜잭션 밖에서 한다. 먼저 키를 잡고 발송 속도 상한을 본 뒤 메일 작업을
   * `sending`으로 남겨 커밋하고, 보낸 뒤 결과를 적는다. 같은 키로 다시 오면 다시 보내지 않고 그 메일 작업의 지금 결과를 준다
   * (아직 보내는 중이면 202). 테스트 메일은 결과를 바로 알리려는 것이라 전송 여부 불명이어도 다시 보내지 않고 실패로 남긴다.
   */
  private async sendTests(kind: string, addresses: string[], ruleName: string | null, idemKey: string, accountId: number) {
    const mail = this.config.mail;
    if (!mail) throw errors.mailNotConfigured();
    const requestHash = sha256(kind, JSON.stringify({ addresses, ruleName }));
    const prepared = await this.db.tx(async (c) => {
      const claim = await claimIdempotency(c, accountId, idemKey, kind, requestHash);
      if (claim.kind === 'replay') return { replay: true as const, ids: (claim.result.mail_job_ids as string[]) ?? [] };
      await lockCount(c, 'mailRate', 0);
      const recent = (
        await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM mail_jobs WHERE last_attempt_at > now() - interval '1 minute'`)
      ).rows[0].n;
      if (recent + addresses.length > this.config.mailRatePerMinute) throw errors.rateLimited(60);
      const jobs: { id: string; to: string; messageId: string }[] = [];
      for (const to of addresses) {
        const messageId = newMessageId(mail.from);
        const id = (
          await c.query<{ id: string }>(
            `INSERT INTO mail_jobs (kind, recipient, message_id, state, attempts, last_attempt_at)
             VALUES ('test', $1, $2, 'sending', 1, now()) RETURNING id`,
            [to, messageId],
          )
        ).rows[0].id;
        jobs.push({ id, to, messageId });
      }
      await completeIdempotency(c, accountId, idemKey, 202, { mail_job_ids: jobs.map((j) => j.id) });
      return { replay: false as const, jobs };
    });
    if (prepared.replay) {
      const rows = await this.jobs(prepared.ids);
      return { status: rows.some((r) => r.state === 'sending') ? 202 : 200, body: { results: rows.map(resultOf) } };
    }
    const now = new Date();
    for (const job of prepared.jobs) {
      const outcome = await sendMail(
        { ...mail, timeoutMs: this.config.mailTimeoutSeconds * 1000 },
        {
          from: mail.from,
          to: job.to,
          data: buildMessage({ from: mail.from, to: job.to, subject: '[LogDock] 테스트 메일', text: testText(ruleName, now), messageId: job.messageId, date: now }),
        },
      );
      await this.finish(job.id, outcome.ok ? null : outcome.reason);
    }
    await this.db.tx((c) => completeIdempotency(c, accountId, idemKey, 200, { mail_job_ids: prepared.jobs.map((j) => j.id) }));
    return { status: 200, body: { results: (await this.jobs(prepared.jobs.map((j) => j.id))).map(resultOf) } };
  }

  /** 발송 결과를 메일 작업과 메일 상태에 적는다. 주소 문제는 연결이 된 것이라 연결 오류로 남기지 않는다. */
  private async finish(jobId: string, reason: MailReason | null): Promise<void> {
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE mail_jobs SET state = $2, last_error = $3, accepted_at = CASE WHEN $2 = 'accepted' THEN now() END WHERE id = $1`,
        [jobId, reason ? 'failed' : 'accepted', reason],
      );
      const connectionError = reason && problemOf(reason) !== 'address' ? reason : null;
      await c.query(
        `INSERT INTO mail_status (id, last_attempt_at, last_success_at, last_error, updated_at)
         VALUES (1, now(), CASE WHEN $1 THEN now() END, $2, now())
         ON CONFLICT (id) DO UPDATE SET last_attempt_at = now(),
           last_success_at = CASE WHEN $1 THEN now() ELSE mail_status.last_success_at END,
           last_error = $2, updated_at = now()`,
        [reason === null, connectionError],
      );
    });
  }

  private async jobs(ids: string[]): Promise<JobRow[]> {
    return (
      await this.db.query<JobRow>('SELECT id, recipient, state, last_error FROM mail_jobs WHERE id = ANY($1::bigint[]) ORDER BY id', [ids])
    ).rows;
  }

  /** 운영 수신 주소(UI-14). 수집 끊김·알림 평가 실패·디스크 경고 메일을 받는다(TD-21). 목록 전체의 `version`으로 동시 수정을 막는다. */
  async opsRecipients() {
    return this.db.tx(async (c) => this.opsView(c));
  }

  /**
   * 운영 수신 주소 목록을 통째로 바꾼다. 0개도 된다(없으면 `ops_recipients_missing` 배너). `version`이 다르면 덮어쓰지 않는다.
   * 남는 주소의 `받았음` 표시는 지키고, 뺀 주소로 아직 보내지 않은 운영 메일은 취소한다. 감사(`ops_recipients.update`)를 쓸 수
   * 없으면 바꾸지 않는다.
   */
  async putOpsRecipients(body: z.infer<typeof OpsRecipientsBody>, accountId: number) {
    const problems: FieldProblem[] = [];
    const want = checkRecipients(body.addresses, this.config.alertRecipientLimit, problems, 'addresses', 0);
    if (problems.length) throw errors.validation(problems);
    return this.db.tx(async (c) => {
      await this.ensureList(c);
      const version = (await c.query<{ version: number }>('SELECT version FROM ops_recipient_list WHERE id = 1 FOR UPDATE')).rows[0].version;
      if (version !== body.version) throw errors.versionConflict({ ...(await this.opsView(c)) });
      const current = (await c.query<{ address: string }>('SELECT address FROM ops_recipients ORDER BY added_at, id')).rows.map((r) => r.address);
      const have = new Set(current.map((a) => a.toLowerCase()));
      const keep = new Set(want.map((a) => a.toLowerCase()));
      const removed = current.filter((a) => !keep.has(a.toLowerCase()));
      const added = want.filter((a) => !have.has(a.toLowerCase()));
      if (!removed.length && !added.length) return this.opsView(c);
      if (removed.length) {
        const lower = removed.map((a) => a.toLowerCase());
        await c.query('DELETE FROM ops_recipients WHERE lower(address) = ANY($1::text[])', [lower]);
        await c.query(
          `UPDATE mail_jobs SET state = 'cancelled', cancel_reason = 'recipient_removed', next_attempt_at = NULL
            WHERE kind = 'ops' AND state IN ('queued', 'retry_wait') AND lower(recipient) = ANY($1::text[])`,
          [lower],
        );
      }
      if (added.length) await c.query('INSERT INTO ops_recipients (address) SELECT unnest($1::text[])', [added]);
      await c.query('UPDATE ops_recipient_list SET version = version + 1, updated_at = now() WHERE id = 1');
      await this.audit.writeOrHold(c, {
        action: 'ops_recipients.update',
        result: 'success',
        accountId,
        targetType: 'ops_recipients',
        changedFields: ['recipients'],
      });
      return this.opsView(c);
    });
  }

  /** 운영 수신 주소의 `받았음` 표시(WQ-82). 처음 한 번만 남기고 목록의 `version`은 올리지 않는다. 없는 주소는 404다. */
  async confirmOps(address: string, accountId: number) {
    return this.db.tx(async (c) => {
      await this.ensureList(c);
      await c.query('SELECT version FROM ops_recipient_list WHERE id = 1 FOR UPDATE');
      const a = address.trim();
      const found = (
        await c.query<{ confirmed: boolean }>('SELECT confirmed_at IS NOT NULL AS confirmed FROM ops_recipients WHERE lower(address) = lower($1)', [a])
      ).rows[0];
      if (!found) throw errors.notFound();
      if (!found.confirmed) {
        await c.query('UPDATE ops_recipients SET confirmed_at = now() WHERE lower(address) = lower($1)', [a]);
        await this.audit.writeOrHold(c, {
          action: 'ops_recipients.update',
          result: 'success',
          accountId,
          targetType: 'ops_recipients',
          changedFields: ['recipient_confirmed'],
        });
      }
      return this.opsView(c);
    });
  }

  /** 한 행 테이블은 쓰는 프로그램이 없으면 넣는다(계약 3.4절). */
  private async ensureList(c: Queryable): Promise<void> {
    await c.query('INSERT INTO ops_recipient_list (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  }

  private async opsView(c: Queryable) {
    await this.ensureList(c);
    const version = (await c.query<{ version: number }>('SELECT version FROM ops_recipient_list WHERE id = 1')).rows[0].version;
    const recipients = (
      await c.query<{ address: string; confirmed_at: string | null }>(
        `SELECT address, ${utc('confirmed_at')} AS confirmed_at FROM ops_recipients ORDER BY added_at, id`,
      )
    ).rows;
    return { recipients, version, limit: this.config.alertRecipientLimit };
  }
}

/** 테스트 메일 본문. 규칙 이름은 사람이 넣은 값이라 제어 문자를 이미 뺐다. */
function testText(ruleName: string | null, at: Date): string {
  return [
    'LogDock 테스트 메일입니다.',
    '',
    ruleName ? `알림 규칙 "${ruleName}"의 수신 주소를 확인하려고 보냈습니다.` : '이 주소로 LogDock 메일을 받을 수 있는지 확인하려고 보냈습니다.',
    '받았다면 LogDock 화면에서 "받았음"을 눌러 주세요.',
    '',
    `보낸 시각(UTC): ${at.toISOString()}`,
  ].join('\n');
}

