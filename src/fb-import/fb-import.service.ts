import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { execFileSync, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { extractFacebookZip } from './zip-extractor';
import { StatsService } from '../stats/stats.service';
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
const PREPARE_STAGES: Stage[] = [
  { name: '02_classify', script: 'etl_local/02_classify/ai-classify.js' },
];

// Resumes once the admin confirms the categories.
const FINALIZE_STAGES: Stage[] = [
  { name: '03_analyze_base', script: 'etl_local/03_analyze/00_base/analyze.js' },
  {
    name: '03_analyze_marathon',
    script: 'etl_local/03_analyze/01_marathon/analyze.js',
  },
  { name: '03_analyze_hiking', script: 'etl_local/03_analyze/02_hiking/analyze.js' },
  { name: '04_format', script: 'etl_local/04_format/analyze.js' },
  { name: '05_merge', script: 'etl_local/05_merge/merge.js' },
  { name: '06_import', script: 'etl_local/06_import/import-to-supabase.js' },
  { name: 'r2_upload', script: 'utils/upload-to-r2.js' },
  { name: '07_trips', script: 'etl_local/07_trips/assign-trips.js' },
  { name: '08_geocode', script: 'etl_local/08_geocode/geocode-fallback.js' },
];

// unzip + 01_ingest + PREPARE_STAGES
const TOTAL_PREPARE_STAGES = 2 + PREPARE_STAGES.length;
const TOTAL_FINALIZE_STAGES = FINALIZE_STAGES.length;

const VALID_CATEGORIES = ['馬拉松', '登山', '旅遊'];

// Every directory a batch writes into, so cancelling one leaves nothing behind.
// raw/ dominates the footprint — a real export unpacks to a few GB.
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

@Injectable()
export class FbImportService {
  private readonly logger = new Logger(FbImportService.name);
  private readonly repoRoot = process.cwd();
  private capturedOutput: string[] = [];
  // Batches with a pipeline attached right now — cancelling one would pull the
  // stage output files out from under a running child process.
  private readonly running = new Set<string>();

  constructor(private readonly stats: StatsService) {}

  isEtlAvailable(): boolean {
    return fs.existsSync(
      path.join(this.repoRoot, 'etl_local', '01_ingest', 'ingest-fb-data.js'),
    );
  }

  generateBatchName(): string {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');
    const suffix = crypto.randomBytes(3).toString('hex');
    return `admin-import-${stamp}-${suffix}`;
  }

  async *runPreparePipeline(
    batch: string,
    uploadedZipPath: string,
  ): AsyncGenerator<PipelineEvent> {
    this.capturedOutput = [];
    const env = { ...process.env, BATCH: batch };
    let stageIndex = 0;
    this.running.add(batch);

    try {
      // --- Pseudo-stage: unzip ---
      stageIndex++;
      yield {
        type: 'stage-start',
        stage: 'unzip',
        index: stageIndex,
        total: TOTAL_PREPARE_STAGES,
      };
      const rawDir = path.join(this.repoRoot, 'etl_local/01_ingest/raw', batch);
      const { fileCount, warnings } = await extractFacebookZip(
        uploadedZipPath,
        rawDir,
      );
      yield {
        type: 'log',
        stage: 'unzip',
        stream: 'stdout',
        line: `Extracted ${fileCount} file(s) to raw/${batch}/`,
      };
      for (const w of warnings) {
        yield {
          type: 'log',
          stage: 'unzip',
          stream: 'stderr',
          line: `⚠️ ${w}`,
        };
      }
      yield { type: 'stage-end', stage: 'unzip', exitCode: 0 };

      // --- Stage: ingest ---
      stageIndex++;
      yield* this.runStage(
        '01_ingest',
        'etl_local/01_ingest/ingest-fb-data.js',
        env,
        stageIndex,
        TOTAL_PREPARE_STAGES,
      );

      // --- Stage: classify ---
      for (const stage of PREPARE_STAGES) {
        stageIndex++;
        yield* this.runStage(
          stage.name,
          stage.script,
          env,
          stageIndex,
          TOTAL_PREPARE_STAGES,
        );
      }

      const posts = this.readClassified(batch);
      this.writeState(batch, 'review', posts.length);
      yield { type: 'ready-for-review', batch, posts };
    } catch (err) {
      yield this.toFailureEvent(err);
    } finally {
      this.running.delete(batch);
      await fs.promises.unlink(uploadedZipPath).catch(() => {});
    }
  }

  async *runFinalizePipeline(
    batch: string,
    edits: CategoryEdit[],
  ): AsyncGenerator<PipelineEvent> {
    this.capturedOutput = [];
    const env = { ...process.env, BATCH: batch };
    let stageIndex = 0;
    const postCount = this.readClassified(batch).length;
    this.running.add(batch);

    try {
      if (edits.length > 0) {
        const applied = this.applyCategoryEdits(batch, edits);
        yield {
          type: 'log',
          stage: 'review',
          stream: 'stdout',
          line: `Applied ${applied} category edit(s) to classified.json`,
        };
      }

      this.writeState(batch, 'finalizing', postCount);

      for (const stage of FINALIZE_STAGES) {
        stageIndex++;
        yield* this.runStage(
          stage.name,
          stage.script,
          env,
          stageIndex,
          TOTAL_FINALIZE_STAGES,
        );
      }

      const summary = parseImportSummary(this.capturedOutput);
      this.writeState(batch, 'done', postCount, summary);
      yield { type: 'done', success: true, summary };
    } catch (err) {
      const event = this.toFailureEvent(err);
      // Back to 'review' rather than 'failed': the categories are still valid,
      // so the admin can reopen the batch and retry the finalize half without
      // re-uploading the zip or paying for classification again.
      this.writeState(batch, 'review', postCount, event.summary);
      yield event;
    } finally {
      this.running.delete(batch);
      // In `finally`, not just the success path: 06_import writes its rows
      // before r2_upload/07_trips/08_geocode run, so a batch that fails in a
      // later stage still leaves new posts in Supabase (same reason cancelBatch
      // refuses to undo them). Refreshing after a failure that happened *before*
      // 06_import is a harmless no-op — a recompute over unchanged rows.
      await this.stats.refreshAfterMutation(`fb import batch ${batch}`);
    }
  }

  /**
   * Discards an unfinished batch's working files. Rows already written to
   * Supabase by 06_import are NOT touched — cancel is about reclaiming local
   * disk and clearing the resume list, not undoing an import.
   */
  cancelBatch(batch: string): { removed: string[] } {
    if (this.running.has(batch)) {
      throw new ConflictException(
        '這個批次正在執行中，請等它結束或失敗後再取消。',
      );
    }

    const removed: string[] = [];
    for (const dir of BATCH_DIRS) {
      const target = path.join(this.repoRoot, dir, batch);
      if (!fs.existsSync(target)) continue;
      this.moveToTrash(target);
      removed.push(`${dir}/${batch}`);
    }

    this.logger.log(`Cancelled batch ${batch} — ${removed.length} dir(s)`);
    return { removed };
  }

  /**
   * Prefers the system Trash so a mis-click stays recoverable: a cancelled
   * batch can hold gigabytes of extracted photos that are painful to re-upload.
   */
  private moveToTrash(target: string): void {
    try {
      execFileSync('trash', [target], { stdio: 'ignore' });
    } catch {
      this.logger.warn(`trash unavailable — deleting ${target} outright`);
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  /** Batches that were prepared but never finished, newest first. */
  listResumableBatches(): ImportState[] {
    const outputRoot = path.join(this.repoRoot, 'etl_local/02_classify/output');
    if (!fs.existsSync(outputRoot)) return [];

    return fs
      .readdirSync(outputRoot)
      .map((batch) => this.readState(batch))
      .filter((s): s is ImportState => s !== null && s.phase !== 'done')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  readReview(batch: string): { state: ImportState; posts: ReviewPost[] } | null {
    const state = this.readState(batch);
    if (!state) return null;
    return { state, posts: this.readClassified(batch) };
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

  private classifiedPath(batch: string): string {
    return path.join(
      this.repoRoot,
      'etl_local/02_classify/output',
      batch,
      'classified.json',
    );
  }

  private statePath(batch: string): string {
    return path.join(
      this.repoRoot,
      'etl_local/02_classify/output',
      batch,
      'import-state.json',
    );
  }

  private readClassified(batch: string): ReviewPost[] {
    const file = this.classifiedPath(batch);
    if (!fs.existsSync(file)) return [];
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as ReviewPost[];
    } catch (err) {
      this.logger.warn(`Failed to parse ${file}: ${(err as Error).message}`);
      return [];
    }
  }

  private readState(batch: string): ImportState | null {
    const file = this.statePath(batch);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as ImportState;
    } catch (err) {
      this.logger.warn(`Failed to parse ${file}: ${(err as Error).message}`);
      return null;
    }
  }

  private writeState(
    batch: string,
    phase: ImportPhase,
    postCount: number,
    summary?: string,
  ): void {
    const state: ImportState = {
      batch,
      phase,
      postCount,
      updatedAt: new Date().toISOString(),
      ...(summary ? { summary } : {}),
    };
    const file = this.statePath(batch);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  }

  /**
   * Rewrites the admin's category corrections into classified.json — the file
   * every downstream stage reads — so the analyze stages see the corrected
   * category rather than the AI's guess. Returns how many edits were applied.
   */
  private applyCategoryEdits(batch: string, edits: CategoryEdit[]): number {
    const posts = this.readClassified(batch);
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
      fs.writeFileSync(
        this.classifiedPath(batch),
        JSON.stringify(posts, null, 2),
      );
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
