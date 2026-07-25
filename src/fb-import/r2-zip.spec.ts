import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import * as unzipper from 'unzipper';
import {
  MEDIA_MARKER,
  contentTypeFor,
  entryPath,
  extractJsonEntries,
  mediaEntries,
  openZipFromR2,
  streamEntryToR2,
} from './r2-zip';

const fakeFile = (over: Partial<Record<string, unknown>>) =>
  ({
    type: 'File',
    isUnicode: 1,
    path: 'a.json',
    pathBuffer: Buffer.from('a.json'),
    uncompressedSize: 1,
    stream: () => Readable.from(''),
    ...over,
  }) as unknown as unzipper.File;

describe('entryPath', () => {
  it('trusts the decoded path when the UTF-8 flag is set', () => {
    expect(entryPath(fakeFile({ isUnicode: 1, path: '相片/a.json' }))).toBe(
      '相片/a.json',
    );
  });

  it('decodes a flagless name as UTF-8 when it is valid UTF-8', () => {
    expect(
      entryPath(
        fakeFile({ isUnicode: 0, pathBuffer: Buffer.from('相片/a.json') }),
      ),
    ).toBe('相片/a.json');
  });

  it('falls back to latin1 when the bytes are not valid UTF-8', () => {
    const latin1Name = Buffer.from('caf\xe9.json', 'latin1');
    expect(entryPath(fakeFile({ isUnicode: 0, pathBuffer: latin1Name }))).toBe(
      'café.json',
    );
  });
});

describe('contentTypeFor', () => {
  it('maps known media extensions', () => {
    expect(contentTypeFor('a/b.JPG')).toBe('image/jpeg');
    expect(contentTypeFor('a/b.mp4')).toBe('video/mp4');
  });

  it('defaults to octet-stream for anything else', () => {
    expect(contentTypeFor('a/b.exe')).toBe('application/octet-stream');
  });
});

describe('mediaEntries', () => {
  it('indexes files under the media marker by their relative URI', () => {
    const uri = `${MEDIA_MARKER}photos/1.jpg`;
    const dir = {
      files: [
        fakeFile({ path: `export-root/${uri}` }),
        fakeFile({ path: 'export-root/posts/feed.json' }),
        fakeFile({ path: `export-root/${MEDIA_MARKER}`, type: 'Directory' }),
      ],
    } as unknown as unzipper.CentralDirectory;

    const index = mediaEntries(dir);
    expect([...index.keys()]).toEqual([uri]);
  });

  it('keeps the first entry when a URI appears twice', () => {
    const uri = `${MEDIA_MARKER}1.jpg`;
    const first = fakeFile({ path: uri, uncompressedSize: 111 });
    const dir = {
      files: [first, fakeFile({ path: `dup/${uri}` })],
    } as unknown as unzipper.CentralDirectory;

    expect(mediaEntries(dir).get(uri)).toBe(first);
  });
});

describe('extractJsonEntries', () => {
  let dest: string;

  beforeEach(() => {
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'r2zip-test-'));
  });

  afterEach(() => {
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it('writes only .json entries, preserving the folder structure', async () => {
    const dir = {
      files: [
        fakeFile({
          path: 'root/posts/feed.json',
          stream: () => Readable.from('{"ok":true}'),
        }),
        fakeFile({ path: 'root/media/photo.jpg' }),
        fakeFile({ path: 'root/posts', type: 'Directory' }),
      ],
    } as unknown as unzipper.CentralDirectory;

    const res = await extractJsonEntries(dir, dest);

    expect(res.fileCount).toBe(1);
    expect(res.warnings).toEqual([]);
    expect(
      fs.readFileSync(path.join(dest, 'root/posts/feed.json'), 'utf8'),
    ).toBe('{"ok":true}');
    expect(fs.existsSync(path.join(dest, 'root/media/photo.jpg'))).toBe(false);
  });

  it('skips zip-slip paths with a warning instead of writing outside dest', async () => {
    const dir = {
      files: [
        fakeFile({
          path: '../evil.json',
          stream: () => Readable.from('{}'),
        }),
      ],
    } as unknown as unzipper.CentralDirectory;

    const res = await extractJsonEntries(dir, dest);

    expect(res.fileCount).toBe(0);
    expect(res.warnings[0]).toContain('Skipped suspicious entry path');
    expect(fs.existsSync(path.join(path.dirname(dest), 'evil.json'))).toBe(
      false,
    );
  });
});

describe('openZipFromR2', () => {
  it('gives unzipper a ranged-read source backed by R2', async () => {
    const customSpy = jest
      .spyOn(unzipper.Open, 'custom')
      .mockResolvedValue('central-directory' as never);
    const r2 = {
      headSize: jest.fn().mockResolvedValue(1000),
      getStream: jest.fn().mockResolvedValue(Readable.from('abc')),
    };

    const result = await openZipFromR2(r2 as never, 'pending/x.zip');
    expect(result).toBe('central-directory');

    const source = customSpy.mock.calls[0][0];
    await expect(source.size()).resolves.toBe(1000);

    // A bounded read maps to an inclusive byte range.
    const out = source.stream(10, 5);
    const chunks: Buffer[] = [];
    for await (const c of out) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('abc');
    expect(r2.getStream).toHaveBeenCalledWith('pending/x.zip', 'bytes=10-14');

    customSpy.mockRestore();
  });

  it('surfaces fetch failures as stream errors instead of hanging', async () => {
    const customSpy = jest
      .spyOn(unzipper.Open, 'custom')
      .mockResolvedValue('cd' as never);
    const r2 = {
      headSize: jest.fn().mockResolvedValue(1),
      getStream: jest.fn().mockRejectedValue(new Error('connection reset')),
    };

    await openZipFromR2(r2 as never, 'k');
    const source = customSpy.mock.calls[0][0];
    const out = source.stream(0, 1);

    await expect(
      new Promise((_, reject) => out.on('error', reject)),
    ).rejects.toThrow('connection reset');

    customSpy.mockRestore();
  });
});

describe('streamEntryToR2', () => {
  it('streams the entry body to the destination key with its content type', async () => {
    const body = Readable.from('bytes');
    const r2 = { uploadStream: jest.fn().mockResolvedValue(undefined) };
    const file = fakeFile({ stream: () => body });

    await streamEntryToR2(r2 as never, file, 'staging/a.jpg');

    expect(r2.uploadStream).toHaveBeenCalledWith(
      'staging/a.jpg',
      body,
      'image/jpeg',
    );
  });
});
