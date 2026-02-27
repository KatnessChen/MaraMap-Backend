import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateIngestDto } from './dto/create-ingest.dto';

export interface IngestResult {
  message: string;
  postId: string;
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async createIngest(
    dto: CreateIngestDto,
    userId: string,
  ): Promise<IngestResult> {
    const client = this.supabaseService.getClient();

    this.logger.debug(`Ingesting post - source_id: ${dto.source_id}, userId: ${userId}`);

    // Idempotency check: source_id is globally unique per DB schema
    const { data: existing, error: selectError } = await client
      .from('posts')
      .select('id')
      .eq('source_id', dto.source_id)
      .maybeSingle();

    if (selectError) {
      this.logger.error(`Idempotency check failed: ${selectError.message}`);
      throw new InternalServerErrorException(
        `Failed to check for existing post: ${selectError.message}`,
      );
    }

    if (existing) {
      this.logger.log(`Post already exists - source_id: ${dto.source_id}, postId: ${existing.id}`);
      return { message: 'Already exists', postId: existing.id as string };
    }

    // Insert new post with PENDING status
    // Store original_url and raw_images in meta JSONB field
    const insertPayload = {
      source_id: dto.source_id,
      raw_text: dto.raw_text,
      user_id: userId,
      status: 'PENDING',
      meta: {
        original_url: dto.original_url,
        raw_images: dto.raw_images ?? [],
      },
    };

    this.logger.debug(`Inserting post: ${JSON.stringify(insertPayload)}`);

    const { data: inserted, error: insertError } = await client
      .from('posts')
      .insert(insertPayload)
      .select('id')
      .single();

    if (insertError) {
      this.logger.error(`Insert failed: ${insertError.message}`);
      throw new InternalServerErrorException(
        `Failed to save post: ${insertError.message}`,
      );
    }

    if (!inserted) {
      this.logger.error('Insert returned no data');
      throw new InternalServerErrorException('Failed to save post: No data returned');
    }

    this.logger.log(`Post created successfully - postId: ${inserted.id}, source_id: ${dto.source_id}`);

    // TODO: Dispatch GCP Cloud Task for async AI processing
    // e.g. await this.cloudTasksService.enqueue({ postId: inserted.id });

    return { message: 'Ingestion accepted', postId: inserted.id as string };
  }
}
