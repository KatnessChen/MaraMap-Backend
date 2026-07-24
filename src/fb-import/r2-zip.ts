import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';
import { pipeline } from 'stream/promises';
import * as unzipper from 'unzipper';
import { R2Service } from '../storage/r2.service';

/**
 * Facebook's DYI export keeps every media file under this folder, and the
 * final R2 object key for a media file IS its zip-internal path from this
 * marker onward (utils/upload-to-r2.js established that convention) — so the
 * cloud pipeline can move media from the uploaded zip to their final keys
 * without inventing any name mapping.
 */
export const MEDIA_MARKER = 'your_facebook_activity/posts/media/';

export interface JsonExtractResult {
  fileCount: number;
  warnings: string[];
}

/**
 * Opens a zip that lives in R2 without downloading it: unzipper reads the
 * central directory and each entry through byte-range GETs. This is what
 * lifts the import's size ceiling — the container never holds the archive,
 * only one entry's bytes in transit.
 */
export async function openZipFromR2(
  r2: R2Service,
  key: string,
): Promise<unzipper.CentralDirectory> {
  const size = await r2.headSize(key);
  return unzipper.Open.custom({
    size: async () => size,
    // Must return a stream synchronously while GetObject is async — bridge
    // with a PassThrough and surface fetch errors as stream errors.
    stream: (offset: number, length: number) => {
      const out = new PassThrough();
      const end = length ? String(offset + length - 1) : '';
      r2.getStream(key, `bytes=${offset}-${end}`)
        .then((body) => {
          // .pipe() does NOT forward source errors. Without this handler a
          // single dropped connection mid-transfer leaves the consumer
          // waiting on a stream that never ends or errors (observed: media
          // staging frozen at 72/277 with zero open sockets).
          body.on('error', (err: Error) => out.destroy(err));
          body.pipe(out);
        })
        .catch((err: Error) => out.destroy(err));
      return out;
    },
  });
}

/**
 * Entry path with the same mojibake fallback zip-extractor.ts uses for local
 * uploads: some re-zipped exports lack the UTF-8 flag, turning CJK folder
 * names into garbage under the default decode.
 */
export function entryPath(file: unzipper.File): string {
  if (file.isUnicode) return file.path;
  const utf8 = file.pathBuffer.toString('utf8');
  return utf8.includes('�') ? file.pathBuffer.toString('latin1') : utf8;
}

/**
 * Extracts only the *.json entries to destDir, preserving the internal
 * folder structure so 01_ingest's recursive search finds the posts file.
 * JSONs are the only part of the export the ETL scripts read from disk —
 * media never needs to touch the filesystem (see mediaEntries / MEDIA_MARKER).
 */
export async function extractJsonEntries(
  directory: unzipper.CentralDirectory,
  destDir: string,
): Promise<JsonExtractResult> {
  const destRoot = path.resolve(destDir);
  const warnings: string[] = [];
  const targets: { file: unzipper.File; destPath: string }[] = [];

  for (const file of directory.files) {
    if (file.type !== 'File') continue;
    const name = entryPath(file);
    if (!name.toLowerCase().endsWith('.json')) continue;

    const relParts = name.split('/').filter(Boolean); // zip spec always uses '/'
    const destPath = path.resolve(destRoot, ...relParts);
    if (!destPath.startsWith(destRoot + path.sep)) {
      warnings.push(`Skipped suspicious entry path: ${name}`);
      continue;
    }
    if (name.includes('�')) {
      warnings.push(`Possible filename encoding issue: ${name}`);
    }
    targets.push({ file, destPath });
  }

  // Each entry costs a full R2 round-trip, so sequential extraction is
  // latency-bound (~50s for a real export's 150 JSONs). A small concurrent
  // window brings that to a few seconds; the files themselves are tiny.
  const WINDOW = 8;
  for (let i = 0; i < targets.length; i += WINDOW) {
    await Promise.all(
      targets.slice(i, i + WINDOW).map(async ({ file, destPath }) => {
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
        await pipeline(file.stream(), fs.createWriteStream(destPath));
      }),
    );
  }

  return { fileCount: targets.length, warnings };
}

/**
 * Media entries indexed by their relative URI (the path from
 * `your_facebook_activity/posts/media/` onward) — the exact string ingest's
 * media.json records in `uri`, and the final R2 key convention.
 */
export function mediaEntries(
  directory: unzipper.CentralDirectory,
): Map<string, unzipper.File> {
  const index = new Map<string, unzipper.File>();
  for (const file of directory.files) {
    if (file.type !== 'File') continue;
    const name = entryPath(file);
    const idx = name.indexOf(MEDIA_MARKER);
    if (idx === -1) continue;
    const relativeUri = name.slice(idx);
    if (!index.has(relativeUri)) index.set(relativeUri, file);
  }
  return index;
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

export function contentTypeFor(filePath: string): string {
  return (
    CONTENT_TYPES[path.extname(filePath).toLowerCase()] ||
    'application/octet-stream'
  );
}

/** Streams one zip entry straight into an R2 object — no temp file. */
export async function streamEntryToR2(
  r2: R2Service,
  file: unzipper.File,
  destKey: string,
): Promise<void> {
  await r2.uploadStream(destKey, file.stream(), contentTypeFor(destKey));
}
