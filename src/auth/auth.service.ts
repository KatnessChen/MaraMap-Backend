import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { LoginDto } from './dto/login.dto';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  private client: SupabaseClient;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {
    const url = this.configService.getOrThrow<string>('SUPABASE_URL');
    const key = this.configService.getOrThrow<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
    );
    this.client = createClient(url, key);
  }

  async login(dto: LoginDto): Promise<{ token: string; role?: string }> {
    const { email, password } = dto;

    // --- Hardcoded Admin Check ---
    const adminUsername =
      this.configService.get<string>('ADMIN_USERNAME') || 'admin';
    const adminPassword =
      this.configService.get<string>('ADMIN_PASSWORD') || '81986369';

    if (email === adminUsername && password === adminPassword) {
      console.log('🔑 Admin login detected. Generating JWT...');
      // 生成真正的 JWT Token
      const payload = { username: adminUsername, sub: 'admin', role: 'admin' };
      return {
        token: this.jwtService.sign(payload),
        role: 'admin',
      };
    }

    // --- Regular Supabase Login ---
    const { data, error } = await this.client.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.session) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return { token: data.session.access_token };
  }

  /**
   * 驗證管理員 Token
   */
  async verifyAdminToken(token: string): Promise<boolean> {
    try {
      const payload = await this.jwtService.verifyAsync(token);
      return payload.role === 'admin';
    } catch {
      return false;
    }
  }
}
