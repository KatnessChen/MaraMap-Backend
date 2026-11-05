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
  let jwtService: { sign: jest.Mock; verifyAsync: jest.Mock };

  beforeEach(() => {
    // Clear mocks
    jest.clearAllMocks();

    const configService = {
      getOrThrow: jest.fn((key: string) => {
        const config: Record<string, string> = {
          SUPABASE_URL: 'https://test.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'test-key',
          ADMIN_USERNAME: 'test-admin',
          ADMIN_PASSWORD: 'test-admin-password',
        };
        return config[key];
      }),
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;

    jwtService = {
      sign: jest.fn(() => 'mock-jwt-token'),
      verifyAsync: jest.fn(),
    };

    service = new AuthService(
      configService,
      jwtService as unknown as JwtService,
    );
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
        email: 'test-admin',
        password: 'test-admin-password',
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

  describe('verifyAdminToken', () => {
    it('should return true for a valid admin token', async () => {
      jwtService.verifyAsync.mockResolvedValueOnce({ role: 'admin' });

      const result = await service.verifyAdminToken('valid-token');
      expect(result).toBe(true);
    });

    it('should return false for a non-admin token', async () => {
      jwtService.verifyAsync.mockResolvedValueOnce({ role: 'user' });

      const result = await service.verifyAdminToken('user-token');
      expect(result).toBe(false);
    });

    it('should return false when token verification throws', async () => {
      jwtService.verifyAsync.mockRejectedValueOnce(new Error('invalid token'));

      const result = await service.verifyAdminToken('bad-token');
      expect(result).toBe(false);
    });
  });

  describe('chat guests', () => {
    const makeService = (passcode?: string) =>
      new AuthService(
        {
          getOrThrow: jest.fn((key: string) => `test-${key}`),
          get: jest.fn(() => passcode),
        } as unknown as ConfigService,
        jwtService as unknown as JwtService,
      );

    it('gives the right passcode a 30-day token that is not an admin one', async () => {
      const guests = makeService('test-passcode');

      await expect(
        guests.loginChatGuest('test-passcode', '小明'),
      ).resolves.toEqual({
        token: 'mock-jwt-token',
        nickname: '小明',
      });

      const [payload, options] = jwtService.sign.mock.calls[0];
      expect(payload.role).toBe('chat_guest');
      expect(payload.nickname).toBe('小明');
      expect(payload.sub).toEqual(expect.any(String));
      expect(options).toEqual({ expiresIn: '30d' });
    });

    it('rejects a wrong passcode', async () => {
      await expect(
        makeService('test-passcode').loginChatGuest('wrong-passcode', '小明'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('lets nobody in when no passcode is configured', async () => {
      const guests = makeService(undefined);

      await expect(
        guests.loginChatGuest('test-passcode', '小明'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(guests.verifyChatGuestToken('any')).resolves.toBeNull();
    });

    it('accepts its own token and signs guests out when the passcode changes', async () => {
      await makeService('test-passcode').loginChatGuest(
        'test-passcode',
        '小明',
      );
      const [payload] = jwtService.sign.mock.calls[0];
      jwtService.verifyAsync.mockResolvedValue(payload);

      await expect(
        makeService('test-passcode').verifyChatGuestToken('token'),
      ).resolves.toEqual({ id: payload.sub, nickname: '小明' });
      await expect(
        makeService('changed-passcode').verifyChatGuestToken('token'),
      ).resolves.toBeNull();
    });

    it('does not treat an admin token as a guest, or a guest token as admin', async () => {
      const guests = makeService('test-passcode');

      jwtService.verifyAsync.mockResolvedValue({ sub: 'admin', role: 'admin' });
      await expect(guests.verifyChatGuestToken('token')).resolves.toBeNull();

      await guests.loginChatGuest('test-passcode', '小明');
      jwtService.verifyAsync.mockResolvedValue(
        jwtService.sign.mock.calls[0][0],
      );
      await expect(guests.verifyAdminToken('token')).resolves.toBe(false);
    });
  });
});
