import { Controller, Get } from '@nestjs/common';

import { Public } from './auth/auth.guard.js';

@Public()
@Controller('health')
export class HealthController {
  @Get()
  getHealth(): { status: 'ok'; service: 'logdock-api' } {
    return { status: 'ok', service: 'logdock-api' };
  }
}
