import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { SupabaseService } from '../supabase/supabase.service';
import { matchAiCrawler } from './ai-crawler-patterns';

// Express folds repeated headers into a string[]; a forwarded X-Forwarded-For
// style value can also itself be a comma-separated chain — either way, only
// the first (closest to the original caller) entry is the value we want.
function firstHeaderValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw ? raw.split(',')[0].trim() : '';
}

/**
 * Logs every request whose User-Agent matches a known AI crawler/agent —
 * server-side, so it also catches bots that fetch raw HTML/JSON without
 * executing JS (which stats.service.ts's client-triggered /stats/visit
 * beacon misses entirely, since that only fires from the browser).
 *
 * This only observes traffic; it never blocks or alters the response —
 * failures writing to Supabase are logged and swallowed.
 */
@Injectable()
export class CrawlerLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger('CrawlerVisit');

  constructor(private readonly supabase: SupabaseService) {}

  use(req: Request, res: Response, next: NextFunction) {
    // Requests for /log/:id are server-rendered on the frontend (Vercel),
    // which then calls this API server-to-server to fetch the post data —
    // so the request this middleware actually sees is Next.js's own fetch
    // client, not the original crawler, unless the frontend forwards the
    // real values. See page.tsx's fetchPost(), which sets these headers.
    const userAgent =
      firstHeaderValue(req.headers['x-original-user-agent']) ||
      req.headers['user-agent'] ||
      '';
    const match = matchAiCrawler(userAgent);

    if (match) {
      const path = req.originalUrl;
      const ip = firstHeaderValue(req.headers['x-original-ip']) || req.ip;

      this.logger.log(`[CRAWLER] ${match.name} ${req.method} ${path} ip=${ip}`);

      this.supabase
        .getClient()
        .from('crawler_visits')
        .insert({
          bot_name: match.name,
          method: req.method,
          path,
          user_agent: userAgent,
          ip,
        })
        .then(({ error }) => {
          if (error) {
            this.logger.warn(`crawler_visits insert failed: ${error.message}`);
          }
        });
    }

    next();
  }
}
