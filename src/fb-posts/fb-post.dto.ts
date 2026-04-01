import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsBoolean,
  IsNumber,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class ParticipantStatsDto {
  FM_count: number | null;
  HM_count: number | null;
  UM_count: number | null;
  distance_km: number | null;
}

export class MarathonParticipantDto {
  name: string;
  time: string | null;
  distance: string | null;
  stats: ParticipantStatsDto;
}

export class MarathonMetadataDto {
  race_name: string | null;
  country: string | null;
  city: string | null;
  trip_id: string | null;
  continent: string | null;
  mountains: string[];
  participants: MarathonParticipantDto[];
}

export class FbPostDto {
  id: string;
  user_id: string;
  fb_timestamp: number;
  event_date: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  is_hidden: boolean;
  is_overseas: boolean;
  continent: string;
  cover_image: string | null;
  metadata: MarathonMetadataDto | null;
  media: Array<{
    uri: string;
    type: 'photo' | 'video';
    lat: number | null;
    lng: number | null;
    taken_at: number;
  }>;
  created_at: string;
}

export class FuzzySearchDto {
  @ApiPropertyOptional({ description: 'Search keyword (matches title or content)' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: 'Filter by category' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: 'Filter by continent' })
  @IsOptional()
  @IsString()
  continent?: string;

  @ApiPropertyOptional({ description: 'Filter by overseas status' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  is_overseas?: boolean;

  @ApiPropertyOptional({ description: 'Limit number of results', default: 20 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Transform(({ value }) => parseInt(value))
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Offset results for pagination', default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) => parseInt(value))
  offset?: number = 0;
}
