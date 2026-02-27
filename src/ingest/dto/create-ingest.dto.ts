import {
  IsString,
  IsNotEmpty,
  IsUrl,
  IsArray,
  IsOptional,
} from 'class-validator';

export class CreateIngestDto {
  @IsString()
  @IsNotEmpty()
  source_id: string;

  @IsUrl()
  original_url: string;

  @IsString()
  @IsNotEmpty()
  raw_text: string;

  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  raw_images?: string[];
}
