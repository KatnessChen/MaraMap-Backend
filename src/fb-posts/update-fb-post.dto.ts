import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  IsObject,
} from 'class-validator';

export class UpdateFbPostDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  event_date?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  is_hidden?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  is_pb?: boolean;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  trip_id?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional()
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  sub_categories?: string[];

  @ApiPropertyOptional()
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  cover_image?: string;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  metadata?: any;
}
