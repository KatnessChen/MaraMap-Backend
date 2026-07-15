import { EventEmitter } from 'events';
import * as fs from 'fs';
import { FbImportService } from './fb-import.service';
import * as zipExtractor from './zip-extractor';
import { parseImportSummary } from './pipeline-events';
import { spawn } from 'child_process';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('./zip-extractor');

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

describe('FbImportService', () => {
  let service: FbImportService;
  let children: FakeChild[];

  beforeEach(() => {
    service = new FbImportService();
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
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe('runPreparePipeline', () => {
    it('runs unzip through 05_merge, then yields ready-for-review instead of done', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest
        .spyOn(fs, 'readFileSync')
        .mockReturnValue(
          JSON.stringify([
            { timestamp: 1, date: '2026-01-01', title: 'x', text: 'y' },
          ]),
        );

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
      expect(starts).toEqual([
        'unzip',
        '01_ingest',
        '02_classify',
        '03_analyze_base',
        '03_analyze_marathon',
        '03_analyze_hiking',
        '04_format',
        '05_merge',
      ]);

      const scriptArgs = mockSpawn.mock.calls.map(
        (call) => call[1]![0] as string,
      );
      expect(scriptArgs.some((p) => p.includes('05_merge/merge.js'))).toBe(
        true,
      );
      expect(scriptArgs.some((p) => p.includes('06_import'))).toBe(false);

      const review = events.find((e) => e.type === 'ready-for-review');
      expect(review).toBeDefined();
      expect(review.batch).toBe('batch-1');
      expect(review.skipped).toEqual([
        { timestamp: 1, date: '2026-01-01', title: 'x', text: 'y' },
      ]);
    });

    it('stops the chain when a stage exits non-zero and reports failure', async () => {
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        const child = new FakeChild();
        children.push(child);
        callCount++;
        const failAtCall = 3; // 01_ingest=1, 02_classify=2, 03_analyze_base=3 → fail here
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

      expect(callCount).toBe(3);
      const done = events.find((e) => e.type === 'done');
      expect(done.success).toBe(false);
      expect(done.summary).toContain('03_analyze_base');
      expect(events.find((e) => e.type === 'ready-for-review')).toBeUndefined();
    });

    it('deletes the uploaded zip after the run regardless of outcome', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(false);
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
    it('merges rescued posts into merged.json, then runs exactly the 4 finalize stages', async () => {
      const skipped = [
        {
          timestamp: 42,
          date: '2026-02-02',
          title: '未分類貼文',
          text: '內容',
        },
      ];
      const merged = [
        {
          timestamp: 1,
          date: '2026-01-01',
          title: 'existing',
          category: '馬拉松',
        },
      ];

      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockImplementation((filePath: any) => {
        if (String(filePath).includes('skipped.json'))
          return JSON.stringify(skipped);
        if (String(filePath).includes('merged.json'))
          return JSON.stringify(merged);
        throw new Error(`unexpected readFileSync path: ${filePath}`);
      });
      const writeSpy = jest
        .spyOn(fs, 'writeFileSync')
        .mockImplementation(() => undefined);
      jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);

      const events: any[] = [];
      for await (const ev of service.runFinalizePipeline('batch-4', [
        { timestamp: 42, category: '旅遊' },
      ])) {
        events.push(ev);
      }

      const [writtenPath, writtenContent] = writeSpy.mock.calls[0];
      expect(String(writtenPath)).toContain('merged.json');
      const writtenArray = JSON.parse(writtenContent as string);
      expect(writtenArray).toHaveLength(2);
      expect(writtenArray[1]).toMatchObject({
        timestamp: 42,
        category: '旅遊',
        title: '未分類貼文',
        text: '內容',
      });

      const starts = events
        .filter((e) => e.type === 'stage-start')
        .map((e) => e.stage);
      expect(starts).toEqual([
        '06_import',
        'r2_upload',
        '07_trips',
        '08_geocode',
      ]);

      const done = events.find((e) => e.type === 'done');
      expect(done.success).toBe(true);
    });

    it('skips writing merged.json when there is nothing to rescue', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      const writeSpy = jest
        .spyOn(fs, 'writeFileSync')
        .mockImplementation(() => undefined);

      const events: any[] = [];
      for await (const ev of service.runFinalizePipeline('batch-5', [])) {
        events.push(ev);
      }

      expect(writeSpy).not.toHaveBeenCalled();
      const starts = events
        .filter((e) => e.type === 'stage-start')
        .map((e) => e.stage);
      expect(starts).toEqual([
        '06_import',
        'r2_upload',
        '07_trips',
        '08_geocode',
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
