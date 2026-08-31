import {
  Controller,
  Get,
  Post,
  Query,
  Param,
  Patch,
  Body,
  Delete,
  BadRequestException,
  UseGuards,
  Req,
  Header,
} from '@nestjs/common';
import type { Request } from 'express';
import { FbPostsService } from './fb-posts.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UpdateFbPostDto } from './update-fb-post.dto';
import { CreateFbPostDto } from './create-fb-post.dto';
import { CreateUploadUrlDto } from './create-upload-url.dto';
import { FuzzySearchDto } from './fb-post.dto';
import { AdminGuard } from '../auth/guards/admin.guard';
import { Public } from '../auth/decorators/public.decorator';

// AdminGuard stamps `isAdmin` onto the request when a valid admin JWT was
// presented — see admin.guard.ts. Express's own Request type has no field
// for it.
export interface RequestWithAdmin extends Request {
  isAdmin?: boolean;
}

@ApiTags('fb-posts')
@Controller()
@UseGuards(AdminGuard)
export class FbPostsController {
  constructor(private readonly fbPostsService: FbPostsService) {}

  /**
   * `?user_id=` only overrides the site's default USER_ID for an
   * authenticated admin — an anonymous caller on a `@Public()` route passing
   * their own `user_id` must not be able to read someone else's data. Routes
   * without `@Public()` are already gated by AdminGuard before the handler
   * runs, so they pass `isAdmin: true` literally rather than threading `req`
   * through just to read a value AdminGuard already guaranteed.
   */
  private getTargetUserId(
    userId: string | undefined,
    isAdmin: boolean,
  ): string {
    const target = (isAdmin && userId) || process.env.USER_ID;
    if (!target) {
      throw new BadRequestException('USER_ID must be provided');
    }
    return target;
  }

  @Public()
  @Get('posts')
  @ApiOperation({ summary: '取得文章列表 (公開/管理共用)' })
  async getPosts(
    @Req() req: RequestWithAdmin,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
    @Query('category') category?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('search') search?: string,
    @Query('status') status: 'all' | 'visible' | 'hidden' = 'visible',
    @Query('order') order: 'asc' | 'desc' = 'desc',
    @Query('tag') tag?: string,
    @Query('user_id') userId?: string,
    @Query('sub_category') subCategory?: string,
    @Query('continent') continent?: string,
    @Query('country') country?: string,
    @Query('city') city?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId, req.isAdmin);
    return this.fbPostsService.findAll(
      targetUserId,
      page,
      limit,
      category,
      startDate,
      endDate,
      search,
      status,
      order,
      tag,
      req.isAdmin,
      subCategory,
      continent,
      country,
      city,
    );
  }

  @Public()
  @Get('posts/search')
  @ApiOperation({ summary: '模糊搜尋文章' })
  async searchPosts(
    @Req() req: RequestWithAdmin,
    @Query() queryDto: FuzzySearchDto,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId, req.isAdmin);
    return this.fbPostsService.fuzzySearch(targetUserId, queryDto, req.isAdmin);
  }

  @Public()
  @Get('personal-best')
  @ApiOperation({ summary: '取得個人最佳成績（各距離 + 時間線）' })
  async getPersonalBest(
    @Req() req: RequestWithAdmin,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId, req.isAdmin);
    return this.fbPostsService.findPersonalBests(targetUserId);
  }

  // Admin-only (no @Public): drop the PB cache and recompute now.
  @Post('personal-best/recompute')
  @ApiOperation({ summary: '重新計算個人最佳成績（管理員）' })
  async recomputePersonalBest(@Query('user_id') userId?: string) {
    const targetUserId = this.getTargetUserId(userId, true);
    await this.fbPostsService.recomputePersonalBests(targetUserId);
    return { success: true };
  }

  @Public()
  @Get('posts/:id')
  @ApiOperation({ summary: '取得單篇文章詳情' })
  async getPostById(
    @Req() req: RequestWithAdmin,
    @Param('id') id: string,
    @Query('user_id') userId?: string,
    @Query('preview') preview?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId, req.isAdmin);
    const canPreview = preview === 'true';
    return this.fbPostsService.findOne(
      targetUserId,
      id,
      req.isAdmin || canPreview,
    );
  }

  @Post('posts/upload-url')
  @ApiBearerAuth('admin-token')
  @ApiOperation({
    summary:
      '產生 presigned URL 讓瀏覽器把圖片/影片直接上傳至 R2，繞過 Cloud Run 32MB 請求上限 (僅限管理員)',
  })
  async createPostUploadUrl(
    @Body() dto: CreateUploadUrlDto,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId, true);
    return this.fbPostsService.createUploadUrl(targetUserId, dto.contentType);
  }

  @Post('posts')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '新增單篇文章 (僅限管理員)' })
  async createPost(
    @Body() createDto: CreateFbPostDto,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId, true);
    return this.fbPostsService.create(targetUserId, createDto);
  }

  @Patch('posts/:id')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '編輯文章 (僅限管理員)' })
  async updatePost(
    @Param('id') id: string,
    @Body() updateDto: UpdateFbPostDto,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId, true);
    return this.fbPostsService.update(targetUserId, id, updateDto);
  }

  @Delete('posts/:id')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '刪除文章 (僅限管理員)' })
  async deletePost(@Param('id') id: string, @Query('user_id') userId?: string) {
    const targetUserId = this.getTargetUserId(userId, true);
    return this.fbPostsService.remove(targetUserId, id);
  }

  @Public()
  @Get('locations')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  @ApiOperation({ summary: '取得地圖點位' })
  async getLocations(
    @Req() req: RequestWithAdmin,
    @Query('category') category?: string,
    @Query('sub_category') subCategory?: string,
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
    @Query('search') search?: string,
    @Query('user_id') userId?: string,
    @Query('geoOnly') geoOnly?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId, req.isAdmin);
    return this.fbPostsService.findLocations(
      targetUserId,
      category,
      subCategory,
      startDate,
      endDate,
      search,
      geoOnly !== 'false',
    );
  }

  @Public()
  @Get('posts/trip/:tripId')
  @ApiOperation({ summary: '取得同一趟旅行的所有貼文' })
  async getTripPosts(
    @Req() req: RequestWithAdmin,
    @Param('tripId') tripId: string,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId, req.isAdmin);
    return this.fbPostsService.findByTripId(targetUserId, tripId);
  }

  @Get('posts/:id/trip-suggestions')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '智慧推薦同行文章 (僅限管理員)' })
  async getTripSuggestions(
    @Param('id') id: string,
    @Query('windowDays') windowDays?: string,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId, true);
    return this.fbPostsService.getTripSuggestions(
      targetUserId,
      id,
      windowDays ? Number(windowDays) : undefined,
    );
  }

  @Post('posts/:id/trip/add')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '加入同行文章 (僅限管理員)' })
  async addToTrip(
    @Param('id') id: string,
    @Body('postId') postId: string,
    @Query('user_id') userId?: string,
  ) {
    if (!postId) throw new BadRequestException('postId is required');
    const targetUserId = this.getTargetUserId(userId, true);
    return this.fbPostsService.addToTrip(targetUserId, id, postId);
  }

  @Post('posts/:id/trip/remove')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '移出行程 (僅限管理員)' })
  async removeFromTrip(
    @Param('id') id: string,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId, true);
    return this.fbPostsService.removeFromTrip(targetUserId, id);
  }

  @Post('posts/:id/make-primary')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '設為行程主文 (僅限管理員)' })
  async makePrimary(
    @Param('id') id: string,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId, true);
    return this.fbPostsService.makePrimary(targetUserId, id);
  }

  @Public()
  @Get('locations/by-country')
  @ApiOperation({ summary: '取得特定國家的所有賽事' })
  async getByCountry(
    @Req() req: RequestWithAdmin,
    @Query('country') country: string,
    @Query('user_id') userId?: string,
  ) {
    if (!country) throw new BadRequestException('country is required');
    const targetUserId = this.getTargetUserId(userId, req.isAdmin);
    return this.fbPostsService.findByCountry(targetUserId, country);
  }

  @Public()
  @Get('categories')
  @ApiOperation({ summary: '取得分類統計' })
  async getCategories(
    @Req() req: RequestWithAdmin,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId, req.isAdmin);
    return this.fbPostsService.getCategories(targetUserId);
  }

  @Get('geocode')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '依國家/城市查詢經緯度（管理員專用）' })
  async geocode(
    @Query('country') country?: string,
    @Query('city') city?: string,
  ) {
    if (!country && !city) {
      throw new BadRequestException('country or city is required');
    }
    return this.fbPostsService.geocodeLocation(country, city);
  }
}
