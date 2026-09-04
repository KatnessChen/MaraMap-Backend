import { Module } from '@nestjs/common';
import { LocationTranslationsController } from './location-translations.controller';
import { LocationTranslationsService } from './location-translations.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../auth/guards/admin.guard';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [LocationTranslationsController],
  providers: [LocationTranslationsService, AdminGuard],
  exports: [LocationTranslationsService],
})
export class LocationTranslationsModule {}
