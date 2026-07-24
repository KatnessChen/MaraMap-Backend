import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'stream';

@Injectable()
export class R2Service {
  private readonly logger = new Logger(R2Service.name);
  private readonly client: S3Client;
  private readonly bucket = process.env.R2_BUCKET_NAME as string;
  private readonly publicUrl = process.env.R2_PUBLIC_URL || '';

  constructor() {
    this.client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
      },
      // R2 doesn't implement AWS's newer flexible checksums; without these the
      // SDK (≥3.729) bakes an empty-body CRC32 into presigned PUT URLs, which
      // rejects every real upload.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /**
   * Derives the R2 object key from a stored media.uri. Handles both the
   * current absolute-URL convention and legacy bare-key rows that predate
   * normalizePost's runtime prefixing.
   */
  keyFromUrl(uri: string | null | undefined): string | null {
    if (!uri) return null;
    if (this.publicUrl && uri.startsWith(`${this.publicUrl}/`)) {
      return uri.slice(this.publicUrl.length + 1);
    }
    if (!uri.startsWith('http')) return uri;
    return null;
  }

  /**
   * Uploads a buffer to R2 and returns the absolute public URL. Unlike
   * `delete`, this throws on failure — an upload the caller believes
   * succeeded but silently didn't would leave a post pointing at a
   * missing image.
   */
  async upload(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return this.publicUrl ? `${this.publicUrl}/${key}` : key;
  }

  /**
   * Server-side copy within the bucket. Throws on failure so the caller can
   * decide whether to keep the source (R2/S3 have no native move — a "move"
   * is copy + delete). Keys here are ASCII (prefix + timestamp + uuid), so
   * CopySource needs no percent-encoding of the path.
   */
  async copy(srcKey: string, destKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${srcKey}`,
        Key: destKey,
      }),
    );
  }

  /**
   * Presigned PUT URL so the browser can upload straight to R2, bypassing
   * Cloud Run's 32 MiB request body limit. A single presigned PUT supports
   * objects up to ~5 GiB — far beyond any Facebook export batch.
   */
  async presignPut(
    key: string,
    contentType: string,
    expiresInSeconds = 3600,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  /** Object size in bytes. Throws if the key doesn't exist. */
  async headSize(key: string): Promise<number> {
    const res = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return res.ContentLength ?? 0;
  }

  /** Last-modified time of an object, or null if it doesn't exist. */
  async lastModified(key: string): Promise<Date | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return res.LastModified ?? null;
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Readable stream of an object, optionally a byte range ("bytes=0-99").
   * Ranged reads are what let the zip extractor walk a multi-GB archive
   * without ever holding more than one entry in transit.
   */
  async getStream(key: string, range?: string): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(range ? { Range: range } : {}),
      }),
    );
    return res.Body as Readable;
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const body = await this.getStream(key);
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk as Buffer);
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
    } catch (err: any) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.upload(
      key,
      Buffer.from(JSON.stringify(value, null, 2)),
      'application/json',
    );
  }

  /**
   * Streaming upload for bodies that shouldn't be buffered whole (media files
   * pulled out of the export zip). lib-storage handles multipart + retries.
   */
  async uploadStream(
    key: string,
    body: Readable,
    contentType: string,
  ): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      },
    });
    await upload.done();
  }

  /**
   * Immediate "subfolder" prefixes under a prefix (delimiter listing) —
   * lets the import resume list enumerate batches without paging through
   * every staged media object inside them.
   */
  async listPrefixes(prefix: string): Promise<string[]> {
    const prefixes: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          Delimiter: '/',
          ContinuationToken: token,
        }),
      );
      for (const p of res.CommonPrefixes ?? []) {
        if (p.Prefix) prefixes.push(p.Prefix);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return prefixes;
  }

  /** All keys under a prefix (paginated — R2 caps each page at 1000). */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  /**
   * Deletes every object under a prefix. Throws on failure — callers use this
   * to cancel an import batch, and a half-deleted batch would silently linger
   * in the resume list forever.
   */
  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.list(prefix);
    for (let i = 0; i < keys.length; i += 1000) {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })),
          },
        }),
      );
    }
    return keys.length;
  }

  /** Best-effort delete — never throws, only logs. Callers rely on this. */
  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err: any) {
      this.logger.warn(
        `R2 delete failed for key=${key}: ${err?.message || err}`,
      );
    }
  }
}
