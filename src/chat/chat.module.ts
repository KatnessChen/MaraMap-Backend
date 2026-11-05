import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../auth/guards/admin.guard';
import { ChatGuestGuard } from '../auth/guards/chat-guest.guard';
import { SupabaseModule } from '../supabase/supabase.module';
import { ChatController } from './chat.controller';
import { ChatGuestController } from './chat-guest.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [ChatController, ChatGuestController],
  providers: [ChatService, AdminGuard, ChatGuestGuard],
})
export class ChatModule {}
