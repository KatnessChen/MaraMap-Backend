import {
  Controller,
  Get,
  Post,
  Query,
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
