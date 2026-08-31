import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FbImportController } from './fb-import.controller';
import { FbImportService } from './fb-import.service';
import { R2Service } from '../storage/r2.service';
import { AuthService } from '../auth/auth.service';
import { AdminGuard } from '../auth/guards/admin.guard';
import { PipelineEvent } from './pipeline-events';

/**
 * Minimal Express Response double covering exactly what openEventStream /
 * closeEventStream touch. `write` records every chunk so tests can assert on
 * the exact NDJSON lines produced; `end` flips `writableEnded` the same way
 * the real response does, which is what lets the "dropped connection" test
 * below verify events stop being written once the socket is gone. Cast once
 * here rather than at every call site — this double implements a handful of
 * Response's 80+ members on purpose, only the ones the controller touches.
 */
function createMockRes(): Response & { written: string[] } {
  const res = {
    writableEnded: false,
    destroyed: false,
    written: [] as string[],
    setTimeout: jest.fn(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    on: jest.fn(),
    write: jest.fn((chunk: string) => {
      res.written.push(chunk);
      return true;
    }),
    end: jest.fn(() => {
      res.writableEnded = true;
    }),
  };
  return res as unknown as Response & { written: string[] };
}

async function* fakeEvents(
  events: PipelineEvent[],
): AsyncGenerator<PipelineEvent> {
  for (const e of events) yield e;
}

async function* throwingAfter(
  events: PipelineEvent[],
  err: Error,
): AsyncGenerator<PipelineEvent> {
  for (const e of events) yield e;
  throw err;
}

describe('FbImportController', () => {
  let controller: FbImportController;
  let service: jest.Mocked<
    Pick<
      FbImportService,
      | 'generateBatchName'
      | 'zipKey'
      | 'runPreparePipeline'
      | 'runFinalizePipeline'
      | 'listResumableBatches'
      | 'readReview'
      | 'cancelBatch'
    >
  >;
  let r2: jest.Mocked<Pick<R2Service, 'presignPut'>>;

  beforeEach(async () => {
    service = {
      generateBatchName: jest.fn(),
      zipKey: jest.fn(),
      runPreparePipeline: jest.fn(),
      runFinalizePipeline: jest.fn(),
      listResumableBatches: jest.fn(),
      readReview: jest.fn(),
      cancelBatch: jest.fn(),
    };
    r2 = { presignPut: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FbImportController],
      providers: [
        { provide: FbImportService, useValue: service },
        { provide: R2Service, useValue: r2 },
        {
          provide: AuthService,
          useValue: { verifyAdminToken: jest.fn().mockResolvedValue(false) },
        },
        AdminGuard,
        Reflector,
      ],
    }).compile();

    controller = module.get(FbImportController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('createUploadUrl', () => {
    it('generates a batch, derives its zip key, and presigns a PUT', async () => {
      service.generateBatchName.mockReturnValue('admin-import-batch1');
      service.zipKey.mockReturnValue(
        'pending-imports/admin-import-batch1/upload.zip',
      );
      r2.presignPut.mockResolvedValue('https://r2.example/presigned');

      const result = await controller.createUploadUrl();

      expect(r2.presignPut).toHaveBeenCalledWith(
        'pending-imports/admin-import-batch1/upload.zip',
        'application/zip',
      );
      expect(result).toEqual({
        batch: 'admin-import-batch1',
        key: 'pending-imports/admin-import-batch1/upload.zip',
        url: 'https://r2.example/presigned',
      });
    });
  });

  describe('prepareFbImport', () => {
    it('rejects a batch name outside the allowed pattern before touching the stream or the service', async () => {
      const res = createMockRes();
      await expect(
        controller.prepareFbImport('bad batch!', res),
      ).rejects.toThrow(BadRequestException);
      expect(service.runPreparePipeline).not.toHaveBeenCalled();
      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('streams each pipeline event as one NDJSON line and closes the response', async () => {
      const events: PipelineEvent[] = [
        { type: 'stage-start', stage: 'unzip', index: 1, total: 2 },
        { type: 'stage-end', stage: 'unzip', exitCode: 0 },
      ];
      service.runPreparePipeline.mockReturnValue(fakeEvents(events));
      const res = createMockRes();

      await controller.prepareFbImport('batch-1', res);

      expect(service.runPreparePipeline).toHaveBeenCalledWith('batch-1');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/x-ndjson',
      );
      expect(res.written).toEqual([
        JSON.stringify(events[0]) + '\n',
        JSON.stringify(events[1]) + '\n',
      ]);
      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it('turns a mid-stream failure into a fatal "done" event instead of an unhandled rejection', async () => {
      const events: PipelineEvent[] = [
        { type: 'stage-start', stage: 'unzip', index: 1, total: 2 },
      ];
      service.runPreparePipeline.mockReturnValue(
        throwingAfter(events, new Error('R2 timed out')),
      );
      const res = createMockRes();

      await controller.prepareFbImport('batch-1', res);

      expect(res.written).toHaveLength(2);
      expect(res.written[0]).toBe(JSON.stringify(events[0]) + '\n');
      expect(JSON.parse(res.written[1])).toEqual({
        type: 'done',
        success: false,
        summary: 'Fatal: R2 timed out',
      });
      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it('stops writing once the client has disconnected, but still lets the generator finish', async () => {
      let yielded = 0;
      const res = createMockRes();
      async function* events(): AsyncGenerator<PipelineEvent> {
        yielded++;
        yield { type: 'stage-start', stage: 'unzip', index: 1, total: 2 };
        // Simulate the admin closing the tab mid-import. writableEnded is
        // read-only on the real Response type; this double needs to fake it.
        (res as { writableEnded: boolean }).writableEnded = true;
        yielded++;
        yield { type: 'stage-end', stage: 'unzip', exitCode: 0 };
      }
      service.runPreparePipeline.mockReturnValue(events());

      await controller.prepareFbImport('batch-1', res);

      expect(yielded).toBe(2); // generator ran to completion...
      expect(res.written).toHaveLength(1); // ...but only the pre-disconnect event was written
      expect(res.end).not.toHaveBeenCalled(); // closeEventStream also checks writableEnded
    });
  });

  describe('listPending', () => {
    it('wraps the resumable batches in a { batches } envelope', async () => {
      const batches = [
        {
          batch: 'b1',
          phase: 'review' as const,
          postCount: 3,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ];
      service.listResumableBatches.mockResolvedValue(batches);

      const result = await controller.listPending();

      expect(result).toEqual({ batches });
    });
  });

  describe('getReview', () => {
    it('rejects an invalid batch name', async () => {
      await expect(controller.getReview('../etc')).rejects.toThrow(
        BadRequestException,
      );
      expect(service.readReview).not.toHaveBeenCalled();
    });

    it('returns the review when the service finds one', async () => {
      const review = {
        state: {
          batch: 'batch-1',
          phase: 'review' as const,
          postCount: 1,
          updatedAt: '2026-01-01T00:00:00Z',
        },
        posts: [],
      };
      service.readReview.mockResolvedValue(review);

      const result = await controller.getReview('batch-1');

      expect(service.readReview).toHaveBeenCalledWith('batch-1');
      expect(result).toBe(review);
    });

    it('throws NotFoundException when no batch matches', async () => {
      service.readReview.mockResolvedValue(null);
      await expect(controller.getReview('batch-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('cancelBatch', () => {
    it('rejects an invalid batch name', async () => {
      await expect(controller.cancelBatch('bad name')).rejects.toThrow(
        BadRequestException,
      );
      expect(service.cancelBatch).not.toHaveBeenCalled();
    });

    it('delegates to the service and returns its result', async () => {
      const result = {
        removed: ['etl_local/01_ingest/raw/batch-1'],
        r2Objects: 4,
      };
      service.cancelBatch.mockResolvedValue(result);

      expect(await controller.cancelBatch('batch-1')).toBe(result);
      expect(service.cancelBatch).toHaveBeenCalledWith('batch-1');
    });
  });

  describe('confirmFbImport', () => {
    it('rejects a batch name outside the allowed pattern before touching the stream or the service', async () => {
      const res = createMockRes();
      await expect(
        controller.confirmFbImport('bad batch!', undefined, undefined, res),
      ).rejects.toThrow(BadRequestException);
      expect(service.runFinalizePipeline).not.toHaveBeenCalled();
    });

    it('defaults missing edits/skipped to empty arrays and filters non-numbers out of skipped', async () => {
      service.runFinalizePipeline.mockReturnValue(fakeEvents([]));
      const res = createMockRes();

      await controller.confirmFbImport(
        'batch-1',
        undefined,
        [1, 'not-a-number' as unknown as number, 2, null as unknown as number],
        res,
      );

      expect(service.runFinalizePipeline).toHaveBeenCalledWith(
        'batch-1',
        [],
        [1, 2],
      );
    });

    it('defaults a missing skipped to an empty array', async () => {
      service.runFinalizePipeline.mockReturnValue(fakeEvents([]));
      const res = createMockRes();

      await controller.confirmFbImport(
        'batch-1',
        [{ timestamp: 1, category: '旅遊' }],
        undefined,
        res,
      );

      expect(service.runFinalizePipeline).toHaveBeenCalledWith(
        'batch-1',
        [{ timestamp: 1, category: '旅遊' }],
        [],
      );
    });

    it('passes a well-formed edits array through untouched', async () => {
      service.runFinalizePipeline.mockReturnValue(fakeEvents([]));
      const res = createMockRes();
      const edits = [{ timestamp: 123, category: '登山' }];

      await controller.confirmFbImport('batch-1', edits, [], res);

      expect(service.runFinalizePipeline).toHaveBeenCalledWith(
        'batch-1',
        edits,
        [],
      );
    });

    it('streams events and closes the response on success', async () => {
      const events: PipelineEvent[] = [
        { type: 'done', success: true, summary: '匯入完成 — 新增 1 篇文章。' },
      ];
      service.runFinalizePipeline.mockReturnValue(fakeEvents(events));
      const res = createMockRes();

      await controller.confirmFbImport('batch-1', [], [], res);

      expect(res.written).toEqual([JSON.stringify(events[0]) + '\n']);
      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it('turns a mid-stream failure into a fatal "done" event', async () => {
      service.runFinalizePipeline.mockReturnValue(
        throwingAfter([], new Error('Supabase down')),
      );
      const res = createMockRes();

      await controller.confirmFbImport('batch-1', [], [], res);

      expect(JSON.parse(res.written[0])).toEqual({
        type: 'done',
        success: false,
        summary: 'Fatal: Supabase down',
      });
      expect(res.end).toHaveBeenCalledTimes(1);
    });
  });
});
