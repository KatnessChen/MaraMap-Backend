import { EventEmitter } from 'events';
import * as fs from 'fs';
import { ConflictException } from '@nestjs/common';
import { FbImportService } from './fb-import.service';
import * as zipExtractor from './zip-extractor';
import { parseImportSummary } from './pipeline-events';
import { execFileSync, spawn } from 'child_process';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execFileSync: jest.fn(),
}));
jest.mock('./zip-extractor');

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockExecFileSync = execFileSync as jest.MockedFunction<
  typeof execFileSync
>;

const FINALIZE_STAGES = [
  '03_analyze_base',
  '03_analyze_marathon',
  '03_analyze_hiking',
  '04_format',
  '05_merge',
  '06_import',
  'r2_upload',
  '07_trips',
  '08_geocode',
];

const CLASSIFIED = [
  {
    timestamp: 1,
    date: '2026-01-01',
    title: '東京馬',
    text: '完賽紀錄',
    category: '旅遊',
    sub_categories: [],
  },
  {
    timestamp: 2,
    date: '2026-01-02',
    title: '午餐',
    text: '吃飯',
    category: '旅遊',
    sub_categories: [],
  },
];

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

describe('FbImportService', () => {
  let service: FbImportService;
  let children: FakeChild[];
  let refreshAfterMutation: jest.Mock;

  beforeEach(() => {
    refreshAfterMutation = jest.fn().mockResolvedValue(undefined);
    service = new FbImportService({ refreshAfterMutation } as any);
    children = [];
    mockSpawn.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      // Auto-succeed on next tick unless the test overrides it.
      setImmediate(() => child.emit('close', 0));
      return child as any;
    });
    (zipExtractor.extractFacebookZip as jest.Mock).mockResolvedValue({
      fileCount: 3,
      warnings: [],
    });
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    // mockReset (not clearAllMocks) — a leftover "trash is missing" implementation
    // would send a later test down the real fs.rmSync path.
    mockExecFileSync.mockReset();
    jest.spyOn(fs, 'rmSync').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe('runPreparePipeline', () => {
    it('stops after classification and hands every post to the review step', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest
        .spyOn(fs, 'readFileSync')
        .mockReturnValue(JSON.stringify(CLASSIFIED));
      jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);

      const events: any[] = [];
      for await (const ev of service.runPreparePipeline(
        'batch-1',
        '/tmp/fake.zip',
      )) {
        events.push(ev);
      }

      const starts = events
        .filter((e) => e.type === 'stage-start')
        .map((e) => e.stage);
      expect(starts).toEqual(['unzip', '01_ingest', '02_classify']);

      // Nothing downstream of the review gate may run yet.
      const scriptArgs = mockSpawn.mock.calls.map(
        (call) => call[1]![0] as string,
      );
      expect(scriptArgs.some((p) => p.includes('03_analyze'))).toBe(false);
      expect(scriptArgs.some((p) => p.includes('06_import'))).toBe(false);

      const review = events.find((e) => e.type === 'ready-for-review');
      expect(review).toBeDefined();
      expect(review.batch).toBe('batch-1');
      expect(review.posts).toEqual(CLASSIFIED);
    });

    it('records the batch as resumable once it reaches review', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest
        .spyOn(fs, 'readFileSync')
        .mockReturnValue(JSON.stringify(CLASSIFIED));
      const writeSpy = jest
        .spyOn(fs, 'writeFileSync')
        .mockImplementation(() => undefined);

      for await (const ev of service.runPreparePipeline(
        'batch-1b',
        '/tmp/fake.zip',
      )) {
        void ev; // drain
      }

      const stateWrite = writeSpy.mock.calls.find((call) =>
        String(call[0]).includes('import-state.json'),
      );
      expect(stateWrite).toBeDefined();
      expect(JSON.parse(stateWrite![1] as string)).toMatchObject({
        batch: 'batch-1b',
        phase: 'review',
        postCount: 2,
      });
    });

    it('stops the chain when a stage exits non-zero and reports failure', async () => {
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        const child = new FakeChild();
        children.push(child);
        callCount++;
        const failAtCall = 2; // 01_ingest=1, 02_classify=2 → fail here
        setImmediate(() =>
          child.emit('close', callCount === failAtCall ? 1 : 0),
        );
        return child as any;
      });

      const events: any[] = [];
      for await (const ev of service.runPreparePipeline(
        'batch-2',
        '/tmp/fake.zip',
      )) {
        events.push(ev);
      }

      expect(callCount).toBe(2);
      const done = events.find((e) => e.type === 'done');
      expect(done.success).toBe(false);
      expect(done.summary).toContain('02_classify');
      expect(events.find((e) => e.type === 'ready-for-review')).toBeUndefined();
    });

    it('deletes the uploaded zip after the run regardless of outcome', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(false);
      jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
      const unlinkSpy = jest
        .spyOn(fs.promises, 'unlink')
        .mockResolvedValue(undefined);
      for await (const ev of service.runPreparePipeline(
        'batch-3',
        '/tmp/fake.zip',
      )) {
        void ev; // drain
      }
      expect(unlinkSpy).toHaveBeenCalledWith('/tmp/fake.zip');
    });
  });

  describe('runFinalizePipeline', () => {
    it('writes category edits into classified.json before the analyze stages run', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest
        .spyOn(fs, 'readFileSync')
        .mockReturnValue(JSON.stringify(CLASSIFIED));
      const writeSpy = jest
        .spyOn(fs, 'writeFileSync')
        .mockImplementation(() => undefined);

      const events: any[] = [];
      for await (const ev of service.runFinalizePipeline('batch-4', [
        { timestamp: 1, category: '馬拉松', sub_categories: ['海外馬'] },
      ])) {
        events.push(ev);
      }

      const classifiedWrite = writeSpy.mock.calls.find((call) =>
        String(call[0]).includes('classified.json'),
      );
      expect(classifiedWrite).toBeDefined();
      const written = JSON.parse(classifiedWrite![1] as string);
      expect(written).toHaveLength(2);
      expect(written[0]).toMatchObject({
        timestamp: 1,
        category: '馬拉松',
        sub_categories: ['海外馬'],
      });
      expect(written[1]).toMatchObject({ timestamp: 2, category: '旅遊' });

      const starts = events
        .filter((e) => e.type === 'stage-start')
        .map((e) => e.stage);
      expect(starts).toEqual(FINALIZE_STAGES);

      const done = events.find((e) => e.type === 'done');
      expect(done.success).toBe(true);
    });

    it('ignores edits with an unknown category or no matching post', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest
        .spyOn(fs, 'readFileSync')
        .mockReturnValue(JSON.stringify(CLASSIFIED));
      const writeSpy = jest
        .spyOn(fs, 'writeFileSync')
        .mockImplementation(() => undefined);

      for await (const ev of service.runFinalizePipeline('batch-5', [
        { timestamp: 1, category: 'skip' },
        { timestamp: 999, category: '登山' },
      ])) {
        void ev; // drain
      }

      const classifiedWrite = writeSpy.mock.calls.find((call) =>
        String(call[0]).includes('classified.json'),
      );
      expect(classifiedWrite).toBeUndefined();
    });

    it('leaves a failed batch resumable at the review step', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest
        .spyOn(fs, 'readFileSync')
        .mockReturnValue(JSON.stringify(CLASSIFIED));
      const writeSpy = jest
        .spyOn(fs, 'writeFileSync')
        .mockImplementation(() => undefined);
      mockSpawn.mockImplementation(() => {
        const child = new FakeChild();
        setImmediate(() => child.emit('close', 1));
        return child as any;
      });

      const events: any[] = [];
      for await (const ev of service.runFinalizePipeline('batch-6', [])) {
        events.push(ev);
      }

      expect(events.find((e) => e.type === 'done').success).toBe(false);
      const lastState = writeSpy.mock.calls
        .filter((call) => String(call[0]).includes('import-state.json'))
        .pop();
      expect(JSON.parse(lastState![1] as string)).toMatchObject({
        phase: 'review',
      });
    });
  });

  describe('cancelBatch', () => {
    it('trashes every directory the batch wrote to', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);

      const { removed } = service.cancelBatch('batch-7');

      expect(removed).toEqual([
        'etl_local/01_ingest/raw/batch-7',
        'etl_local/01_ingest/output/batch-7',
        'etl_local/02_classify/output/batch-7',
        'etl_local/03_analyze/00_base/output/batch-7',
        'etl_local/03_analyze/01_marathon/output/batch-7',
        'etl_local/03_analyze/02_hiking/output/batch-7',
        'etl_local/04_format/output/batch-7',
        'etl_local/05_merge/output/batch-7',
      ]);
      expect(mockExecFileSync).toHaveBeenCalledTimes(removed.length);
      expect(mockExecFileSync.mock.calls[0][0]).toBe('trash');
    });

    it('leaves directories the batch never created alone', () => {
      jest
        .spyOn(fs, 'existsSync')
        .mockImplementation((p: any) => String(p).includes('01_ingest'));

      expect(service.cancelBatch('batch-8').removed).toEqual([
        'etl_local/01_ingest/raw/batch-8',
        'etl_local/01_ingest/output/batch-8',
      ]);
    });

    it('falls back to deleting outright when trash is unavailable', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      const rmSpy = jest.spyOn(fs, 'rmSync').mockImplementation(() => undefined);
      mockExecFileSync.mockImplementation(() => {
        throw new Error('command not found: trash');
      });

      service.cancelBatch('batch-9');

      expect(rmSpy).toHaveBeenCalledTimes(8);
      expect(rmSpy.mock.calls[0][1]).toEqual({ recursive: true, force: true });
    });

    it('refuses to cancel a batch whose pipeline is still running', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest
        .spyOn(fs, 'readFileSync')
        .mockReturnValue(JSON.stringify(CLASSIFIED));
      jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);

      // Cancel mid-run: step the generator once so the batch is marked running,
      // but don't drain it.
      const run = service.runFinalizePipeline('batch-10', []);
      await run.next();

      expect(() => service.cancelBatch('batch-10')).toThrow(ConflictException);

      await run.return(undefined as any); // release the batch
      expect(() => service.cancelBatch('batch-10')).not.toThrow();
    });
  });

  describe('listResumableBatches', () => {
    it('returns unfinished batches newest first and hides completed ones', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readdirSync').mockReturnValue(['old', 'new', 'done'] as any);
      jest.spyOn(fs, 'readFileSync').mockImplementation((filePath: any) => {
        const p = String(filePath);
        if (p.includes('/old/'))
          return JSON.stringify({
            batch: 'old',
            phase: 'review',
            postCount: 1,
            updatedAt: '2026-07-01T00:00:00.000Z',
          });
        if (p.includes('/new/'))
          return JSON.stringify({
            batch: 'new',
            phase: 'finalizing',
            postCount: 2,
            updatedAt: '2026-07-20T00:00:00.000Z',
          });
        return JSON.stringify({
          batch: 'done',
          phase: 'done',
          postCount: 3,
          updatedAt: '2026-07-22T00:00:00.000Z',
        });
      });

      expect(service.listResumableBatches().map((s) => s.batch)).toEqual([
        'new',
        'old',
      ]);
    });
  });
});

describe('parseImportSummary', () => {
  it('extracts the inserted count', () => {
    const summary = parseImportSummary([
      'some log',
      '✅ Inserted 5 new record(s).',
      'more log',
    ]);
    expect(summary).toContain('5');
  });

  it('reports when nothing new was imported', () => {
    const summary = parseImportSummary([
      '✅ Nothing new to import — all posts already exist.',
    ]);
    expect(summary).toContain('沒有新文章');
  });

  it('falls back to a generic message when no summary line is found', () => {
    const summary = parseImportSummary(['unrelated log line']);
    expect(summary).toContain('找不到');
  });
});
