import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../auth/guards/admin.guard';
import { LocationTranslationsService } from './location-translations.service';
import { UpsertCountryDto } from './dto/upsert-country.dto';
import { UpsertCityDto } from './dto/upsert-city.dto';

@ApiTags('admin')
@Controller('admin/location-translations')
@UseGuards(AdminGuard)
export class LocationTranslationsController {
  constructor(private readonly service: LocationTranslationsService) {}

  @Get('countries')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '列出所有國家中英文對照' })
  listCountries() {
    return this.service.listCountries();
  }

  // Create-only — no update, no delete. `en` is also the choropleth match
  // key against public/countries.geojson (MapView.tsx), so existing rows are
  // frozen; see the long comment on LocationTranslationsService.upsertCountry.
  @Post('countries')
  @ApiBearerAuth('admin-token')
  @ApiOperation({
    summary: '新增一筆國家中英文對照（已存在的國家不可編輯或刪除）',
  })
  upsertCountry(@Body() dto: UpsertCountryDto) {
    return this.service.upsertCountry(dto.zh, dto.en);
  }

  @Get('cities')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '列出城市中英文對照，可用 country 篩選單一國家' })
  listCities(@Query('country') country?: string) {
    return this.service.listCities(country);
  }

  @Post('cities')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '新增或更新一筆城市中英文對照' })
  upsertCity(@Body() dto: UpsertCityDto) {
    return this.service.upsertCity(dto.countryZh, dto.zh, dto.en);
  }

  @Delete('cities')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '刪除一筆城市對照' })
  deleteCity(@Query('country') country: string, @Query('zh') zh: string) {
    return this.service.deleteCity(country, zh);
  }

  @Get('cities/missing')
  @ApiBearerAuth('admin-token')
  @ApiOperation({
    summary: '找出文章中實際用到、但尚未有英文對照的城市（依出現次數排序）',
  })
  findMissingCities() {
    return this.service.findMissingCities();
  }

  @Post('cities/resolve-missing')
  @ApiBearerAuth('admin-token')
  @ApiOperation({
    summary: '批次用 AI 補上缺漏城市的英文名稱（標記為待審核）',
  })
  resolveMissingCities() {
    return this.service.resolveMissingCities();
  }
}
