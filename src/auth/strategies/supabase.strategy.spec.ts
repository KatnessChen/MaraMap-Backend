import { ConfigService } from '@nestjs/config';
import { SupabaseStrategy, JwtPayload } from './supabase.strategy';

// Mock jwks-rsa so the constructor doesn't make real network calls
jest.mock('jwks-rsa', () => ({
  passportJwtSecret: jest.fn().mockReturnValue(jest.fn()),
}));

const mockConfigService = {
  getOrThrow: () => 'https://test-project.supabase.co',
} as unknown as ConfigService;

describe('SupabaseStrategy', () => {
  let strategy: SupabaseStrategy;

  beforeEach(() => {
    strategy = new SupabaseStrategy(mockConfigService);
  });

  it('should be defined', () => {
    expect(strategy).toBeDefined();
  });

  it('should return an AuthUser from a valid JWT payload', () => {
    const payload: JwtPayload = {
      sub: 'user-uuid-123',
      email: 'test@example.com',
    };

    const result = strategy.validate(payload);

    expect(result).toEqual({
      userId: 'user-uuid-123',
      email: 'test@example.com',
    });
  });

  it('should map sub claim to userId', () => {
    const payload: JwtPayload = {
      sub: 'another-uuid',
      email: 'another@example.com',
    };

    const result = strategy.validate(payload);

    expect(result.userId).toBe('another-uuid');
  });
});
