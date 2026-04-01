import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

// Mock @supabase/supabase-js before importing AuthService
const mockSignIn = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: {
      signInWithPassword: mockSignIn,
    },
  })),
}));

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(() => {
    // Clear mocks
    jest.clearAllMocks();

    const configService = {
      getOrThrow: jest.fn((key: string) => {
        const config: Record<string, string> = {
          SUPABASE_URL: 'https://test.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'test-key',
        };
        return config[key];
      }),
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;

    const jwtService = {
      sign: jest.fn(() => 'mock-jwt-token'),
      verifyAsync: jest.fn(),
    } as unknown as JwtService;

    service = new AuthService(configService, jwtService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('login', () => {
    it('should return token on successful Supabase login', async () => {
      const loginDto: LoginDto = {
        email: 'test@example.com',
        password: 'password123',
      };

      mockSignIn.mockResolvedValueOnce({
        data: { session: { access_token: 'test-token' } },
        error: null,
      });

      const result = await service.login(loginDto);

      expect(result).toEqual({ token: 'test-token' });
      expect(mockSignIn).toHaveBeenCalledWith({
        email: 'test@example.com',
        password: 'password123',
      });
    });

    it('should return JWT token and admin role for admin credentials', async () => {
      const loginDto: LoginDto = {
        email: 'admin',
        password: '81986369',
      };

      const result = await service.login(loginDto);

      expect(result).toEqual({ token: 'mock-jwt-token', role: 'admin' });
      expect(mockSignIn).not.toHaveBeenCalled();
    });

    it('should throw UnauthorizedException on login failure', async () => {
      const loginDto: LoginDto = {
        email: 'test@example.com',
        password: 'wrongpass',
      };

      mockSignIn.mockResolvedValueOnce({
        data: { session: null },
        error: { message: 'Invalid credentials' },
      });

      await expect(service.login(loginDto)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
