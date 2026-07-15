import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { extractFacebookZip } from './zip-extractor';
import {
  PipelineEvent,
  RescuedPost,
  SkippedPost,
  StageFailedError,
  parseImportSummary,
} from './pipeline-events';

interface Stage {
  name: string;
  script: string;
}

// 01_ingest runs right after unzip and is handled explicitly in
// runPreparePipeline; everything below runs in order after it, ending at
// 05_merge where the pipeline pauses for the admin's skip-rescue review.
const PREPARE_STAGES: Stage[] = [
  { name: '02_classify', script: 'etl/02_classify/ai-classify.js' },
  { name: '03_analyze_base', script: 'etl/03_analyze/00_base/analyze.js' },
  {
    name: '03_analyze_marathon',
    script: 'etl/03_analyze/01_marathon/analyze.js',
  },
  { name: '03_analyze_hiking', script: 'etl/03_analyze/02_hiking/analyze.js' },
  { name: '04_format', script: 'etl/04_format/analyze.js' },
  { name: '05_merge', script: 'etl/05_merge/merge.js' },
];

// Resumes after the admin confirms which skipped posts to rescue.
const FINALIZE_STAGES: Stage[] = [
  { name: '06_import', script: 'etl/06_import/import-to-supabase.js' },
  { name: 'r2_upload', script: 'utils/upload-to-r2.js' },
  { name: '07_trips', script: 'etl/07_trips/assign-trips.js' },
  { name: '08_geocode', script: 'etl/08_geocode/geocode-fallback.js' },
];

// unzip + 01_ingest + PREPARE_STAGES
const TOTAL_PREPARE_STAGES = 2 + PREPARE_STAGES.length;
const TOTAL_FINALIZE_STAGES = FINALIZE_STAGES.length;

@Injectable()
export class FbImportService {
  private readonly logger = new Logger(FbImportService.name);
  private readonly repoRoot = process.cwd();
  private capturedOutput: string[] = [];

  isEtlAvailable(): boolean {
    return fs.existsSync(
      path.join(this.repoRoot, 'etl', '01_ingest', 'ingest-fb-data.js'),
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

    try {
      // --- Pseudo-stage: unzip ---
      stageIndex++;
      yield {
        type: 'stage-start',
        stage: 'unzip',
        index: stageIndex,
        total: TOTAL_PREPARE_STAGES,
      };
      const rawDir = path.join(this.repoRoot, 'etl/01_ingest/raw', batch);
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
        'etl/01_ingest/ingest-fb-data.js',
        env,
        stageIndex,
        TOTAL_PREPARE_STAGES,
      );

      // --- Classify → analyze → format → merge ---
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

      yield {
        type: 'ready-for-review',
        batch,
        skipped: this.readSkippedPosts(batch),
      };
    } catch (err) {
      yield this.toFailureEvent(err);
    } finally {
      await fs.promises.unlink(uploadedZipPath).catch(() => {});
    }
  }

  async *runFinalizePipeline(
    batch: string,
    rescued: RescuedPost[],
  ): AsyncGenerator<PipelineEvent> {
    this.capturedOutput = [];
    const env = { ...process.env, BATCH: batch };
    let stageIndex = 0;

    try {
      if (rescued.length > 0) {
        const applied = this.applyRescuedPosts(batch, rescued);
        yield {
          type: 'log',
          stage: 'rescue',
          stream: 'stdout',
          line: `Merged ${applied} rescued post(s) into merged.json`,
        };
      }

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

      yield {
        type: 'done',
        success: true,
        summary: parseImportSummary(this.capturedOutput),
      };
    } catch (err) {
      yield this.toFailureEvent(err);
    }
  }

  private toFailureEvent(err: unknown): PipelineEvent {
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

  private readSkippedPosts(batch: string): SkippedPost[] {
    const file = path.join(
      this.repoRoot,
      'etl/02_classify/output',
      batch,
      'skipped.json',
    );
    if (!fs.existsSync(file)) return [];
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      this.logger.warn(`Failed to parse ${file}: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Merges admin-rescued posts (assigned a category by hand, no AI
   * re-analysis) into merged.json before 06_import runs. Returns the number
   * of posts actually applied.
   */
  private applyRescuedPosts(batch: string, rescued: RescuedPost[]): number {
    const mergedPath = path.join(
      this.repoRoot,
      'etl/05_merge/output',
      batch,
      'merged.json',
    );
    const merged: any[] = fs.existsSync(mergedPath)
      ? JSON.parse(fs.readFileSync(mergedPath, 'utf8'))
      : [];

    const skippedByTs = new Map(
      this.readSkippedPosts(batch).map((p) => [p.timestamp, p]),
    );

    let applied = 0;
    for (const r of rescued) {
      const source = skippedByTs.get(r.timestamp);
      if (!source) {
        this.logger.warn(
          `Rescued timestamp ${r.timestamp} not found in skipped.json — skipping`,
        );
        continue;
      }
      merged.push({
        timestamp: source.timestamp,
        date: source.date,
        text: source.text,
        title: source.title,
        category: r.category,
        sub_categories: r.sub_categories ?? [],
        metadata: {},
      });
      applied++;
    }

    if (applied > 0) {
      fs.mkdirSync(path.dirname(mergedPath), { recursive: true });
      fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2));
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
