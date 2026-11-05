import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class ChatRequestDto {
  @ApiPropertyOptional({ description: 'Omit to start a new conversation' })
  @IsOptional()
  @IsUUID()
  sessionId?: string;

  @ApiProperty({ description: 'The question to ask', maxLength: 1000 })
  @IsString()
  @Matches(/\S/, { message: 'question should not be empty' })
  @MaxLength(1000)
  question: string;
}
