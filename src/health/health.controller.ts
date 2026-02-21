import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health-check')
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
