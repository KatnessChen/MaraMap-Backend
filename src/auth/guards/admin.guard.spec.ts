import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminGuard } from './admin.guard';
import { AuthService } from '../auth.service';

const mockAuthService = {
  verifyAdminToken: jest.fn(),
};

const mockReflector = {
  getAllAndOverride: jest.fn(),
};

function createMockContext(
  authHeader?: string,
  isPublic = false,
): ExecutionContext {
  mockReflector.getAllAndOverride.mockReturnValue(isPublic);
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: jest.fn().mockReturnValue({
      getRequest: jest.fn().mockReturnValue({
        headers: { authorization: authHeader },
        isAdmin: false,
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  let guard: AdminGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new AdminGuard(
      mockAuthService as unknown as AuthService,
      mockReflector as unknown as Reflector,
    );
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  it('should allow public routes without a token', async () => {
    const context = createMockContext(undefined, true);
    const result = await guard.canActivate(context);
    expect(result).toBe(true);
    expect(mockAuthService.verifyAdminToken).not.toHaveBeenCalled();
  });

  it('should set isAdmin and allow public route when valid token provided', async () => {
    mockAuthService.verifyAdminToken.mockResolvedValueOnce(true);
    const context = createMockContext('Bearer valid-token', true);
    const result = await guard.canActivate(context);
    expect(mockAuthService.verifyAdminToken).toHaveBeenCalledWith(
      'valid-token',
    );
    expect(result).toBe(true);
  });

  it('should allow access and set isAdmin for valid admin token on protected route', async () => {
    mockAuthService.verifyAdminToken.mockResolvedValueOnce(true);
    const context = createMockContext('Bearer valid-token', false);
    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('should throw UnauthorizedException for protected route with no token', async () => {
    const context = createMockContext(undefined, false);
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should throw UnauthorizedException for protected route with invalid token', async () => {
    mockAuthService.verifyAdminToken.mockResolvedValueOnce(false);
    const context = createMockContext('Bearer bad-token', false);
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
