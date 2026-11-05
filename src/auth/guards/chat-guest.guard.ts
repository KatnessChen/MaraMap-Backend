import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../auth.service';

/** Lets a /chat token through and exposes its guest as `request.chatGuest`. */
@Injectable()
export class ChatGuestGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers.authorization;
    const guest = authHeader?.startsWith('Bearer ')
      ? await this.authService.verifyChatGuestToken(authHeader.split(' ')[1])
      : null;
    if (!guest) throw new UnauthorizedException('請重新輸入密碼。');
    request.chatGuest = guest;
    return true;
  }
}
