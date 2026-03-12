import { Controller, Get, Query, UseGuards, Req } from '@nestjs/common';
import { FbPostsService } from './fb-posts.service';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';

@ApiTags('fb-posts')
@Controller()
export class FbPostsController {
  constructor(private readonly fbPostsService: FbPostsService) {}

  @Get('posts')
  @ApiOperation({ summary: 'Get paginated Facebook posts' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'startDate', required: false, type: String, description: 'Format: YYYY-MM-DD' })
  @ApiQuery({ name: 'endDate', required: false, type: String, description: 'Format: YYYY-MM-DD' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Keywords in content or title' })
  async getPosts(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
    @Query('category') category?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('search') search?: string,
    @Query('user_id') userId?: string, 
  ) {
    const targetUserId = userId || process.env.USER_ID; 
    return this.fbPostsService.findAll(
      targetUserId, 
      page, 
      limit, 
      category, 
      startDate, 
      endDate, 
      search
    );
  }

  @Get('locations')
  @ApiOperation({ summary: 'Get geotagged content for the map' })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'startDate', required: false, type: String, description: 'Format: YYYY-MM-DD' })
  @ApiQuery({ name: 'endDate', required: false, type: String, description: 'Format: YYYY-MM-DD' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Keywords' })
  async getLocations(
    @Query('category') category?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('search') search?: string,
    @Query('user_id') userId?: string,
  ) {
    const targetUserId = userId || process.env.USER_ID;
    return this.fbPostsService.findLocations(
      targetUserId,
      category,
      startDate,
      endDate,
      search
    );
  }

  @Get('categories')
  @ApiOperation({ summary: 'Get list of unique categories and their counts' })
  async getCategories(@Query('user_id') userId?: string) {
    const targetUserId = userId || process.env.USER_ID;
    return this.fbPostsService.getCategories(targetUserId);
  }
}
