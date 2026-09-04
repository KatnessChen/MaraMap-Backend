import { EventEmitter } from 'events';
import * as fs from 'fs';
import { ConflictException } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import type * as unzipper from 'unzipper';
import { FbImportService } from './fb-import.service';
import * as r2zip from './r2-zip';
import {
  parseImportSummary,
  PipelineEvent,
  ReviewPost,
} from './pipeline-events';
import { execFileSync, spawn } from 'child_process';
import { StatsService } from '../stats/stats.service';
import { R2Service } from '../storage/r2.service';
import { SupabaseService } from '../supabase/supabase.service';
import { TranslationsService } from '../translations/translations.service';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execFileSync: jest.fn(),
}));
jest.mock('./r2-zip');

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockExecFileSync = execFileSync as jest.MockedFunction<
  typeof execFileSync
>;
const mockOpenZip = r2zip.openZipFromR2 as jest.MockedFunction<
  typeof r2zip.openZipFromR2
>;
const mockExtractJson = r2zip.extractJsonEntries as jest.MockedFunction<
  typeof r2zip.extractJsonEntries
>;
const mockMediaEntries = r2zip.mediaEntries as jest.MockedFunction<
  typeof r2zip.mediaEntries
>;
const mockStreamEntry = r2zip.streamEntryToR2 as jest.MockedFunction<
  typeof r2zip.streamEntryToR2
>;

const PREPARE_STAGES = ['unzip', '01_ingest', 'media_stage', '02_classify'];
const FINALIZE_STAGES = [
  '03_analyze_base',
  '03_analyze_marathon',
  '03_analyze_hiking',
  '04_format',
  '05_merge',
  '06_import',
  'publish_media',
  '07_trips',
  '08_geocode',
];

const MEDIA_URI = 'your_facebook_activity/posts/media/a.jpg';

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

/** In-memory stand-in for the parts of R2Service the import flow touches. */
class FakeR2 {
  store = new Map<string, Buffer>();

  exists = jest.fn(async (key: string) => this.store.has(key));
  getJson = jest.fn(async (key: string) =>
    this.store.has(key)
      ? JSON.parse(this.store.get(key)!.toString('utf8'))
      : null,
  );
  putJson = jest.fn(async (key: string, value: unknown) => {
    this.store.set(key, Buffer.from(JSON.stringify(value)));
  });
  upload = jest.fn(async (key: string, body: Buffer) => {
    this.store.set(key, body);
    return key;
  });
  copy = jest.fn(async (src: string, dest: string) => {
    this.store.set(dest, this.store.get(src) ?? Buffer.alloc(0));
  });
  delete = jest.fn(async (key: string) => {
    this.store.delete(key);
  });
  deletePrefix = jest.fn(async (prefix: string) => {
    let n = 0;
    for (const k of [...this.store.keys()]) {
      if (k.startsWith(prefix)) {
        this.store.delete(k);
        n++;
      }
    }
    return n;
  });
  list = jest.fn(async (prefix: string) =>
    [...this.store.keys()].filter((k) => k.startsWith(prefix)),
  );
  listPrefixes = jest.fn(async (prefix: string) => {
    const out = new Set<string>();
    for (const k of this.store.keys()) {
      if (!k.startsWith(prefix)) continue;
      out.add(prefix + k.slice(prefix.length).split('/')[0] + '/');
    }
    return [...out];
  });
  presignPut = jest.fn(async () => 'https://signed.example');
}

/** Chainable fake for the two Supabase queries publish_media makes. */
class FakeSupabase {
  rows: { fb_timestamp: number; media: { uri: string }[] }[] = [];
  updates: { fb_timestamp: number; media: { uri: string }[] }[] = [];

  getClient() {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: async () => ({ data: this.rows, error: null }),
          }),
        }),
        update: (value: { media: { uri: string }[] }) => ({
          eq: () => ({
            eq: async (_col: string, ts: number) => {
              this.updates.push({ fb_timestamp: ts, media: value.media });
              return { error: null };
            },
          }),
        }),
      }),
    };
  }
}

describe('FbImportService', () => {
  let service: FbImportService;
  let r2: FakeR2;
  let supabase: FakeSupabase;
  let refreshAfterMutation: jest.Mock;
  let cacheDel: jest.Mock;

  const seedZip = (batch: string) =>
    r2.store.set(`pending-imports/${batch}/upload.zip`, Buffer.from('zip'));

  const seedWorkspace = (batch: string) => {
    r2.store.set(
      `pending-imports/${batch}/workspace/posts.json`,
      Buffer.from(JSON.stringify([{ timestamp: 1 }, { timestamp: 2 }])),
    );
    r2.store.set(
      `pending-imports/${batch}/workspace/media.json`,
      Buffer.from(JSON.stringify([{ timestamp: 1, uri: MEDIA_URI }])),
    );
    r2.store.set(
      `pending-imports/${batch}/workspace/classified.json`,
      Buffer.from(JSON.stringify(CLASSIFIED)),
    );
  };

  const seedState = (batch: string, phase: string, updatedAt: string) =>
    r2.store.set(
      `pending-imports/${batch}/state.json`,
      Buffer.from(JSON.stringify({ batch, phase, postCount: 2, updatedAt })),
    );

  // Local-file behavior for the spawn stages' outputs the service reads back.
  // Stateful: what the service writes (hydration, category edits) must be
  // what it reads back later — persistWorkspace re-uploads these files to R2.
  const mockLocalFiles = () => {
    const written = new Map<string, string>();
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
      written.set(String(p), String(data));
    });
    jest.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      const s = String(p);
      if (written.has(s)) return written.get(s)!;
      if (s.endsWith('media.json')) {
        return JSON.stringify([{ timestamp: 1, uri: MEDIA_URI }]);
      }
      if (s.endsWith('posts.json')) {
        return JSON.stringify([{ timestamp: 1 }, { timestamp: 2 }]);
      }
      return JSON.stringify(CLASSIFIED);
    });
  };

  beforeEach(() => {
    process.env.USER_ID = 'user-1';
    process.env.R2_PUBLIC_URL = 'https://cdn.test';

    refreshAfterMutation = jest.fn().mockResolvedValue(undefined);
    cacheDel = jest.fn().mockResolvedValue(undefined);
    r2 = new FakeR2();
    supabase = new FakeSupabase();
    service = new FbImportService(
      { refreshAfterMutation } as unknown as StatsService,
      r2 as unknown as R2Service,
      supabase as unknown as SupabaseService,
      {
        translateMissingTitles: jest.fn().mockResolvedValue(0),
      } as unknown as TranslationsService,
      { del: cacheDel } as unknown as Cache,
    );

    mockSpawn.mockImplementation(() => {
      const child = new FakeChild();
      // Auto-succeed on next tick unless the test overrides it.
      setImmediate(() => child.emit('close', 0));
      return child as unknown as ReturnType<typeof spawn>;
    });
    mockOpenZip.mockResolvedValue({
      files: [],
    } as unknown as unzipper.CentralDirectory);
    mockExtractJson.mockResolvedValue({ fileCount: 3, warnings: [] });
    mockMediaEntries.mockReturnValue(
      new Map([
        [MEDIA_URI, { uncompressedSize: 10 } as unknown as unzipper.File],
      ]),
    );
    mockStreamEntry.mockResolvedValue(undefined);
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
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
    it('streams JSONs + media from the R2 zip, stops after classification', async () => {
      mockLocalFiles();
      seedZip('batch-1');

      const events: PipelineEvent[] = [];
      for await (const ev of service.runPreparePipeline('batch-1')) {
        events.push(ev);
      }

      const starts = events
        .filter((e) => e.type === 'stage-start')
        .map((e) => e.stage);
      expect(starts).toEqual(PREPARE_STAGES);

      // Media went to the batch's staging area, not the final key.
      expect(mockStreamEntry).toHaveBeenCalledTimes(1);
      expect(mockStreamEntry.mock.calls[0][2]).toBe(
        `pending-imports/batch-1/media-staging/${MEDIA_URI}`,
      );

      // Nothing downstream of the review gate may run yet.
      const scriptArgs = mockSpawn.mock.calls.map(
        (call) => call[1]![0] as string,
      );
      expect(scriptArgs.some((p) => p.includes('03_analyze'))).toBe(false);
      expect(scriptArgs.some((p) => p.includes('06_import'))).toBe(false);

      const review = events.find((e) => e.type === 'ready-for-review');
      expect(review).toBeDefined();
      expect(review.batch).toBe('batch-1');
      // Same posts, now enriched with staged-media preview URLs.
      expect(
        review.posts.map(({ media, ...rest }: ReviewPost) => rest),
      ).toEqual(CLASSIFIED);
      expect(review.posts[0].media).toEqual([
        {
          url: `https://cdn.test/pending-imports/batch-1/media-staging/${MEDIA_URI}`,
          type: 'photo',
        },
      ]);
      expect(review.posts[1].media).toEqual([]);

      // The batch is resumable: durable state + workspace live in R2 now.
      expect(
        await r2.getJson('pending-imports/batch-1/state.json'),
      ).toMatchObject({ batch: 'batch-1', phase: 'review', postCount: 2 });
      expect(
        r2.store.has('pending-imports/batch-1/workspace/classified.json'),
      ).toBe(true);
    });

    it('fails cleanly when no zip was uploaded for the batch', async () => {
      const events: PipelineEvent[] = [];
      for await (const ev of service.runPreparePipeline('batch-2')) {
        events.push(ev);
      }
      const done = events.find((e) => e.type === 'done');
      expect(done.success).toBe(false);
      expect(done.summary).toContain('upload.zip');
    });

    it('marks the batch failed (retryable) when a stage exits non-zero', async () => {
      mockLocalFiles();
      seedZip('batch-3');
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        const child = new FakeChild();
        callCount++;
        const failAtCall = 2; // 01_ingest=1, 02_classify=2 → fail here
        setImmediate(() =>
          child.emit('close', callCount === failAtCall ? 1 : 0),
        );
        return child as unknown as ReturnType<typeof spawn>;
      });

      const events: PipelineEvent[] = [];
      for await (const ev of service.runPreparePipeline('batch-3')) {
        events.push(ev);
      }

      expect(callCount).toBe(2);
      const done = events.find((e) => e.type === 'done');
      expect(done.success).toBe(false);
      expect(done.summary).toContain('02_classify');
      expect(events.find((e) => e.type === 'ready-for-review')).toBeUndefined();
      // The zip stays in R2 and the state records the failure for retry.
      expect(r2.store.has('pending-imports/batch-3/upload.zip')).toBe(true);
      expect(
        await r2.getJson('pending-imports/batch-3/state.json'),
      ).toMatchObject({ phase: 'failed' });
    });
  });

  describe('runFinalizePipeline', () => {
    const seedFinalize = (batch: string) => {
      mockLocalFiles();
      seedZip(batch);
      seedWorkspace(batch);
      r2.store.set(
        `pending-imports/${batch}/media-staging/${MEDIA_URI}`,
        Buffer.from('jpeg-bytes'),
      );
      supabase.rows = [{ fb_timestamp: 1, media: [{ uri: MEDIA_URI }] }];
    };

    it('applies edits, runs every stage, publishes media, and cleans up', async () => {
      seedFinalize('batch-4');

      const events: PipelineEvent[] = [];
      for await (const ev of service.runFinalizePipeline('batch-4', [
        { timestamp: 1, category: '馬拉松', sub_categories: ['海外馬'] },
      ])) {
        events.push(ev);
      }

      const starts = events
        .filter((e) => e.type === 'stage-start')
        .map((e) => e.stage);
      expect(starts).toEqual(FINALIZE_STAGES);

      // The edit reached the durable classified.json in R2.
      const classified = await r2.getJson(
        'pending-imports/batch-4/workspace/classified.json',
      );
      expect(classified[0]).toMatchObject({
        timestamp: 1,
        category: '馬拉松',
        sub_categories: ['海外馬'],
      });

      // publish_media: staging copy landed on the final key + DB rewrite.
      expect(r2.copy).toHaveBeenCalledWith(
        `pending-imports/batch-4/media-staging/${MEDIA_URI}`,
        MEDIA_URI,
      );
      expect(supabase.updates).toEqual([
        {
          fb_timestamp: 1,
          media: [{ uri: `https://cdn.test/${MEDIA_URI}` }],
        },
      ]);

      // Cleanup: zip + staging gone, state/workspace kept as audit trail.
      expect(r2.store.has('pending-imports/batch-4/upload.zip')).toBe(false);
      expect(
        r2.store.has(`pending-imports/batch-4/media-staging/${MEDIA_URI}`),
      ).toBe(false);
      expect(
        await r2.getJson('pending-imports/batch-4/state.json'),
      ).toMatchObject({ phase: 'done' });

      expect(events.find((e) => e.type === 'done').success).toBe(true);
      expect(refreshAfterMutation).toHaveBeenCalled();
      // Import bypasses FbPostsService, so it must drop the PB cache itself.
      expect(cacheDel).toHaveBeenCalledWith('pb:user-1');
    });

    it('ignores edits with an unknown category or no matching post', async () => {
      seedFinalize('batch-5');
      const before = r2.store
        .get('pending-imports/batch-5/workspace/classified.json')!
        .toString('utf8');

      for await (const ev of service.runFinalizePipeline('batch-5', [
        { timestamp: 1, category: 'skip' },
        { timestamp: 999, category: '登山' },
      ])) {
        void ev; // drain
      }

      const after = JSON.parse(
        r2.store
          .get('pending-imports/batch-5/workspace/classified.json')!
          .toString('utf8'),
      );
      expect(after).toEqual(JSON.parse(before));
    });

    it('drops skipped posts from classified.json before the stages run', async () => {
      seedFinalize('batch-skip');

      for await (const ev of service.runFinalizePipeline(
        'batch-skip',
        [],
        [2], // skip the second post
      )) {
        void ev; // drain
      }

      const classified = await r2.getJson(
        'pending-imports/batch-skip/workspace/classified.json',
      );
      expect(classified.map((p: { timestamp: number }) => p.timestamp)).toEqual(
        [1],
      );
      expect(
        await r2.getJson('pending-imports/batch-skip/state.json'),
      ).toMatchObject({ phase: 'done', postCount: 1 });
    });

    it('fails cleanly when every post is skipped', async () => {
      seedFinalize('batch-allskip');

      const events: PipelineEvent[] = [];
      for await (const ev of service.runFinalizePipeline(
        'batch-allskip',
        [],
        [1, 2],
      )) {
        events.push(ev);
      }

      const done = events.find((e) => e.type === 'done');
      expect(done.success).toBe(false);
      expect(done.summary).toContain('略過');
      // No stage should have run — nothing to import.
      const scriptArgs = mockSpawn.mock.calls.map((c) => c[1]![0] as string);
      expect(scriptArgs.some((p) => p.includes('06_import'))).toBe(false);
      // Retryable: back to review, zip intact.
      expect(
        await r2.getJson('pending-imports/batch-allskip/state.json'),
      ).toMatchObject({ phase: 'review' });
    });

    it('leaves a failed batch resumable at the review step', async () => {
      seedFinalize('batch-6');
      mockSpawn.mockImplementation(() => {
        const child = new FakeChild();
        setImmediate(() => child.emit('close', 1));
        return child as unknown as ReturnType<typeof spawn>;
      });

      const events: PipelineEvent[] = [];
      for await (const ev of service.runFinalizePipeline('batch-6', [])) {
        events.push(ev);
      }

      expect(events.find((e) => e.type === 'done').success).toBe(false);
      expect(
        await r2.getJson('pending-imports/batch-6/state.json'),
      ).toMatchObject({ phase: 'review' });
      // The zip survives a failed finalize — retry must not need a re-upload.
      expect(r2.store.has('pending-imports/batch-6/upload.zip')).toBe(true);
      expect(refreshAfterMutation).toHaveBeenCalled();
    });
  });

  describe('cancelBatch', () => {
    it('deletes the whole R2 prefix and trashes local batch dirs', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      seedZip('batch-7');
      seedWorkspace('batch-7');
      r2.store.set(
        `pending-imports/batch-7/media-staging/${MEDIA_URI}`,
        Buffer.from('x'),
      );

      const { removed, r2Objects } = await service.cancelBatch('batch-7');

      expect(r2Objects).toBe(5);
      expect([...r2.store.keys()].filter((k) => k.includes('batch-7'))).toEqual(
        [],
      );
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

    it('leaves directories the batch never created alone', async () => {
      jest
        .spyOn(fs, 'existsSync')
        .mockImplementation((p) => String(p).includes('01_ingest'));

      expect((await service.cancelBatch('batch-8')).removed).toEqual([
        'etl_local/01_ingest/raw/batch-8',
        'etl_local/01_ingest/output/batch-8',
      ]);
    });

    it('falls back to deleting outright when trash is unavailable', async () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      const rmSpy = jest
        .spyOn(fs, 'rmSync')
        .mockImplementation(() => undefined);
      mockExecFileSync.mockImplementation(() => {
        throw new Error('command not found: trash');
      });

      await service.cancelBatch('batch-9');

      expect(rmSpy).toHaveBeenCalledTimes(8);
      expect(rmSpy.mock.calls[0][1]).toEqual({ recursive: true, force: true });
    });

    it('refuses to cancel a batch whose pipeline is still running', async () => {
      mockLocalFiles();
      seedZip('batch-10');
      seedWorkspace('batch-10');

      // Cancel mid-run: step the generator once so the batch is marked running,
      // but don't drain it.
      const run = service.runFinalizePipeline('batch-10', []);
      await run.next();

      await expect(service.cancelBatch('batch-10')).rejects.toThrow(
        ConflictException,
      );

      await run.return(undefined); // release the batch
      await expect(service.cancelBatch('batch-10')).resolves.toBeDefined();
    });
  });

  describe('listResumableBatches', () => {
    it('returns unfinished batches newest first and hides completed ones', async () => {
      seedState('old', 'review', '2026-07-01T00:00:00.000Z');
      seedState('new', 'finalizing', '2026-07-20T00:00:00.000Z');
      seedState('finished', 'done', '2026-07-22T00:00:00.000Z');
      // An orphan prefix with no state.json (e.g. abandoned upload) is skipped.
      r2.store.set('pending-imports/orphan/upload.zip', Buffer.from('x'));

      const batches = await service.listResumableBatches();
      expect(batches.map((s) => s.batch)).toEqual(['new', 'old']);
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

  it('reports both new and already-existing counts', () => {
    const summary = parseImportSummary([
      '⏭️  Skipping 4 post(s) already in the database.',
      '✅ Inserted 3 new record(s).',
    ]);
    expect(summary).toContain('新增 3 篇');
    expect(summary).toContain('4 篇已存在資料庫');
  });

  it('says how many already existed when nothing was new', () => {
    const summary = parseImportSummary([
      '⏭️  Skipping 7 post(s) already in the database.',
      '✅ Nothing new to import — all posts already exist.',
    ]);
    expect(summary).toContain('7 篇皆已存在資料庫');
  });

  it('falls back to a generic message when no summary line is found', () => {
    const summary = parseImportSummary(['unrelated log line']);
    expect(summary).toContain('找不到');
  });
});
