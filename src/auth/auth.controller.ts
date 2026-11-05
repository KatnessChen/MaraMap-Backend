import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { ChatGuestLoginDto } from './dto/chat-guest-login.dto';
import { LoginDto } from './dto/login.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  // Well below the global default — this is a credential-guessing target,
  // not a route real usage ever needs to retry quickly.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Login',
    description:
      'Authenticates a user and returns an access token valid for 24 hours. No refresh token is issued — the frontend re-prompts login on 401.',
  })
  @ApiResponse({
    status: 200,
    description: 'Login successful.',
    schema: { example: { token: '<supabase_access_token>' } },
  })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('chat-guest')
  @HttpCode(HttpStatus.OK)
  // A short numeric passcode is guessable, so attempts stay as slow as login.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Enter the /chat passcode',
    description:
      'Returns a token valid for 30 days that only works on the /chat API. Each entry starts a new guest.',
  })
  @ApiResponse({ status: 401, description: 'Wrong passcode.' })
  chatGuestLogin(@Body() dto: ChatGuestLoginDto) {
    return this.authService.loginChatGuest(dto.passcode, dto.nickname);
  }
}
