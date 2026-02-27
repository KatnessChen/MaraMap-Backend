import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private client: SupabaseClient | null = null;

  constructor(private readonly configService: ConfigService) {}

  getClient(): SupabaseClient {
    if (!this.client) {
      const url = this.configService.getOrThrow<string>('SUPABASE_URL');
      const key = this.configService.getOrThrow<string>(
        'SUPABASE_SERVICE_ROLE_KEY',
      );
      this.client = createClient(url, key);
    }
    return this.client;
  }
}
