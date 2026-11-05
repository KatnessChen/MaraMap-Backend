import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength } from 'class-validator';

export class ChatGuestLoginDto {
  @ApiProperty({ description: 'The numeric passcode for /chat', maxLength: 32 })
  @IsString()
  @Matches(/^\d+$/, { message: 'passcode should only contain digits' })
  @MaxLength(32)
  passcode: string;

  @ApiProperty({
    description: 'Shown to admins beside the questions',
    maxLength: 20,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  // Also rejects a blank name, and characters that could disguise the text.
  @Matches(/^[^\p{Cc}\p{Cf}]+$/u, { message: 'nickname is not valid' })
  @MaxLength(20)
  nickname: string;
}
