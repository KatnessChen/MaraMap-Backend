import { Module } from '@nestjs/common';
import { FbPostsController } from './fb-posts.controller';
import { FbPostsService } from './fb-posts.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../auth/guards/admin.guard';
import { StorageModule } from '../storage/storage.module';
import { StatsModule } from '../stats/stats.module';
import { LocationTranslationsModule } from '../location-translations/location-translations.module';
import { TranslationsModule } from '../translations/translations.module';

@Module({
  imports: [
    SupabaseModule,
    AuthModule,
    StorageModule,
    StatsModule,
    LocationTranslationsModule,
    TranslationsModule,
  ],
  controllers: [FbPostsController],
  providers: [FbPostsService, AdminGuard],
  exports: [FbPostsService],
})
export class FbPostsModule {}
