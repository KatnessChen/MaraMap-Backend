import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UpsertPostTranslationDto {
  @ApiPropertyOptional({ description: '英文標題（人工校對/覆寫）' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: '英文內文（人工校對/覆寫）' })
  @IsOptional()
  @IsString()
  content?: string;
}
