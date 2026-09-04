import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class UpsertRaceDto {
  @ApiProperty({
    description: '中文賽事名稱（主鍵，須與貼文 metadata.race_name 一致）',
  })
  @IsString()
  @IsNotEmpty()
  zh: string;

  @ApiProperty({ description: '英文賽事名稱' })
  @IsString()
  @IsNotEmpty()
  en: string;
}
