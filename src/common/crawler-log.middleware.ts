import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { SupabaseService } from '../supabase/supabase.service';
import { matchAiCrawler } from './ai-crawler-patterns';

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
    const userAgent = req.headers['user-agent'] || '';
    const match = matchAiCrawler(userAgent);

    if (match) {
      const path = req.originalUrl;
      const ip = req.ip;

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
