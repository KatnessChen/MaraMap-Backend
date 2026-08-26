import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CacheModule } from '@nestjs/cache-manager';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
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
    // Per-IP baseline for every route; individual controllers override this
    // with a stricter @Throttle() where a route is either abuse-sensitive
    // (login) or triggers expensive downstream work (fb-import's AI/R2
    // pipeline). See main.ts for the `trust proxy` setting this relies on to
    // read the real client IP behind Cloud Run's proxy.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    HealthModule,
    SupabaseModule,
    AuthModule,
    FbPostsModule,
    StatsModule,
    FbImportModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
