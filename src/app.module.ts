import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CacheModule } from '@nestjs/cache-manager';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { SupabaseModule } from './supabase/supabase.module';
import { AuthModule } from './auth/auth.module';
import { FbPostsModule } from './fb-posts/fb-posts.module';
import { StatsModule } from './stats/stats.module';
import { FbImportModule } from './fb-import/fb-import.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CacheModule.register({ isGlobal: true, ttl: 60 * 60 * 1000 }),
    ScheduleModule.forRoot(),
    HealthModule,
    SupabaseModule,
    AuthModule,
    FbPostsModule,
    StatsModule,
    FbImportModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
