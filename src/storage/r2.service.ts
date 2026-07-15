import { Injectable, Logger } from '@nestjs/common';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

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
