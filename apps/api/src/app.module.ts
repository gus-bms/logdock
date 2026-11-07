import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuditService } from './audit/audit.service.js';
import { AccountController } from './auth/account.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { SessionService } from './auth/session.service.js';
import { ThrottleService } from './auth/throttle.service.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { CatalogService } from './catalog/catalog.service.js';
import { type AppConfig } from './config.js';
import { Database } from './db/database.js';
import { HealthController } from './health.controller.js';
import { APP_CONFIG } from './tokens.js';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, AccountController, CatalogController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        Database,
        ThrottleService,
        SessionService,
        AuditService,
        AuthService,
        CatalogService,
        // 모든 경로를 한 검사 지점에서 확인한다(계약 4.1절). 세션 없이 부르는 경로는 @Public으로 연다.
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
