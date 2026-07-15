import * as fs from 'fs';
import * as path from 'path';
import * as JSZip from 'jszip';

export interface ExtractResult {
  fileCount: number;
  warnings: string[];
}

function decodeZipEntryName(bytes: string[] | Uint8Array | Buffer): string {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as any);
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8; // clean UTF-8 decode, keep it
  // Some Facebook export zips (or the tools used to re-zip them) don't set the
  // UTF-8 general-purpose flag, producing mojibake for CJK folder/file names —
  // same class of bug as the JSON *content* mojibake that ingest-fb-data.js's
  // fixEncoding() (latin1→utf8) already works around. Best-effort fallback;
  // verify against a real export and adjust if names still come out garbled.
  return buf.toString('latin1');
}

/**
 * Extracts a Facebook "Download Your Information" zip into destDir,
 * preserving the internal folder structure so 01_ingest's recursive search
 * for your_posts__check_ins__photos_and_videos_1.json finds it.
 */
export async function extractFacebookZip(
  zipPath: string,
  destDir: string,
): Promise<ExtractResult> {
  const buffer = await fs.promises.readFile(zipPath);
  const zip = await JSZip.loadAsync(buffer, {
    decodeFileName: decodeZipEntryName,
  });

  const destRoot = path.resolve(destDir);
  const warnings: string[] = [];
  let fileCount = 0;

  // Sequential, not Promise.all — bounds memory given hundreds of photos/videos
  // could otherwise all be buffered in-memory simultaneously.
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;

    const relParts = entry.name.split('/').filter(Boolean); // zip spec always uses '/'
    const destPath = path.resolve(destRoot, ...relParts);

    // zip-slip guard (defense in depth — JSZip itself sanitizes `.name` on
    // loadAsync since 3.x, but this costs nothing and protects against any
    // future regression).
    if (!destPath.startsWith(destRoot + path.sep)) {
      warnings.push(`Skipped suspicious entry path: ${entry.name}`);
      continue;
    }
    if (entry.name.includes('�')) {
      warnings.push(`Possible filename encoding issue: ${entry.name}`);
    }

    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    const content = await entry.async('nodebuffer');
    await fs.promises.writeFile(destPath, content);
    fileCount++;
  }

  return { fileCount, warnings };
}
