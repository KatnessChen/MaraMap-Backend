import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { LoginDto } from './dto/login.dto';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  private client: SupabaseClient;
  private readonly adminUsername: string;
  private readonly adminPassword: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {
    const url = this.configService.getOrThrow<string>('SUPABASE_URL');
    const key = this.configService.getOrThrow<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
    );
    this.client = createClient(url, key);
    // No fallback: a missing ADMIN_USERNAME/ADMIN_PASSWORD must fail startup,
    // not silently arm a hardcoded credential.
    this.adminUsername =
      this.configService.getOrThrow<string>('ADMIN_USERNAME');
    this.adminPassword =
      this.configService.getOrThrow<string>('ADMIN_PASSWORD');
  }

  async login(dto: LoginDto): Promise<{ token: string; role?: string }> {
    const { email, password } = dto;

    if (email === this.adminUsername && password === this.adminPassword) {
      console.log('🔑 Admin login detected. Generating JWT...');
      // 生成真正的 JWT Token
      const payload = {
        username: this.adminUsername,
        sub: 'admin',
        role: 'admin',
      };
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
