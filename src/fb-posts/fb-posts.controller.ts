import {
  Controller,
  Get,
  Query,
  Param,
  Patch,
  Body,
  Delete,
  BadRequestException,
  UseGuards,
  Req,
} from '@nestjs/common';
import { FbPostsService } from './fb-posts.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UpdateFbPostDto } from './update-fb-post.dto';
import { FuzzySearchDto } from './fb-post.dto';
import { AdminGuard } from '../auth/guards/admin.guard';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('fb-posts')
@Controller()
@UseGuards(AdminGuard)
export class FbPostsController {
  constructor(private readonly fbPostsService: FbPostsService) {}

  private getTargetUserId(userId?: string): string {
    const target = userId || process.env.USER_ID;
    if (!target) {
      throw new BadRequestException('USER_ID must be provided');
    }
    return target;
  }

  @Public()
  @Get('posts')
  @ApiOperation({ summary: '取得文章列表 (公開/管理共用)' })
  async getPosts(
    @Req() req: any,
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
    const targetUserId = this.getTargetUserId(userId);
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
    @Query() queryDto: FuzzySearchDto,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId);
    return this.fbPostsService.fuzzySearch(targetUserId, queryDto);
  }

  @Public()
  @Get('personal-best')
  @ApiOperation({ summary: '取得個人最佳成績（各距離 + 時間線）' })
  async getPersonalBest(@Query('user_id') userId?: string) {
    const targetUserId = this.getTargetUserId(userId);
    return this.fbPostsService.findPersonalBests(targetUserId);
  }

  @Public()
  @Get('posts/:id')
  @ApiOperation({ summary: '取得單篇文章詳情' })
  async getPostById(
    @Req() req: any,
    @Param('id') id: string,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId);
    return this.fbPostsService.findOne(targetUserId, id, req.isAdmin);
  }

  @Patch('posts/:id')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '編輯文章 (僅限管理員)' })
  async updatePost(
    @Param('id') id: string,
    @Body() updateDto: UpdateFbPostDto,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId);
    return this.fbPostsService.update(targetUserId, id, updateDto);
  }

  @Delete('posts/:id')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '刪除文章 (僅限管理員)' })
  async deletePost(@Param('id') id: string, @Query('user_id') userId?: string) {
    const targetUserId = this.getTargetUserId(userId);
    return this.fbPostsService.remove(targetUserId, id);
  }

  @Public()
  @Get('locations')
  @ApiOperation({ summary: '取得地圖點位' })
  async getLocations(
    @Query('category') category?: string,
    @Query('sub_category') subCategory?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('search') search?: string,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId);
    return this.fbPostsService.findLocations(
      targetUserId,
      category,
      subCategory,
      startDate,
      endDate,
      search,
    );
  }

  @Public()
  @Get('posts/trip/:tripId')
  @ApiOperation({ summary: '取得同一趟旅行的所有貼文' })
  async getTripPosts(
    @Param('tripId') tripId: string,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId);
    return this.fbPostsService.findByTripId(targetUserId, tripId);
  }

  @Public()
  @Get('locations/by-country')
  @ApiOperation({ summary: '取得特定國家的所有賽事' })
  async getByCountry(
    @Query('country') country: string,
    @Query('user_id') userId?: string,
  ) {
    if (!country) throw new BadRequestException('country is required');
    const targetUserId = this.getTargetUserId(userId);
    return this.fbPostsService.findByCountry(targetUserId, country);
  }

  @Public()
  @Get('categories')
  @ApiOperation({ summary: '取得分類統計' })
  async getCategories(@Query('user_id') userId?: string) {
    const targetUserId = this.getTargetUserId(userId);
    return this.fbPostsService.getCategories(targetUserId);
  }
}
