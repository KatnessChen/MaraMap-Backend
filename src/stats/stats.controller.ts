import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Headers,
  BadRequestException,
} from '@nestjs/common';
import { StatsService } from './stats.service';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';

@ApiTags('stats')
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get()
  @ApiOperation({ summary: 'Get cumulative statistics for a participant' })
  @ApiQuery({ name: 'participant', required: true, example: 'Davis' })
  async getStats(@Query('participant') participant: string) {
    if (!participant) {
      throw new BadRequestException('Participant name is required');
    }
    const data = await this.statsService.getParticipantStats(participant);
    if (!data) {
      return { message: `No stats found for participant: ${participant}` };
    }
    return data;
  }

  @Post('visit')
  @ApiOperation({ summary: 'Record a page visit (human vs bot auto-detected)' })
  async recordVisit(
    @Body('path') path: string,
    @Headers('user-agent') userAgent: string,
    @Headers('origin') origin: string,
  ) {
    if (!path) throw new BadRequestException('path is required');
    if (/localhost|127\.0\.0\.1/.test(origin || ''))
      return { ok: true, skipped: true };
    await this.statsService.recordVisit(path, userAgent || '');
    return { ok: true };
  }

  @Get('visits')
  @ApiOperation({ summary: 'Get page view counts (total + per page)' })
  async getVisits() {
    return this.statsService.getVisits();
  }

  @Post('refresh')
  @ApiOperation({
    summary: 'Manually trigger a refresh of all participant stats',
  })
  async refreshStats() {
    await this.statsService.refreshAllStats();
    return {
      message: 'Participant statistics refresh initiated successfully.',
    };
  }
}
