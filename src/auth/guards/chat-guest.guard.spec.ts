import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth.service';
import { ChatGuestGuard } from './chat-guest.guard';

describe('ChatGuestGuard', () => {
  const verifyChatGuestToken = jest.fn();
  const guard = new ChatGuestGuard({
    verifyChatGuestToken,
  } as unknown as AuthService);
  const contextFor = (request: object) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;

  beforeEach(() => jest.clearAllMocks());

  it('exposes the guest of a valid token', async () => {
    const guest = { id: 'guest-1', nickname: '小明' };
    verifyChatGuestToken.mockResolvedValue(guest);
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer good' },
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(verifyChatGuestToken).toHaveBeenCalledWith('good');
    expect(request.chatGuest).toEqual(guest);
  });

  it('blocks a missing or invalid token', async () => {
    verifyChatGuestToken.mockResolvedValue(null);

    await expect(
      guard.canActivate(contextFor({ headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: 'Bearer bad' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
