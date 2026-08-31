import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  IsObject,
  IsNotEmpty,
  IsDateString,
} from 'class-validator';

/**
 * 後台手動新增單篇文章的輸入。與 UpdateFbPostDto 不同，title / event_date /
 * category 為必填——手動建立的文章沒有 FB 匯入時的來源資料可回退。
 * media / fb_timestamp 由後端補上，不由前端提供。
 */
export class CreateFbPostDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ description: '活動日期 (YYYY-MM-DD)' })
  @IsDateString()
  event_date: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  category: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  sub_categories?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  is_hidden?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  is_personal_best?: boolean;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  cover_image?: string;

  @ApiPropertyOptional({
    description: '圖片/影片清單，元素為 { uri, type } 物件',
  })
  @IsArray()
  @IsOptional()
  media?: Array<{ uri: string; type: string }>;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}
