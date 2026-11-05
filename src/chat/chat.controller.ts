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
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AdminGuard } from '../auth/guards/admin.guard';
import { ChatService } from './chat.service';
import { ChatRequestDto } from './dto/chat-request.dto';

const MAX_SESSIONS_PER_PAGE = 100;

@ApiTags('admin')
@Controller('admin/chat')
@UseGuards(AdminGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post()
  // Every question costs money and can make several model calls.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '問文章內容，以串流回傳回答並保存對話' })
  async ask(@Body() dto: ChatRequestDto, @Res() res: Response) {
    await this.chat.respond(dto, res);
  }

  @Get('sessions')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '列出對話，最近的在前' })
  listSessions(
    @Query('limit', new DefaultValuePipe(30), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('archived', new DefaultValuePipe(false), ParseBoolPipe)
    archived: boolean,
  ) {
    return this.chat.listSessions(
      Math.min(Math.max(limit, 1), MAX_SESSIONS_PER_PAGE),
      Math.max(offset, 0),
      archived,
    );
  }

  @Get('guest-sessions')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '列出訪客的對話，最近的在前' })
  listGuestSessions(
    @Query('limit', new DefaultValuePipe(30), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.chat.listGuestSessions(
      Math.min(Math.max(limit, 1), MAX_SESSIONS_PER_PAGE),
      Math.max(offset, 0),
    );
  }

  @Get('guest-sessions/:id')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '讀取訪客的一段對話' })
  getGuestSession(@Param('id', ParseUUIDPipe) id: string) {
    return this.chat.getGuestSession(id);
  }

  @Get('sessions/:id')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '讀取一段對話的完整訊息' })
  getSession(@Param('id', ParseUUIDPipe) id: string) {
    return this.chat.getSession(id);
  }

  @Post('sessions/:id/read')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '把對話的最新回答標為已讀' })
  markRead(@Param('id', ParseUUIDPipe) id: string) {
    return this.chat.markRead(id);
  }

  @Post('sessions/:id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '封存對話（soft delete）' })
  archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.chat.archive(id);
  }

  @Post('sessions/:id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '把封存的對話還原' })
  restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.chat.restore(id);
  }
}
