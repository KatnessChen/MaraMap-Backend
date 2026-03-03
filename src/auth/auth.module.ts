import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { SupabaseStrategy } from './strategies/supabase.strategy';
import { SupabaseAuthGuard } from './guards/supabase-auth.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'supabase-jwt' })],
  controllers: [AuthController],
  providers: [SupabaseStrategy, SupabaseAuthGuard, AuthService],
  exports: [PassportModule, SupabaseAuthGuard],
})
export class AuthModule {}
