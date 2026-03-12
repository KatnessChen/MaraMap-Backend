import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

    // Create service with mocked config
    const configService = {
      getOrThrow: jest.fn((key: string) => {
        const config: Record<string, string> = {
          SUPABASE_URL: 'https://test.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'test-key',
        };
        return config[key];
      }),
    } as unknown as ConfigService;

    service = new AuthService(configService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('login', () => {
    it('should return token on successful login', async () => {
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


