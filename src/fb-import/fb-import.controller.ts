import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import * as os from 'os';
import * as crypto from 'crypto';
import { AdminGuard } from '../auth/guards/admin.guard';
import { FbImportService } from './fb-import.service';
import { RescuedPost } from './pipeline-events';

const BATCH_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

const fbImportMulterOptions = {
  storage: diskStorage({
    destination: os.tmpdir(),
    filename: (
      _req: unknown,
      _file: Express.Multer.File,
      cb: (err: Error | null, filename: string) => void,
    ) =>
      cb(
        null,
        `fb-import-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.zip`,
      ),
  }),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GiB ceiling — real exports run "a few hundred MB"
  fileFilter: (
    _req: unknown,
    file: Express.Multer.File,
    cb: (err: Error | null, accept: boolean) => void,
  ) => {
    if (!/\.zip$/i.test(file.originalname)) {
      return cb(new BadRequestException('僅接受 .zip 檔案。'), false);
    }
    cb(null, true);
  },
};

@ApiTags('admin')
@Controller('admin/fb-import')
@UseGuards(AdminGuard)
export class FbImportController {
  constructor(private readonly fbImportService: FbImportService) {}

  @Post()
  @ApiBearerAuth('admin-token')
  @ApiOperation({
    summary: '上傳 Facebook 匯出 zip 並執行完整匯入流程（僅限本機開發環境）',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(FileInterceptor('file', fbImportMulterOptions))
  async importFbExport(
    @UploadedFile() file: Express.Multer.File,
    @Res() res: Response,
  ) {
    if (!file) throw new BadRequestException('缺少上傳檔案（file）。');
    if (!this.fbImportService.isEtlAvailable()) {
      throw new ConflictException(
        '此功能僅限本機開發環境使用（etl/ 未包含在部署的容器中）。請以 npm run start:dev 在本機執行後台再試一次。',
      );
    }

    // Gemini calls, fixed sleeps, R2 uploads, and rate-limited geocoding can
    // together take many minutes — never let the platform's default response
    // timeout cut the stream short.
    res.setTimeout(0);

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    const batch = this.fbImportService.generateBatchName();

    try {
      for await (const event of this.fbImportService.runPreparePipeline(
        batch,
        file.path,
      )) {
        res.write(JSON.stringify(event) + '\n');
      }
    } catch (err) {
      res.write(
        JSON.stringify({
          type: 'done',
          success: false,
          summary: `Fatal: ${(err as Error).message}`,
        }) + '\n',
      );
    } finally {
      res.end();
    }
  }

  @Post(':batch/confirm')
  @ApiBearerAuth('admin-token')
  @ApiOperation({
    summary:
      '確認要救回的 skip 貼文並完成匯入（06_import → R2 上傳 → 07_trips → 08_geocode）',
  })
  async confirmFbImport(
    @Param('batch') batch: string,
    @Body('rescued') rescued: RescuedPost[] | undefined,
    @Res() res: Response,
  ) {
    if (!BATCH_NAME_PATTERN.test(batch)) {
      throw new BadRequestException('無效的 batch 名稱。');
    }
    if (!this.fbImportService.isEtlAvailable()) {
      throw new ConflictException(
        '此功能僅限本機開發環境使用（etl/ 未包含在部署的容器中）。請以 npm run start:dev 在本機執行後台再試一次。',
      );
    }

    res.setTimeout(0);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    try {
      for await (const event of this.fbImportService.runFinalizePipeline(
        batch,
        Array.isArray(rescued) ? rescued : [],
      )) {
        res.write(JSON.stringify(event) + '\n');
      }
    } catch (err) {
      res.write(
        JSON.stringify({
          type: 'done',
          success: false,
          summary: `Fatal: ${(err as Error).message}`,
        }) + '\n',
      );
    } finally {
      res.end();
    }
  }
}
