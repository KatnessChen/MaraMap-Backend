export interface SkippedPost {
  timestamp: number;
  date: string;
  title: string | null;
  text: string | null;
}

export interface RescuedPost {
  timestamp: number;
  category: string;
  sub_categories?: string[];
}

export type PipelineEvent =
  | { type: 'stage-start'; stage: string; index: number; total: number }
  | { type: 'log'; stage: string; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'stage-end'; stage: string; exitCode: number }
  | { type: 'error'; stage: string; message: string }
  | { type: 'ready-for-review'; batch: string; skipped: SkippedPost[] }
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
 * every other stage is an intermediate step.
 */
export function parseImportSummary(lines: string[]): string {
  for (const line of lines) {
    const inserted = line.match(/^✅ Inserted (\d+) new record/);
    if (inserted) return `匯入完成 — 新增 ${inserted[1]} 篇文章。`;
    if (line.startsWith('✅ Nothing new to import')) {
      return '匯入完成 — 沒有新文章（皆已存在）。';
    }
  }
  return '匯入流程已結束，但找不到 06_import 的摘要訊息，請檢查上方日誌。';
}
