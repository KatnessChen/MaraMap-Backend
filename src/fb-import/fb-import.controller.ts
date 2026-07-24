import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
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
import { CategoryEdit } from './pipeline-events';

const BATCH_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Prepares an NDJSON stream that outlives its reader.
 *
 * The admin is expected to close the tab mid-import and come back later, so a
 * disconnect must not disturb the pipeline: the returned writer drops events
 * once the socket is gone (writing to a destroyed response emits an unhandled
 * 'error' that would take down the dev server) while the generator keeps
 * running to completion, leaving the batch resumable on disk.
 */
function openEventStream(res: Response): (event: unknown) => void {
  res.setTimeout(0); // Gemini calls, R2 uploads and rate-limited geocoding take many minutes
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  res.on('error', () => {});

  return (event: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(JSON.stringify(event) + '\n');
  };
}

function closeEventStream(res: Response): void {
  if (!res.writableEnded && !res.destroyed) res.end();
}

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
        '此功能僅限本機開發環境使用（etl_local/ 未包含在部署的容器中）。請以 npm run start:dev 在本機執行後台再試一次。',
      );
    }

    const emit = openEventStream(res);
    const batch = this.fbImportService.generateBatchName();

    try {
      for await (const event of this.fbImportService.runPreparePipeline(
        batch,
        file.path,
      )) {
        emit(event);
      }
    } catch (err) {
      emit({
        type: 'done',
        success: false,
        summary: `Fatal: ${(err as Error).message}`,
      });
    } finally {
      closeEventStream(res);
    }
  }

  @Get('pending')
  @ApiBearerAuth('admin-token')
  @ApiOperation({
    summary: '列出已解析但尚未完成匯入的 batch（供關閉頁面後接續）',
  })
  listPending() {
    return { batches: this.fbImportService.listResumableBatches() };
  }

  @Get(':batch/review')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '取回指定 batch 的分類結果以繼續審核' })
  getReview(@Param('batch') batch: string) {
    if (!BATCH_NAME_PATTERN.test(batch)) {
      throw new BadRequestException('無效的 batch 名稱。');
    }
    const review = this.fbImportService.readReview(batch);
    if (!review) throw new NotFoundException('找不到這個匯入批次。');
    return review;
  }

  @Delete(':batch')
  @ApiBearerAuth('admin-token')
  @ApiOperation({
    summary:
      '取消未完成的匯入，將該批次的本機檔案移至垃圾桶（不影響已寫入資料庫的文章）',
  })
  cancelBatch(@Param('batch') batch: string) {
    if (!BATCH_NAME_PATTERN.test(batch)) {
      throw new BadRequestException('無效的 batch 名稱。');
    }
    if (!this.fbImportService.isEtlAvailable()) {
      throw new ConflictException('此功能僅限本機開發環境使用。');
    }
    return this.fbImportService.cancelBatch(batch);
  }

  @Post(':batch/confirm')
  @ApiBearerAuth('admin-token')
  @ApiOperation({
    summary:
      '確認分類後完成匯入（03_analyze → 04_format → 05_merge → 06_import → R2 上傳 → 07_trips → 08_geocode）',
  })
  async confirmFbImport(
    @Param('batch') batch: string,
    @Body('edits') edits: CategoryEdit[] | undefined,
    @Res() res: Response,
  ) {
    if (!BATCH_NAME_PATTERN.test(batch)) {
      throw new BadRequestException('無效的 batch 名稱。');
    }
    if (!this.fbImportService.isEtlAvailable()) {
      throw new ConflictException(
        '此功能僅限本機開發環境使用（etl_local/ 未包含在部署的容器中）。請以 npm run start:dev 在本機執行後台再試一次。',
      );
    }

    const emit = openEventStream(res);

    try {
      for await (const event of this.fbImportService.runFinalizePipeline(
        batch,
        Array.isArray(edits) ? edits : [],
      )) {
        emit(event);
      }
    } catch (err) {
      emit({
        type: 'done',
        success: false,
        summary: `Fatal: ${(err as Error).message}`,
      });
    } finally {
      closeEventStream(res);
    }
  }
}
