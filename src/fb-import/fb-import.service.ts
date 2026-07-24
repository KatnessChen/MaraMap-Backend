import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Cron } from '@nestjs/schedule';
import { execFileSync, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { R2Service } from '../storage/r2.service';
import { SupabaseService } from '../supabase/supabase.service';
import { StatsService } from '../stats/stats.service';
import {
  extractJsonEntries,
  mediaEntries,
  openZipFromR2,
  streamEntryToR2,
} from './r2-zip';
import {
  CategoryEdit,
  ImportPhase,
  ImportState,
  PipelineEvent,
  ReviewPost,
  StageFailedError,
  parseImportSummary,
} from './pipeline-events';

interface Stage {
  name: string;
  script: string;
}

// The pipeline pauses after 02_classify so the admin can correct categories
// before anything expensive or irreversible happens: the analyze stages branch
// on category (marathon vs hiking), so a wrong category there costs a full
// re-run of the AI analysis, not just a database edit.
//
// Cloud layout: every artifact a batch needs across requests lives under
// pending-imports/<batch>/ in R2 — prepare and finalize may land on different
// Cloud Run instances, so local disk is only a per-request scratchpad that the
// workspace hydrate/persist steps sync with R2.
const PREPARE_SPAWN_STAGES: Stage[] = [
  { name: '01_ingest', script: 'etl_local/01_ingest/ingest-fb-data.js' },
  { name: '02_classify', script: 'etl_local/02_classify/ai-classify.js' },
];

// Resumes once the admin confirms the categories. r2_upload is gone: media
// reached R2 during prepare (media_stage), so publish_media only needs
// server-side copies + a DB URI rewrite — both in-process, no local files.
const FINALIZE_SPAWN_STAGES: Stage[] = [
  { name: '03_analyze_base', script: 'etl_local/03_analyze/00_base/analyze.js' },
  {
    name: '03_analyze_marathon',
    script: 'etl_local/03_analyze/01_marathon/analyze.js',
  },
  { name: '03_analyze_hiking', script: 'etl_local/03_analyze/02_hiking/analyze.js' },
  { name: '04_format', script: 'etl_local/04_format/analyze.js' },
  { name: '05_merge', script: 'etl_local/05_merge/merge.js' },
  { name: '06_import', script: 'etl_local/06_import/import-to-supabase.js' },
];
const FINALIZE_SPAWN_STAGES_AFTER_PUBLISH: Stage[] = [
  { name: '07_trips', script: 'etl_local/07_trips/assign-trips.js' },
  { name: '08_geocode', script: 'etl_local/08_geocode/geocode-fallback.js' },
];

// unzip + 01_ingest + media_stage + 02_classify
const TOTAL_PREPARE_STAGES = 2 + PREPARE_SPAWN_STAGES.length;
// spawn stages + publish_media
const TOTAL_FINALIZE_STAGES =
  FINALIZE_SPAWN_STAGES.length + 1 + FINALIZE_SPAWN_STAGES_AFTER_PUBLISH.length;

const VALID_CATEGORIES = ['馬拉松', '登山', '旅遊'];

// How many media files move between R2 and the instance at once. Bounded so a
// video-heavy batch can't hold dozens of multi-hundred-MB streams in flight.
const MEDIA_CONCURRENCY = 6;

// Every JSON artifact the stages exchange, mirrored between the scripts'
// __dirname-relative output dirs and pending-imports/<batch>/workspace/ in R2.
// Basenames are unique across stages, so the R2 side is flat.
const WORKSPACE_FILES: { file: string; dir: string }[] = [
  { file: 'posts.json', dir: 'etl_local/01_ingest/output' },
  { file: 'media.json', dir: 'etl_local/01_ingest/output' },
  { file: 'album_timestamps.json', dir: 'etl_local/01_ingest/output' },
  { file: 'classified.json', dir: 'etl_local/02_classify/output' },
  { file: 'base.json', dir: 'etl_local/03_analyze/00_base/output' },
  { file: 'marathon.json', dir: 'etl_local/03_analyze/01_marathon/output' },
  { file: 'hiking.json', dir: 'etl_local/03_analyze/02_hiking/output' },
  { file: 'format.json', dir: 'etl_local/04_format/output' },
  { file: 'merged.json', dir: 'etl_local/05_merge/output' },
];

// Every local directory a batch writes into, so cancelling one leaves nothing
// behind on a dev machine. On Cloud Run these live on the instance's tmpfs and
// vanish with it. raw/ now only ever holds the export's JSON files — media
// never touches the filesystem in the cloud flow.
const BATCH_DIRS = [
  'etl_local/01_ingest/raw',
  'etl_local/01_ingest/output',
  'etl_local/02_classify/output',
  'etl_local/03_analyze/00_base/output',
  'etl_local/03_analyze/01_marathon/output',
  'etl_local/03_analyze/02_hiking/output',
  'etl_local/04_format/output',
  'etl_local/05_merge/output',
];

const R2_ROOT = 'pending-imports';

interface MediaRecord {
  timestamp: number;
  uri: string;
}

@Injectable()
export class FbImportService {
  private readonly logger = new Logger(FbImportService.name);
  private readonly repoRoot = process.cwd();
  private capturedOutput: string[] = [];
  // Batches with a pipeline attached right now — cancelling one would pull the
  // stage output files out from under a running child process. (Per-instance:
  // good enough for a single-admin tool.)
  private readonly running = new Set<string>();

  constructor(
    private readonly stats: StatsService,
    private readonly r2: R2Service,
    private readonly supabase: SupabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  generateBatchName(): string {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');
    const suffix = crypto.randomBytes(3).toString('hex');
    return `admin-import-${stamp}-${suffix}`;
  }

  zipKey(batch: string): string {
    return `${R2_ROOT}/${batch}/upload.zip`;
  }

  private stateKey(batch: string): string {
    return `${R2_ROOT}/${batch}/state.json`;
  }

  private stagingPrefix(batch: string): string {
    return `${R2_ROOT}/${batch}/media-staging/`;
  }

  private workspaceKey(batch: string, file: string): string {
    return `${R2_ROOT}/${batch}/workspace/${file}`;
  }

  private localWorkspacePath(batch: string, entry: { file: string; dir: string }) {
    return path.join(this.repoRoot, entry.dir, batch, entry.file);
  }

  async *runPreparePipeline(batch: string): AsyncGenerator<PipelineEvent> {
    this.capturedOutput = [];
    const env = { ...process.env, BATCH: batch };
    let stageIndex = 0;
    this.running.add(batch);

    try {
      // --- Pseudo-stage: unzip (JSON entries only, straight from R2) ---
      stageIndex++;
      yield {
        type: 'stage-start',
        stage: 'unzip',
        index: stageIndex,
        total: TOTAL_PREPARE_STAGES,
      };
      if (!(await this.r2.exists(this.zipKey(batch)))) {
        throw new Error(
          `找不到上傳的 zip（${this.zipKey(batch)}）— 請先透過 upload-url 上傳檔案。`,
        );
      }
      const zipDir = await openZipFromR2(this.r2, this.zipKey(batch));
      const rawDir = path.join(this.repoRoot, 'etl_local/01_ingest/raw', batch);
      const { fileCount, warnings } = await extractJsonEntries(zipDir, rawDir);
      yield {
        type: 'log',
        stage: 'unzip',
        stream: 'stdout',
        line: `Zip has ${zipDir.files.length} entries — extracted ${fileCount} JSON file(s) to raw/${batch}/ (media stays in R2)`,
      };
      for (const w of warnings) {
        yield { type: 'log', stage: 'unzip', stream: 'stderr', line: `⚠️ ${w}` };
      }
      yield { type: 'stage-end', stage: 'unzip', exitCode: 0 };

      // --- Stage: ingest (unchanged script — it only reads the JSONs) ---
      stageIndex++;
      yield* this.runStage(
        PREPARE_SPAWN_STAGES[0].name,
        PREPARE_SPAWN_STAGES[0].script,
        env,
        stageIndex,
        TOTAL_PREPARE_STAGES,
      );

      // --- Pseudo-stage: stream referenced media zip→R2 staging ---
      stageIndex++;
      yield* this.stageMediaToR2(batch, zipDir, stageIndex);

      // --- Stage: classify ---
      stageIndex++;
      yield* this.runStage(
        PREPARE_SPAWN_STAGES[1].name,
        PREPARE_SPAWN_STAGES[1].script,
        env,
        stageIndex,
        TOTAL_PREPARE_STAGES,
      );

      // Everything the finalize half needs must be durable before we pause —
      // the confirm request may hit a different instance (or a different day).
      await this.persistWorkspace(batch);
      const posts = (await this.readClassified(batch)) ?? [];
      await this.writeState(batch, 'review', posts.length);
      yield { type: 'ready-for-review', batch, posts };
    } catch (err) {
      const event = this.toFailureEvent(err);
      // 'failed' (not silence): the zip is still in R2, so the admin can retry
      // the prepare half from the pending list without re-uploading 800MB.
      await this.writeState(batch, 'failed', 0, event.summary).catch(() => {});
      yield event;
    } finally {
      this.running.delete(batch);
    }
  }

  async *runFinalizePipeline(
    batch: string,
    edits: CategoryEdit[],
  ): AsyncGenerator<PipelineEvent> {
    this.capturedOutput = [];
    const env = { ...process.env, BATCH: batch };
    let stageIndex = 0;
    this.running.add(batch);
    let postCount = 0;

    try {
      // Local disk is a fresh scratchpad on whatever instance we landed on —
      // pull the batch's JSON artifacts down from R2 before running anything.
      const hydrated = await this.hydrateWorkspace(batch);
      yield {
        type: 'log',
        stage: 'review',
        stream: 'stdout',
        line: `Hydrated ${hydrated} workspace file(s) from R2`,
      };

      if (edits.length > 0) {
        const applied = await this.applyCategoryEdits(batch, edits);
        yield {
          type: 'log',
          stage: 'review',
          stream: 'stdout',
          line: `Applied ${applied} category edit(s) to classified.json`,
        };
      }

      postCount = ((await this.readClassified(batch)) ?? []).length;
      await this.writeState(batch, 'finalizing', postCount);

      for (const stage of FINALIZE_SPAWN_STAGES) {
        stageIndex++;
        yield* this.runStage(
          stage.name,
          stage.script,
          env,
          stageIndex,
          TOTAL_FINALIZE_STAGES,
        );
      }

      // --- Pseudo-stage: publish media (staging→final copy + DB URI rewrite) ---
      stageIndex++;
      yield* this.publishMedia(batch, stageIndex);

      for (const stage of FINALIZE_SPAWN_STAGES_AFTER_PUBLISH) {
        stageIndex++;
        yield* this.runStage(
          stage.name,
          stage.script,
          env,
          stageIndex,
          TOTAL_FINALIZE_STAGES,
        );
      }

      await this.persistWorkspace(batch);
      const summary = parseImportSummary(this.capturedOutput);
      await this.writeState(batch, 'done', postCount, summary);

      // The zip and staged media served their purpose; the small workspace
      // JSONs stay behind as the batch's audit trail.
      await this.r2.delete(this.zipKey(batch));
      const cleaned = await this.r2.deletePrefix(this.stagingPrefix(batch));
      yield {
        type: 'log',
        stage: 'cleanup',
        stream: 'stdout',
        line: `Removed upload.zip and ${cleaned} staged media object(s) from R2`,
      };

      yield { type: 'done', success: true, summary };
    } catch (err) {
      const event = this.toFailureEvent(err);
      // Back to 'review' rather than 'failed': the categories are still valid,
      // so the admin can reopen the batch and retry the finalize half without
      // re-uploading the zip or paying for classification again.
      await this.writeState(batch, 'review', postCount, event.summary).catch(
        () => {},
      );
      yield event;
    } finally {
      this.running.delete(batch);
      // In `finally`, not just the success path: 06_import writes its rows
      // before publish/trips/geocode run, so a batch that fails in a later
      // stage still leaves new posts in Supabase (same reason cancelBatch
      // refuses to undo them). Refreshing after a failure that happened
      // *before* 06_import is a harmless no-op.
      await this.stats.refreshAfterMutation(`fb import batch ${batch}`);
      // The ETL wrote posts straight to Supabase, bypassing the FbPostsService
      // paths that normally drop this key, so the Personal Best cache would
      // otherwise serve stale data until its (now day-long) TTL expired. Clear
      // it here so an import shows up immediately. Best-effort, per-instance.
      await this.cache
        .del(`pb:${process.env.USER_ID}`)
        .catch(() => undefined);
    }
  }

  /**
   * Streams every media file the ingested posts reference from the uploaded
   * zip into pending-imports/<batch>/media-staging/. Staging (not the final
   * keys) so cancelling a batch can wipe its prefix without ever touching
   * media that earlier imports already published.
   */
  private async *stageMediaToR2(
    batch: string,
    zipDir: Awaited<ReturnType<typeof openZipFromR2>>,
    stageIndex: number,
  ): AsyncGenerator<PipelineEvent> {
    const stage = 'media_stage';
    yield {
      type: 'stage-start',
      stage,
      index: stageIndex,
      total: TOTAL_PREPARE_STAGES,
    };

    const mediaJson = this.localWorkspacePath(batch, {
      file: 'media.json',
      dir: 'etl_local/01_ingest/output',
    });
    const media = JSON.parse(
      fs.readFileSync(mediaJson, 'utf8'),
    ) as MediaRecord[];
    const uris = [...new Set(media.map((m) => m.uri).filter(Boolean))];
    const entries = mediaEntries(zipDir);

    yield {
      type: 'log',
      stage,
      stream: 'stdout',
      line: `Staging ${uris.length} unique media file(s) → R2 (${MEDIA_CONCURRENCY} at a time)...`,
    };

    let uploaded = 0;
    let skipped = 0;
    const missing: string[] = [];
    const failed: string[] = [];

    // Chunked rather than a free-running pool so progress logs interleave with
    // the work instead of arriving in one burst at the end.
    for (let i = 0; i < uris.length; i += MEDIA_CONCURRENCY) {
      const chunk = uris.slice(i, i + MEDIA_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (uri) => {
          const entry = entries.get(uri);
          if (!entry) return { uri, status: 'missing' as const };
          const destKey = `${this.stagingPrefix(batch)}${uri}`;
          // Retried prepares skip what an earlier attempt already moved.
          if (await this.r2.exists(destKey)) {
            return { uri, status: 'skipped' as const };
          }
          try {
            // Hundreds of ranged reads over a long request WILL hit the odd
            // dropped connection — retry per file instead of failing the run.
            await this.withRetries(
              () => streamEntryToR2(this.r2, entry, destKey),
              3,
            );
            return { uri, status: 'uploaded' as const };
          } catch (err) {
            return {
              uri,
              status: 'failed' as const,
              message: (err as Error).message,
            };
          }
        }),
      );
      for (const r of results) {
        if (r.status === 'missing') {
          missing.push(r.uri);
          yield {
            type: 'log',
            stage,
            stream: 'stderr',
            line: `⚠️ Not in zip: ${r.uri}`,
          };
        } else if (r.status === 'failed') {
          failed.push(r.uri);
          yield {
            type: 'log',
            stage,
            stream: 'stderr',
            line: `❌ Failed after retries: ${r.uri} — ${r.message}`,
          };
        } else if (r.status === 'skipped') {
          skipped++;
        } else {
          uploaded++;
        }
      }
      yield {
        type: 'log',
        stage,
        stream: 'stdout',
        line: `   ${Math.min(i + MEDIA_CONCURRENCY, uris.length)}/${uris.length} processed`,
      };
    }

    yield {
      type: 'log',
      stage,
      stream: 'stdout',
      line: `✅ Media staged — ${uploaded} uploaded, ${skipped} already present, ${missing.length} missing, ${failed.length} failed`,
    };

    // Fail the stage only after every file had its chance: the staged ones
    // are durable in R2, so the admin's retry only re-transfers the failures.
    if (failed.length > 0) {
      throw new Error(
        `${failed.length} 個媒體檔案上傳失敗（已完成 ${uploaded + skipped} 個，重試會從中斷處續傳）。`,
      );
    }
    yield { type: 'stage-end', stage, exitCode: 0 };
  }

  /** Linear-backoff retry for the flaky parts of long R2 transfers. */
  private async withRetries<T>(
    fn: () => Promise<T>,
    attempts: number,
  ): Promise<T> {
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i < attempts) {
          await new Promise((r) => setTimeout(r, i * 2000));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Replaces utils/upload-to-r2.js for the cloud flow. The media files are
   * already in this batch's R2 staging area, and their final key IS their
   * relative URI — so "uploading" is a server-side copy, followed by the same
   * DB rewrite the local script does (relative URI → public URL).
   */
  private async *publishMedia(
    batch: string,
    stageIndex: number,
  ): AsyncGenerator<PipelineEvent> {
    const stage = 'publish_media';
    yield {
      type: 'stage-start',
      stage,
      index: stageIndex,
      total: TOTAL_FINALIZE_STAGES,
    };

    const userId = process.env.USER_ID;
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!userId || !publicUrl) {
      throw new Error('缺少 USER_ID 或 R2_PUBLIC_URL 環境變數。');
    }

    const postsJson = this.localWorkspacePath(batch, {
      file: 'posts.json',
      dir: 'etl_local/01_ingest/output',
    });
    const timestamps = (
      JSON.parse(fs.readFileSync(postsJson, 'utf8')) as { timestamp: number }[]
    ).map((p) => p.timestamp);

    const { data: posts, error } = await this.supabase
      .getClient()
      .from('fb_posts')
      .select('fb_timestamp, media')
      .eq('user_id', userId)
      .in('fb_timestamp', timestamps);
    if (error) throw new Error(`讀取貼文失敗：${error.message}`);

    const uris = new Set<string>();
    for (const post of posts ?? []) {
      for (const m of (post.media ?? []) as MediaRecord[]) {
        if (m.uri && !m.uri.startsWith('http')) uris.add(m.uri);
      }
    }
    yield {
      type: 'log',
      stage,
      stream: 'stdout',
      line: `Publishing ${uris.size} media file(s) for ${posts?.length ?? 0} post(s)...`,
    };

    const urlMap = new Map<string, string>();
    let copied = 0;
    let existed = 0;
    const missing: string[] = [];
    const uriList = [...uris];

    for (let i = 0; i < uriList.length; i += MEDIA_CONCURRENCY) {
      const chunk = uriList.slice(i, i + MEDIA_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (uri) => {
          if (await this.r2.exists(uri)) return { uri, status: 'existed' as const };
          const stagingKey = `${this.stagingPrefix(batch)}${uri}`;
          if (!(await this.r2.exists(stagingKey))) {
            return { uri, status: 'missing' as const };
          }
          await this.r2.copy(stagingKey, uri);
          return { uri, status: 'copied' as const };
        }),
      );
      for (const r of results) {
        if (r.status === 'missing') {
          missing.push(r.uri);
          yield {
            type: 'log',
            stage,
            stream: 'stderr',
            line: `⚠️ Missing from staging and final: ${r.uri}`,
          };
          continue;
        }
        if (r.status === 'copied') copied++;
        else existed++;
        urlMap.set(r.uri, `${publicUrl}/${r.uri}`);
      }
    }

    // Same rewrite the local script does — only posts that actually changed.
    let updateCount = 0;
    for (const post of posts ?? []) {
      let changed = false;
      const updatedMedia = ((post.media ?? []) as MediaRecord[]).map((m) => {
        if (m.uri && !m.uri.startsWith('http') && urlMap.has(m.uri)) {
          changed = true;
          return { ...m, uri: urlMap.get(m.uri)! };
        }
        return m;
      });
      if (!changed) continue;
      const { error: updateError } = await this.supabase
        .getClient()
        .from('fb_posts')
        .update({ media: updatedMedia })
        .eq('user_id', userId)
        .eq('fb_timestamp', post.fb_timestamp);
      if (updateError) {
        throw new Error(
          `更新貼文 ${post.fb_timestamp} 的媒體連結失敗：${updateError.message}`,
        );
      }
      updateCount++;
    }

    yield {
      type: 'log',
      stage,
      stream: 'stdout',
      line: `✅ Published — ${copied} copied, ${existed} already live, ${missing.length} missing; ${updateCount} post(s) updated`,
    };
    yield { type: 'stage-end', stage, exitCode: 0 };
  }

  /**
   * Discards an unfinished batch: its whole pending-imports/<batch>/ prefix in
   * R2 (zip, staged media, workspace) plus any local working dirs on this
   * machine. Rows already written to Supabase by 06_import are NOT touched —
   * cancel is about reclaiming storage and clearing the resume list, not
   * undoing an import. Staged media never reached the final keys, so this
   * cannot orphan any published post's files.
   */
  async cancelBatch(
    batch: string,
  ): Promise<{ removed: string[]; r2Objects: number }> {
    if (this.running.has(batch)) {
      throw new ConflictException(
        '這個批次正在執行中，請等它結束或失敗後再取消。',
      );
    }

    const r2Objects = await this.r2.deletePrefix(`${R2_ROOT}/${batch}/`);

    const removed: string[] = [];
    for (const dir of BATCH_DIRS) {
      const target = path.join(this.repoRoot, dir, batch);
      if (!fs.existsSync(target)) continue;
      this.moveToTrash(target);
      removed.push(`${dir}/${batch}`);
    }

    this.logger.log(
      `Cancelled batch ${batch} — ${r2Objects} R2 object(s), ${removed.length} local dir(s)`,
    );
    return { removed, r2Objects };
  }

  /**
   * Prefers the system Trash so a mis-click stays recoverable on a dev
   * machine; inside the Cloud Run container there is no `trash`, and rmSync
   * on tmpfs is exactly right.
   */
  private moveToTrash(target: string): void {
    try {
      execFileSync('trash', [target], { stdio: 'ignore' });
    } catch {
      this.logger.warn(`trash unavailable — deleting ${target} outright`);
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  /**
   * Weekly janitor for pending-imports/. Two kinds of leftovers accumulate:
   * finished batches (audit JSONs, kept 30 days) and abandoned uploads —
   * a zip PUT via presigned URL whose prepare was never run, invisible in the
   * admin UI because it has no state.json. Unfinished batches the admin can
   * still see (review/failed/finalizing) are never auto-deleted.
   */
  @Cron('0 4 * * 1')
  async sweepStaleBatches(): Promise<void> {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    let swept = 0;

    try {
      const prefixes = await this.r2.listPrefixes(`${R2_ROOT}/`);
      for (const prefix of prefixes) {
        const batch = prefix.slice(`${R2_ROOT}/`.length).replace(/\/$/, '');
        if (this.running.has(batch)) continue;

        const state = await this.readState(batch);
        if (state) {
          if (state.phase !== 'done') continue;
          if (now - Date.parse(state.updatedAt) < 30 * DAY) continue;
        } else {
          const uploadedAt = await this.r2.lastModified(this.zipKey(batch));
          // No state and no zip: nothing usable — sweep. With a recent zip:
          // an upload whose prepare may still be coming — leave it a week.
          if (uploadedAt && now - uploadedAt.getTime() < 7 * DAY) continue;
        }

        const n = await this.r2.deletePrefix(prefix);
        swept += n;
        this.logger.log(
          `Swept stale import batch ${batch} (${state?.phase ?? 'no state'}) — ${n} object(s)`,
        );
      }
    } catch (err) {
      this.logger.warn(`Stale batch sweep failed: ${(err as Error).message}`);
    }

    if (swept > 0) this.logger.log(`Sweep removed ${swept} R2 object(s)`);
  }

  /** Batches that were prepared but never finished, newest first. */
  async listResumableBatches(): Promise<ImportState[]> {
    const prefixes = await this.r2.listPrefixes(`${R2_ROOT}/`);
    const states = await Promise.all(
      prefixes.map((p) => {
        const batch = p.slice(`${R2_ROOT}/`.length).replace(/\/$/, '');
        return this.readState(batch);
      }),
    );
    return states
      .filter((s): s is ImportState => s !== null && s.phase !== 'done')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async readReview(
    batch: string,
  ): Promise<{ state: ImportState; posts: ReviewPost[] } | null> {
    const state = await this.readState(batch);
    if (!state) return null;
    return { state, posts: (await this.readClassified(batch)) ?? [] };
  }

  private toFailureEvent(err: unknown): {
    type: 'done';
    success: false;
    summary: string;
  } {
    if (err instanceof StageFailedError) {
      return {
        type: 'done',
        success: false,
        summary: `階段「${err.stage}」失敗（exit code ${err.exitCode}）。流程已中止，後續階段未執行。`,
      };
    }
    return {
      type: 'done',
      success: false,
      summary: `發生非預期錯誤：${(err as Error).message}`,
    };
  }

  /** classified.json from R2 — the durable copy the review step works on. */
  private async readClassified(batch: string): Promise<ReviewPost[] | null> {
    return this.r2.getJson<ReviewPost[]>(
      this.workspaceKey(batch, 'classified.json'),
    );
  }

  private async readState(batch: string): Promise<ImportState | null> {
    try {
      return await this.r2.getJson<ImportState>(this.stateKey(batch));
    } catch (err) {
      this.logger.warn(
        `Failed to read state for ${batch}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async writeState(
    batch: string,
    phase: ImportPhase,
    postCount: number,
    summary?: string,
  ): Promise<void> {
    const state: ImportState = {
      batch,
      phase,
      postCount,
      updatedAt: new Date().toISOString(),
      ...(summary ? { summary } : {}),
    };
    await this.r2.putJson(this.stateKey(batch), state);
  }

  /** Uploads whichever stage artifacts exist locally to the R2 workspace. */
  private async persistWorkspace(batch: string): Promise<number> {
    let count = 0;
    for (const entry of WORKSPACE_FILES) {
      const local = this.localWorkspacePath(batch, entry);
      if (!fs.existsSync(local)) continue;
      await this.r2.upload(
        this.workspaceKey(batch, entry.file),
        fs.readFileSync(local),
        'application/json',
      );
      count++;
    }
    return count;
  }

  /** Downloads the R2 workspace into the local paths the stage scripts read. */
  private async hydrateWorkspace(batch: string): Promise<number> {
    const keys = new Set(
      await this.r2.list(`${R2_ROOT}/${batch}/workspace/`),
    );
    let count = 0;
    for (const entry of WORKSPACE_FILES) {
      const key = this.workspaceKey(batch, entry.file);
      if (!keys.has(key)) continue;
      const json = await this.r2.getJson<unknown>(key);
      if (json === null) continue;
      const local = this.localWorkspacePath(batch, entry);
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, JSON.stringify(json, null, 2));
      count++;
    }
    return count;
  }

  /**
   * Rewrites the admin's category corrections into classified.json — both the
   * local copy the analyze stages read and the durable one in R2. Returns how
   * many edits were applied.
   */
  private async applyCategoryEdits(
    batch: string,
    edits: CategoryEdit[],
  ): Promise<number> {
    const posts = (await this.readClassified(batch)) ?? [];
    const byTimestamp = new Map(posts.map((p) => [p.timestamp, p]));

    let applied = 0;
    for (const edit of edits) {
      const post = byTimestamp.get(edit.timestamp);
      if (!post) {
        this.logger.warn(
          `Edit for timestamp ${edit.timestamp} has no matching post — ignored`,
        );
        continue;
      }
      if (!VALID_CATEGORIES.includes(edit.category)) {
        this.logger.warn(
          `Edit for ${edit.timestamp} has invalid category "${edit.category}" — ignored`,
        );
        continue;
      }
      post.category = edit.category;
      post.sub_categories = edit.sub_categories ?? [];
      applied++;
    }

    if (applied > 0) {
      const serialized = JSON.stringify(posts, null, 2);
      const local = this.localWorkspacePath(batch, {
        file: 'classified.json',
        dir: 'etl_local/02_classify/output',
      });
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, serialized);
      await this.r2.putJson(this.workspaceKey(batch, 'classified.json'), posts);
    }
    return applied;
  }

  private async *runStage(
    stage: string,
    scriptRelPath: string,
    env: NodeJS.ProcessEnv,
    index: number,
    total: number,
  ): AsyncGenerator<PipelineEvent> {
    yield { type: 'stage-start', stage, index, total };

    const scriptPath = path.join(this.repoRoot, scriptRelPath);
    const child = spawn(process.execPath, [scriptPath], {
      cwd: this.repoRoot,
      env,
    });

    // Bridge the event-based child process into an async-pull queue so the
    // generator can yield events as they arrive in real time.
    const queue: PipelineEvent[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let exitCode: number | null = null;

    const push = (ev: PipelineEvent) => {
      queue.push(ev);
      if (wake) {
        wake();
        wake = null;
      }
    };

    const wireStream = (
      stream: NodeJS.ReadableStream,
      name: 'stdout' | 'stderr',
    ) => {
      let buf = '';
      stream.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          this.capturedOutput.push(line);
          push({ type: 'log', stage, stream: name, line });
        }
      });
      stream.on('end', () => {
        if (buf) {
          this.capturedOutput.push(buf);
          push({ type: 'log', stage, stream: name, line: buf });
        }
      });
    };
    wireStream(child.stdout, 'stdout');
    wireStream(child.stderr, 'stderr');

    child.on('close', (code) => {
      exitCode = code ?? 1;
      finished = true;
      if (wake) {
        wake();
        wake = null;
      }
    });
    child.on('error', (err) => {
      push({ type: 'error', stage, message: err.message });
      exitCode = 1;
      finished = true;
      if (wake) {
        wake();
        wake = null;
      }
    });

    while (!finished || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      yield queue.shift()!;
    }

    yield { type: 'stage-end', stage, exitCode: exitCode ?? 1 };
    if (exitCode !== 0) throw new StageFailedError(stage, exitCode ?? 1);
  }
}
