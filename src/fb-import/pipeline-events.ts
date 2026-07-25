/** A post as shown in the review step, carrying the AI's guess for editing. */
export interface ReviewPost {
  timestamp: number;
  date: string;
  title: string | null;
  text: string | null;
  category: string;
  sub_categories: string[];
  // Staged-media URLs for the review preview. The bytes live under this batch's
  // R2 media-staging prefix (public but at an unguessable key) until confirm
  // publishes them to their final keys — so the admin can eyeball photos before
  // committing the import.
  media?: { url: string; type: string }[];
}

/** An admin's correction to one post's classification. */
export interface CategoryEdit {
  timestamp: number;
  category: string;
  sub_categories?: string[];
}

export type ImportPhase = 'review' | 'finalizing' | 'done' | 'failed';

/**
 * Per-batch progress marker on disk. Its only job is to let the admin close
 * the browser mid-import and pick the batch back up later — every other piece
 * of state already lives in the stage output files.
 */
export interface ImportState {
  batch: string;
  phase: ImportPhase;
  postCount: number;
  updatedAt: string;
  summary?: string;
}

export type PipelineEvent =
  | { type: 'stage-start'; stage: string; index: number; total: number }
  | { type: 'log'; stage: string; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'stage-end'; stage: string; exitCode: number }
  | { type: 'error'; stage: string; message: string }
  | { type: 'ready-for-review'; batch: string; posts: ReviewPost[] }
  | { type: 'done'; success: boolean; summary: string };

export class StageFailedError extends Error {
  constructor(
    public readonly stage: string,
    public readonly exitCode: number,
  ) {
    super(`Stage "${stage}" exited with code ${exitCode}`);
  }
}

/**
 * Derives a user-facing summary from 06_import's captured stdout lines.
 * That stage is the only one whose completion count matters to the admin —
 * every other stage is an intermediate step. Surfaces both the number of new
 * posts inserted and the number already in the DB (skipped), so a re-import of
 * an overlapping export reads as "nothing new because they already exist"
 * rather than an unexplained low insert count.
 */
export function parseImportSummary(lines: string[]): string {
  let inserted: number | null = null;
  let skipped: number | null = null;
  let nothingNew = false;

  for (const line of lines) {
    const i = line.match(/Inserted (\d+) new record/);
    if (i) inserted = Number(i[1]);
    const s = line.match(/Skipping (\d+) post\(s\) already in the database/);
    if (s) skipped = Number(s[1]);
    if (line.includes('Nothing new to import')) nothingNew = true;
  }

  const existedNote =
    skipped && skipped > 0 ? `，另有 ${skipped} 篇已存在資料庫、略過` : '';

  if (inserted !== null && inserted > 0) {
    return `匯入完成 — 新增 ${inserted} 篇文章${existedNote}。`;
  }
  if (nothingNew || inserted === 0) {
    return skipped && skipped > 0
      ? `匯入完成 — 沒有新文章，${skipped} 篇皆已存在資料庫。`
      : '匯入完成 — 沒有新文章。';
  }
  return '匯入流程已結束，但找不到 06_import 的摘要訊息，請檢查上方日誌。';
}
