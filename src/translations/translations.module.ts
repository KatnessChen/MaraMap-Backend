import { Module } from '@nestjs/common';
import { TranslationsController } from './translations.controller';
import { TranslationsService } from './translations.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../auth/guards/admin.guard';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [TranslationsController],
  providers: [TranslationsService, AdminGuard],
  exports: [TranslationsService],
})
export class TranslationsModule {}
