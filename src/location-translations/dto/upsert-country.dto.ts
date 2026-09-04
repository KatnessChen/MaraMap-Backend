import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class UpsertCountryDto {
  @ApiProperty({
    description: '中文國名（主鍵，須與貼文 metadata.country 一致）',
  })
  @IsString()
  @IsNotEmpty()
  zh: string;

  @ApiProperty({ description: '英文國名' })
  @IsString()
  @IsNotEmpty()
  en: string;
}
