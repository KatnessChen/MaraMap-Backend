import { Module } from '@nestjs/common';
import { FbPostsController } from './fb-posts.controller';
import { FbPostsService } from './fb-posts.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../auth/guards/admin.guard';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [FbPostsController],
  providers: [FbPostsService, AdminGuard],
  exports: [FbPostsService],
})
export class FbPostsModule {}
