import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { SupabaseModule } from './supabase/supabase.module';
import { AuthModule } from './auth/auth.module';
import { FbPostsModule } from './fb-posts/fb-posts.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    HealthModule,
    SupabaseModule,
    AuthModule,
    FbPostsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

