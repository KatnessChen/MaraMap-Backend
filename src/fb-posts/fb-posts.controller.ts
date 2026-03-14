import {
  Controller,
  Get,
  Query,
  Param,
  Patch,
  Body,
  Delete,
  BadRequestException,
} from '@nestjs/common';
import { FbPostsService } from './fb-posts.service';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { UpdateFbPostDto } from './update-fb-post.dto';

@ApiTags('fb-posts')
@Controller()
export class FbPostsController {
  constructor(private readonly fbPostsService: FbPostsService) {}

  private getTargetUserId(userId?: string): string {
    const target = userId || process.env.USER_ID;
    if (!target) {
      throw new BadRequestException(
        'USER_ID must be provided in query or environment',
      );
    }
    return target;
  }

  @Get('posts')
  @ApiOperation({ summary: 'Get paginated Facebook posts' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    description: 'Format: YYYY-MM-DD',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    description: 'Format: YYYY-MM-DD',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Keywords in content or title',
  })
  @ApiQuery({
    name: 'showHidden',
    required: false,
    type: Boolean,
    example: false,
  })
  async getPosts(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
    @Query('category') category?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('search') search?: string,
    @Query('showHidden') showHidden: string = 'false',
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
      showHidden === 'true',
    );
  }

  @Get('posts/:id')
  @ApiOperation({ summary: 'Get a single Facebook post by ID' })
  async getPostById(
    @Param('id') id: string,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId);
    return this.fbPostsService.findOne(targetUserId, id);
  }

  @Patch('posts/:id')
  @ApiOperation({ summary: 'Update post title, content, or visibility' })
  async updatePost(
    @Param('id') id: string,
    @Body() updateDto: UpdateFbPostDto,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = this.getTargetUserId(userId);
    return this.fbPostsService.update(targetUserId, id, updateDto);
  }

  @Delete('posts/:id')
  @ApiOperation({ summary: 'Delete a post by ID' })
  async deletePost(@Param('id') id: string, @Query('user_id') userId?: string) {
    const targetUserId = this.getTargetUserId(userId);
    return this.fbPostsService.remove(targetUserId, id);
  }

  @Get('locations')
  @ApiOperation({ summary: 'Get geotagged content for the map' })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    description: 'Format: YYYY-MM-DD',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    description: 'Format: YYYY-MM-DD',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Keywords',
  })
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

  @Get('categories')
  @ApiOperation({ summary: 'Get list of unique categories and their counts' })
  async getCategories(@Query('user_id') userId?: string) {
    const targetUserId = this.getTargetUserId(userId);
    return this.fbPostsService.getCategories(targetUserId);
  }
}
