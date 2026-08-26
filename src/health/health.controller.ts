import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

@ApiTags('Health')
@Controller()
export class HealthController {
  @Get('health-check')
  @SkipThrottle()
  @ApiOperation({
    summary: 'Health check',
    description: 'Returns service status and current timestamp.',
  })
  @ApiResponse({ status: 200, description: 'Service is healthy.' })
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
