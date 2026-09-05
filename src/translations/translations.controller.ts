import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TranslationsService } from './translations.service';
import { AdminGuard } from '../auth/guards/admin.guard';
import { Public } from '../auth/decorators/public.decorator';
import { UpsertRaceDto } from './dto/upsert-race.dto';
import { UpsertMountainDto } from './dto/upsert-mountain.dto';
import { UpsertPostTranslationDto } from './dto/upsert-post-translation.dto';
import type { RequestWithAdmin } from '../fb-posts/fb-posts.controller';

@ApiTags('translations')
@Controller()
@UseGuards(AdminGuard)
export class TranslationsController {
  constructor(private readonly translations: TranslationsService) {}

  private getTargetUserId(
    userId: string | undefined,
    isAdmin: boolean,
  ): string {
    const target = (isAdmin && userId) || process.env.USER_ID;
    if (!target) throw new BadRequestException('USER_ID must be provided');
    return target;
  }

  /**
   * The lazy cache-on-first-view trigger. Public (throttled, not gated by
   * admin) because it's called by the article page itself the first time an
   * English reader opens a post that has no cached translation yet — see
   * TranslationsService.triggerContentTranslation for the concurrency claim
   * that keeps two simultaneous requests from both paying for the same
   * Gemini call. The admin's "translate now" button on the edit page hits
   * this exact same endpoint.
   */
  @Public()
  @Post('posts/:id/translate')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: '觸發（或讀取）單篇文章的英文內文翻譯，具並發鎖與快取',
  })
  async triggerTranslation(
    @Req() req: RequestWithAdmin,
    @Param('id') id: string,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId, !!req.isAdmin);
    return this.translations.triggerContentTranslation(targetUserId, id);
  }

  /** Bulk content_status map, keyed by post id — the frontend's sitemap
   *  generator uses this to decide which /en/log/[id] URLs to include. */
  @Public()
  @Get('translations/content-status')
  @ApiOperation({ summary: '取得所有文章的英文內文翻譯狀態（sitemap 用）' })
  getContentStatusMap() {
    return this.translations.getContentStatusMap();
  }

  @Patch('posts/:id/translations/en')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '人工校對/覆寫英文標題與內文（僅限管理員）' })
  async upsertHumanTranslation(
    @Param('id') id: string,
    @Body() dto: UpsertPostTranslationDto,
  ) {
    await this.translations.upsertHumanTranslation(id, dto.title, dto.content);
    return { success: true };
  }

  /** Wipes cached content (not title) translations for every post so they
   *  regenerate under the current translation pipeline — e.g. after a
   *  prompt/chunking change makes old cached translations stale. */
  @Post('admin/translations/content/reset')
  @ApiBearerAuth('admin-token')
  @ApiOperation({
    summary: '清除所有文章的英文內文翻譯快取（不含標題），供重新產生用',
  })
  async resetContentTranslations(@Query('force') force?: string) {
    const { count } = await this.translations.resetAllContentTranslations(
      force === 'true',
    );
    return { success: true, count };
  }

  @Post('admin/translations/titles/backfill')
  @ApiBearerAuth('admin-token')
  @ApiOperation({
    summary: '批次翻譯所有尚未有英文標題的文章（一次性/補漏用）',
  })
  async backfillTitles(
    @Query('user_id') userId?: string,
    @Query('limit') limit?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId, true);
    const count = await this.translations.translateMissingTitles(
      targetUserId,
      limit ? Number(limit) : undefined,
    );
    return { translated: count };
  }

  @Get('admin/translations/races')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '列出賽事名稱中英對照（可篩選待審核）' })
  listRaces(@Query('needsReview') needsReview?: string) {
    return this.translations.listRaces(needsReview === 'true');
  }

  @Post('admin/translations/races')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '新增或校正一筆賽事名稱對照' })
  upsertRace(@Body() dto: UpsertRaceDto) {
    return this.translations.upsertRace(dto.zh, dto.en);
  }

  @Delete('admin/translations/races')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '刪除一筆賽事名稱對照' })
  deleteRace(@Query('zh') zh: string) {
    if (!zh) throw new BadRequestException('zh is required');
    return this.translations.deleteRace(zh);
  }

  @Get('admin/translations/mountains')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '列出山岳名稱中英對照（可篩選待審核）' })
  listMountains(@Query('needsReview') needsReview?: string) {
    return this.translations.listMountains(needsReview === 'true');
  }

  @Post('admin/translations/mountains')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '新增或校正一筆山岳名稱對照' })
  upsertMountain(@Body() dto: UpsertMountainDto) {
    return this.translations.upsertMountain(dto.zh, dto.en);
  }

  @Delete('admin/translations/mountains')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '刪除一筆山岳名稱對照' })
  deleteMountain(@Query('zh') zh: string) {
    if (!zh) throw new BadRequestException('zh is required');
    return this.translations.deleteMountain(zh);
  }
}
