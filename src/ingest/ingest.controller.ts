import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { IngestService } from './ingest.service';
import { CreateIngestDto } from './dto/create-ingest.dto';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { AuthUser } from '../auth/strategies/supabase.strategy';

@ApiTags('Ingestion')
@ApiBearerAuth('supabase-jwt')
@Controller('ingest')
@UseGuards(SupabaseAuthGuard)
export class IngestController {
  constructor(private readonly ingestService: IngestService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Ingest a scraped post',
    description:
      'Receives a raw post payload from the Chrome Extension, saves it as PENDING, and queues a Cloud Tasks job for async processing.',
  })
  @ApiResponse({ status: 202, description: 'Post accepted and queued.' })
  @ApiResponse({ status: 400, description: 'Validation failed.' })
  @ApiResponse({ status: 401, description: 'Unauthorized.' })
  @ApiResponse({
    status: 409,
    description: 'Post already exists (duplicate source_id).',
  })
  async create(
    @Body() dto: CreateIngestDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.ingestService.createIngest(dto, req.user.userId);
  }
}
