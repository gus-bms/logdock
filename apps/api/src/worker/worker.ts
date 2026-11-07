// 백그라운드 작업 프로세스(`logdock-worker`, 2026-11-07 사용자 합의 A안). API와 같은 코드로 따로 띄워, API를 재시작해도 메일 발송이
// 멈추지 않게 한다. 지금은 메일 발송, 운영 메일 확인, 기록 정리를 돌린다. 알림 평가는 로그 저장소(ClickHouse)를 붙일 때 더한다.
import { Logger } from '@nestjs/common';

import type { AppConfig } from '../config.js';
import { Database } from '../db/database.js';
import { Cleanup } from './cleanup.js';
import { MailSender } from './mail-sender.js';
import { OpsEpisodes } from './ops-episodes.js';

export class Worker {
  private readonly log = new Logger('Worker');
  private readonly sender: MailSender;
  private readonly ops: OpsEpisodes;
  private readonly cleanup: Cleanup;
  private stopping = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {
    this.sender = new MailSender(db, config);
    this.ops = new OpsEpisodes(db, config);
    this.cleanup = new Cleanup(db, config);
  }

  async start(): Promise<void> {
    const recovered = await this.sender.recover();
    if (recovered) this.log.warn(`${recovered} mail jobs were sending when the worker stopped; they will be sent again with the same Message-ID`);
    if (!this.config.mail) this.log.warn('mail is not configured; alert and ops mail will wait');
    this.every(this.config.mailPollSeconds, 'mail', () => this.sender.sendDue());
    this.every(this.config.opsCheckSeconds, 'ops', () => this.ops.check());
    this.every(this.config.cleanup.intervalSeconds, 'cleanup', async () => {
      const counts = await this.cleanup.run();
      const failed = Object.entries(counts).filter(([, n]) => n < 0).map(([k]) => k);
      if (failed.length) this.log.warn(`cleanup steps failed: ${failed.join(', ')}`);
    });
  }

  /** 새 회차를 시작하지 않고, 도는 회차가 끝나기를 기다린다. 발송 중인 메일은 시간 제한 안에서 끝난다. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearTimeout(t);
    await this.running.catch(() => undefined);
  }

  /** 한 회차가 끝난 뒤 다음 회차를 잡는다. 회차가 겹치지 않고, 한 회차의 오류가 다음 회차를 막지 않는다. 오류에는 주소를 남기지 않는다. */
  private every(seconds: number, name: string, fn: () => Promise<unknown>): void {
    const run = async () => {
      if (this.stopping) return;
      const p = fn().catch((e: unknown) => this.log.error(`${name} round failed: ${(e as Error)?.message ?? 'unknown error'}`));
      this.running = this.running.then(() => p);
      await p;
      if (!this.stopping) this.timers.add(setTimeout(run, seconds * 1000));
    };
    void run();
  }
}
