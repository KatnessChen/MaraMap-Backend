import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class UpsertMountainDto {
  @ApiProperty({
    description: '中文山岳名稱（主鍵，須與貼文 metadata.mountain_name 一致）',
  })
  @IsString()
  @IsNotEmpty()
  zh: string;

  @ApiProperty({ description: '英文山岳名稱' })
  @IsString()
  @IsNotEmpty()
  en: string;
}
