import { Module } from '@nestjs/common';
import { FbImportController } from './fb-import.controller';
import { FbImportService } from './fb-import.service';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../auth/guards/admin.guard';
import { StatsModule } from '../stats/stats.module';

@Module({
  imports: [AuthModule, StatsModule],
  controllers: [FbImportController],
  providers: [FbImportService, AdminGuard],
})
export class FbImportModule {}
