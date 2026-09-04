import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class UpsertCityDto {
  @ApiProperty({
    description: '所屬國家的中文名稱（須已存在於 country_translations）',
  })
  @IsString()
  @IsNotEmpty()
  countryZh: string;

  @ApiProperty({ description: '中文城市名' })
  @IsString()
  @IsNotEmpty()
  zh: string;

  @ApiProperty({ description: '英文城市名' })
  @IsString()
  @IsNotEmpty()
  en: string;
}
