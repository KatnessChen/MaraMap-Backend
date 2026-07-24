import { Module } from '@nestjs/common';
import { FbImportController } from './fb-import.controller';
import { FbImportService } from './fb-import.service';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../auth/guards/admin.guard';
import { StatsModule } from '../stats/stats.module';
import { StorageModule } from '../storage/storage.module';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [AuthModule, StatsModule, StorageModule, SupabaseModule],
  controllers: [FbImportController],
  providers: [FbImportService, AdminGuard],
})
export class FbImportModule {}
