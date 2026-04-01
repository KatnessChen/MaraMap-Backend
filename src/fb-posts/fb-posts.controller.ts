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
      req.isAdmin, // 傳入管理員權限標記
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
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('search') search?: string,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId);
    return this.fbPostsService.findLocations(
      targetUserId,
      category,
      startDate,
      endDate,
      search,
    );
  }

  @Public()
  @Get('categories')
  @ApiOperation({ summary: '取得分類統計' })
  async getCategories(@Query('user_id') userId?: string) {
    const targetUserId = this.getTargetUserId(userId);
    return this.fbPostsService.getCategories(targetUserId);
  }
}
