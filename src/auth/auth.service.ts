import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { LoginDto } from './dto/login.dto';
import { JwtService } from '@nestjs/jwt';

const CHAT_GUEST_ROLE = 'chat_guest';

export interface ChatGuest {
  id: string;
  nickname: string;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

@Injectable()
export class AuthService {
  private client: SupabaseClient;
  private readonly adminUsername: string;
  private readonly adminPassword: string;
  // Optional: without it nobody can enter /chat, and the rest still runs.
  private readonly chatPasscode?: string;

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
    this.chatPasscode = this.configService.get<string>('CHAT_CREDENTIALS');
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

  async loginChatGuest(
    passcode: string,
    nickname: string,
  ): Promise<{ token: string; nickname: string }> {
    if (
      !this.chatPasscode ||
      !timingSafeEqual(sha256(passcode), sha256(this.chatPasscode))
    ) {
      throw new UnauthorizedException('密碼不正確');
    }
    return {
      token: this.jwtService.sign(
        {
          sub: randomUUID(),
          nickname,
          role: CHAT_GUEST_ROLE,
          pv: this.chatPasscodeVersion(),
        },
        { expiresIn: '30d' },
      ),
      nickname,
    };
  }

  /** The token's guest, or null. Changing the passcode signs every guest out. */
  async verifyChatGuestToken(token: string): Promise<ChatGuest | null> {
    if (!this.chatPasscode) return null;
    try {
      const payload = await this.jwtService.verifyAsync(token);
      return payload.role === CHAT_GUEST_ROLE &&
        payload.pv === this.chatPasscodeVersion()
        ? { id: payload.sub, nickname: payload.nickname }
        : null;
    } catch {
      return null;
    }
  }

  private chatPasscodeVersion(): string {
    return createHmac(
      'sha256',
      this.configService.getOrThrow<string>('JWT_SECRET'),
    )
      .update(this.chatPasscode as string)
      .digest('hex')
      .slice(0, 16);
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
