import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../auth/guards/admin.guard';
import { SupabaseModule } from '../supabase/supabase.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [ChatController],
  providers: [ChatService, AdminGuard],
})
export class ChatModule {}
