import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateUploadUrlDto {
  @ApiProperty({
    description: '要上傳的檔案 MIME 類型，例如 video/mp4、image/jpeg',
    example: 'video/mp4',
  })
  @IsString()
  @IsNotEmpty()
  contentType: string;
}
