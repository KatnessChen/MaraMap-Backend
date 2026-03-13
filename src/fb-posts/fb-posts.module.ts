import { Module } from '@nestjs/common';
import { FbPostsController } from './fb-posts.controller';
import { FbPostsService } from './fb-posts.service';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [FbPostsController],
  providers: [FbPostsService],
  exports: [FbPostsService],
})
export class FbPostsModule {}
