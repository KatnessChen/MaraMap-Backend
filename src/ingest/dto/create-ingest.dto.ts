import {
  IsString,
  IsNotEmpty,
  IsUrl,
  IsArray,
  IsOptional,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateIngestDto {
  @ApiProperty({
    description: 'Facebook Post ID — used for idempotency checks',
    example: 'story_fbid_1234567890',
  })
  @IsString()
  @IsNotEmpty()
  source_id: string;

  @ApiProperty({
    description: 'Original URL of the scraped Facebook post',
    example: 'https://www.facebook.com/permalink.php?story_fbid=1234567890',
  })
  @IsUrl()
  original_url: string;

  @ApiProperty({
    description: 'Raw text content extracted from the post',
    example: '今天去了淡水老街，推薦這家魚丸湯！',
  })
  @IsString()
  @IsNotEmpty()
  raw_text: string;

  @ApiPropertyOptional({
    description: 'Array of image URLs found in the post',
    type: [String],
    example: ['https://scontent-tpe1-1.xx.fbcdn.net/v/t1.0-9/photo.jpg'],
  })
  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  raw_images?: string[];
}
