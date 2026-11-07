// 저장 공간(계약 4.3절 `GET /api/v1/storage`, UI-13, Q13·Q13-01, WQ-72·WQ-76). 보관 기간, 마지막 측정의 저장량·상한·디스크 여유와
// 측정 시각·추정 여부, 조회 가능 시작일, 최근 보관 기간 안의 조기 삭제, 경고 상태를 준다. 측정 값은 `storage_metrics`의 마지막
// 행이고 측정이 아직 없으면 null이다.
import { Controller, Get, Inject, Injectable } from '@nestjs/common';

import type { AppConfig } from '../config.js';
import { Database, utc } from '../db/database.js';
import { loadLimits } from '../search/scope.js';
import { APP_CONFIG } from '../tokens.js';

@Injectable()
export class StorageService {
  constructor(
    private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async storage() {
    const limits = await loadLimits(this.db, this.config);
    const m = (
      await this.db.query<{ measured_at: string; log_bytes: string | null; log_limit_bytes: string | null; disk_free_bytes: string | null; estimated: boolean }>(
        `SELECT ${utc('measured_at')} AS measured_at, log_bytes::text, log_limit_bytes::text, disk_free_bytes::text, estimated
           FROM storage_metrics ORDER BY measured_at DESC LIMIT 1`,
      )
    ).rows[0];
    const early = (
      await this.db.query<{ happened_at: string; received_from: string; received_to: string; bytes: string | null }>(
        `SELECT ${utc('happened_at')} AS happened_at, ${utc('received_from')} AS received_from, ${utc('received_to')} AS received_to, bytes::text
           FROM early_deletions WHERE happened_at >= now() - make_interval(months => $1) ORDER BY happened_at DESC LIMIT 20`,
        [this.config.logRetentionMonths],
      )
    ).rows;
    const warnings = (
      await this.db.query<{ kind: string }>(
        `SELECT DISTINCT kind FROM notices WHERE kind IN ('disk_warning', 'storage_unmeasurable') AND cleared_at IS NULL ORDER BY kind`,
      )
    ).rows.map((r) => r.kind);
    const num = (x: string | null | undefined) => (x === null || x === undefined ? null : Number(x));
    return {
      retention_months: this.config.logRetentionMonths,
      available_from: limits.availableFrom,
      measured_at: m?.measured_at ?? null,
      estimated: m?.estimated ?? null,
      log_bytes: num(m?.log_bytes),
      log_limit_bytes: num(m?.log_limit_bytes),
      disk_free_bytes: num(m?.disk_free_bytes),
      early_deletions: early.map((e) => ({ happened_at: e.happened_at, received_from: e.received_from, received_to: e.received_to, bytes: num(e.bytes) })),
      warnings,
    };
  }
}

@Controller('v1/storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Get()
  async get() {
    return this.storage.storage();
  }
}
