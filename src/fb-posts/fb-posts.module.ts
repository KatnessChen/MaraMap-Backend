import { Module } from '@nestjs/common';
import { FbPostsController } from './fb-posts.controller';
import { FbPostsService } from './fb-posts.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../auth/guards/admin.guard';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [SupabaseModule, AuthModule, StorageModule],
  controllers: [FbPostsController],
  providers: [FbPostsService, AdminGuard],
  exports: [FbPostsService],
})
export class FbPostsModule {}
