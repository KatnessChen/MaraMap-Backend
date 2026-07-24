import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AdminGuard } from '../auth/guards/admin.guard';
import { R2Service } from '../storage/r2.service';
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
 * running to completion, leaving the batch resumable in R2.
 */
function openEventStream(res: Response): (event: unknown) => void {
  res.setTimeout(0); // Gemini calls, R2 transfers and rate-limited geocoding take many minutes
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

@ApiTags('admin')
@Controller('admin/fb-import')
@UseGuards(AdminGuard)
export class FbImportController {
  constructor(
    private readonly fbImportService: FbImportService,
    private readonly r2: R2Service,
  ) {}

  @Post('upload-url')
  @ApiBearerAuth('admin-token')
  @ApiOperation({
    summary:
      '產生 presigned URL 讓瀏覽器把 Facebook 匯出 zip 直接上傳到 R2（繞過 Cloud Run 32MB 請求上限）',
  })
  async createUploadUrl() {
    const batch = this.fbImportService.generateBatchName();
    const key = this.fbImportService.zipKey(batch);
    const url = await this.r2.presignPut(key, 'application/zip');
    return { batch, key, url };
  }

  @Post(':batch/prepare')
  @ApiBearerAuth('admin-token')
  @ApiOperation({
    summary:
      '解析已上傳到 R2 的 zip 並執行前半流程（解壓 JSON → ingest → media 暫存 → AI 分類），完成後暫停等待審核',
  })
  async prepareFbImport(@Param('batch') batch: string, @Res() res: Response) {
    if (!BATCH_NAME_PATTERN.test(batch)) {
      throw new BadRequestException('無效的 batch 名稱。');
    }

    const emit = openEventStream(res);
    try {
      for await (const event of this.fbImportService.runPreparePipeline(
        batch,
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
  async listPending() {
    return { batches: await this.fbImportService.listResumableBatches() };
  }

  @Get(':batch/review')
  @ApiBearerAuth('admin-token')
  @ApiOperation({ summary: '取回指定 batch 的分類結果以繼續審核' })
  async getReview(@Param('batch') batch: string) {
    if (!BATCH_NAME_PATTERN.test(batch)) {
      throw new BadRequestException('無效的 batch 名稱。');
    }
    const review = await this.fbImportService.readReview(batch);
    if (!review) throw new NotFoundException('找不到這個匯入批次。');
    return review;
  }

  @Delete(':batch')
  @ApiBearerAuth('admin-token')
  @ApiOperation({
    summary:
      '取消未完成的匯入，刪除該批次在 R2 的所有暫存檔（不影響已寫入資料庫的文章與已發佈的媒體）',
  })
  async cancelBatch(@Param('batch') batch: string) {
    if (!BATCH_NAME_PATTERN.test(batch)) {
      throw new BadRequestException('無效的 batch 名稱。');
    }
    return this.fbImportService.cancelBatch(batch);
  }

  @Post(':batch/confirm')
  @ApiBearerAuth('admin-token')
  @ApiOperation({
    summary:
      '確認分類後完成匯入（03_analyze → 04_format → 05_merge → 06_import → 發佈媒體 → 07_trips → 08_geocode）',
  })
  async confirmFbImport(
    @Param('batch') batch: string,
    @Body('edits') edits: CategoryEdit[] | undefined,
    @Res() res: Response,
  ) {
    if (!BATCH_NAME_PATTERN.test(batch)) {
      throw new BadRequestException('無效的 batch 名稱。');
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
