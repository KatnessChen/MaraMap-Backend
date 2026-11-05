import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { ChatGuest } from '../auth/auth.service';
import { ChatGuestGuard } from '../auth/guards/chat-guest.guard';
import { ChatService } from './chat.service';
import { ChatRequestDto } from './dto/chat-request.dto';

const MAX_SESSIONS_PER_PAGE = 100;

type GuestRequest = Request & { chatGuest: ChatGuest };

/** The /chat page: every call is limited to the guest's own conversations. */
@ApiTags('chat')
@ApiBearerAuth('chat-guest-token')
@Controller('chat')
@UseGuards(ChatGuestGuard)
export class ChatGuestController {
  constructor(private readonly chat: ChatService) {}

  @Post()
  // Tighter than admin: the passcode is shared, and each question costs money.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '問公開文章的內容，以串流回傳回答並保存對話' })
  async ask(
    @Body() dto: ChatRequestDto,
    @Req() req: GuestRequest,
    @Res() res: Response,
  ) {
    await this.chat.respond(dto, res, req.chatGuest);
  }

  @Get('sessions')
  @ApiOperation({ summary: '列出自己的對話，最近的在前' })
  listSessions(
    @Req() req: GuestRequest,
    @Query('limit', new DefaultValuePipe(30), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('archived', new DefaultValuePipe(false), ParseBoolPipe)
    archived: boolean,
  ) {
    return this.chat.listSessions(
      Math.min(Math.max(limit, 1), MAX_SESSIONS_PER_PAGE),
      Math.max(offset, 0),
      archived,
      req.chatGuest.id,
    );
  }

  @Get('sessions/:id')
  @ApiOperation({ summary: '讀取自己的一段對話' })
  getSession(@Req() req: GuestRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.getSession(id, req.chatGuest.id);
  }

  @Post('sessions/:id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '把對話的最新回答標為已讀' })
  markRead(@Req() req: GuestRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.markRead(id, req.chatGuest.id);
  }

  @Post('sessions/:id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '封存對話' })
  archive(@Req() req: GuestRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.archive(id, req.chatGuest.id);
  }

  @Post('sessions/:id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '把封存的對話還原' })
  restore(@Req() req: GuestRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.restore(id, req.chatGuest.id);
  }
}
