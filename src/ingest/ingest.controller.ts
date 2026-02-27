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
import { IngestService } from './ingest.service';
import { CreateIngestDto } from './dto/create-ingest.dto';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { AuthUser } from '../auth/strategies/supabase.strategy';

@Controller('ingest')
@UseGuards(SupabaseAuthGuard)
export class IngestController {
  constructor(private readonly ingestService: IngestService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @Body() dto: CreateIngestDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.ingestService.createIngest(dto, req.user.userId);
  }
}
