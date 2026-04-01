import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from '../auth.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. 檢查是否標記為 @Public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    // 2. 如果有攜帶 Token，不論是否 Public 都要驗證並設定 isAdmin 標記
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const isValid = await this.authService.verifyAdminToken(token);
      if (isValid) {
        request.isAdmin = true;
      }
    }

    // 3. 如果是 Public 路由，直接放行
    if (isPublic) {
      return true;
    }

    // 4. 非 Public 路由且不是 Admin，則阻擋
    if (!request.isAdmin) {
      throw new UnauthorizedException('管理員權限驗證失敗，請重新登入。');
    }

    return true;
  }
}
