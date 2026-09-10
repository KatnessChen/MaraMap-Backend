import { Injectable, Logger } from '@nestjs/common';

// Shared across the participating search engines (Bing, Yandex, Seznam,
// Naver, ...) — one submission to api.indexnow.org's endpoint reaches all of
// them. Not a secret: it's only meaningful alongside the verification file
// hosted at SITE_URL, which is itself public.
const INDEXNOW_KEY = 'da510ae5ed7940bfa50a972739715dfb';
const SITE_URL = 'https://maramap.vizino.ai';
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/**
 * Pings IndexNow so a new/updated post's URL gets crawled within minutes
 * instead of waiting for the next scheduled sitemap crawl. Best-effort only:
 * never throws, and skipped outside production so local dev and CI runs
 * don't submit real URLs for content that may not even be public yet.
 */
@Injectable()
export class IndexNowService {
  private readonly logger = new Logger(IndexNowService.name);

  async submitPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    if (process.env.NODE_ENV !== 'production') return;

    const urlList = paths.map((path) => `${SITE_URL}${path}`);

    try {
      const res = await fetch(INDEXNOW_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          host: new URL(SITE_URL).host,
          key: INDEXNOW_KEY,
          keyLocation: `${SITE_URL}/${INDEXNOW_KEY}.txt`,
          urlList,
        }),
      });
      if (!res.ok) {
        this.logger.warn(
          `IndexNow submission failed (${res.status}): ${urlList.join(', ')}`,
        );
      }
    } catch (err: unknown) {
      this.logger.warn(`IndexNow submission error: ${(err as Error).message}`);
    }
  }
}
