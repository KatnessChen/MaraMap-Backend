import { Module } from '@nestjs/common';
import { FbImportController } from './fb-import.controller';
import { FbImportService } from './fb-import.service';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../auth/guards/admin.guard';

@Module({
  imports: [AuthModule],
  controllers: [FbImportController],
  providers: [FbImportService, AdminGuard],
})
export class FbImportModule {}
