import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';

const BOT_PATTERN =
  /bot|spider|crawler|crawl|slurp|fetch|scan|check|monitor|scrape|archive|feed|reader|parser|headless|python|java|ruby|curl|wget|axios|libwww|go-http|http-client|okhttp|facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|whatsapp|telegram|applebot|yandex|baidu|duckduck|semrush|ahrefs|mj12|dotbot|petalbot|gptbot|claudebot|oai-searchbot|meta-externalagent|perplexitybot/i;

@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Safety net for writes this service cannot observe. The per-write hooks below
   * cover everything that goes through the API, but the ETL scripts under etl/
   * write to Supabase directly as child processes (e.g. rerun-albums.js), so
   * nothing in Nest fires for them. Without this, such a run leaves the numbers
   * wrong until somebody notices; with it, they self-correct overnight.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCron() {
    this.logger.debug('Running daily participant stats refresh...');
    await this.refreshAllStats();
  }

  /**
   * Recompute stats right after something wrote to fb_posts, so the numbers are
   * correct on the next page load instead of after the nightly cron. Stats are
   * derived data and a full recompute is cheap (~500 rows, two upserts), so
   * there is no reason to make an edit wait until midnight to show up.
   *
   * Never throws. A stats failure must not fail the mutation that triggered it —
   * the post write is the user's actual intent and has already committed. The
   * next write, the cron, or a manual POST /stats/refresh reconciles.
   */
  async refreshAfterMutation(reason: string): Promise<void> {
    try {
      await this.refreshAllStats();
      this.logger.log(`Participant stats refreshed after ${reason}`);
    } catch (err) {
      this.logger.error(
        `Stats refresh after ${reason} failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Fetch aggregated stats for a specific participant.
   */
  async getParticipantStats(name: string) {
    const client = this.supabase.getClient();
    const [statsResult, countryCount] = await Promise.all([
      client
        .from('participant_stats')
        .select('*')
        .ilike('participant_name', name)
        .single(),
      this.getCountryCount(),
    ]);

    if (statsResult.error) {
      this.logger.error(
        `Error fetching stats for ${name}: ${statsResult.error.message}`,
      );
      return null;
    }
    return { ...statsResult.data, country_count: countryCount };
  }

  async recordVisit(path: string, userAgent: string): Promise<void> {
    const isBot = BOT_PATTERN.test(userAgent || '');
    const field = isBot ? 'bot_views' : 'human_views';
    const client = this.supabase.getClient();

    const { error } = await client.rpc('increment_page_view', {
      p_path: path,
      p_field: field,
    });

    if (error) {
      this.logger.error(`Failed to record visit for ${path}: ${error.message}`);
    }
  }

  async getVisits(): Promise<{
    total_human: number;
    total_bot: number;
    pages: any[];
  }> {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('page_views')
      .select('path, human_views, bot_views')
      .order('human_views', { ascending: false });

    if (error) {
      this.logger.error(`Failed to fetch visits: ${error.message}`);
      return { total_human: 0, total_bot: 0, pages: [] };
    }

    const pages = data || [];
    const total_human = pages.reduce(
      (sum, r) => sum + Number(r.human_views),
      0,
    );
    const total_bot = pages.reduce((sum, r) => sum + Number(r.bot_views), 0);
    return { total_human, total_bot, pages };
  }

  async getCountryCount(): Promise<number> {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('fb_posts')
      .select('metadata')
      .eq('is_hidden', false)
      .not('metadata', 'is', null);

    if (error) {
      this.logger.error(`Error fetching country count: ${error.message}`);
      return 0;
    }

    const countries = new Set(
      (data || [])
        .map((p) => (p.metadata?.country as string | undefined)?.trim())
        .filter(Boolean),
    );
    return countries.size;
  }

  /**
   * Core logic to aggregate data from fb_posts and update participant_stats table.
   */
  async refreshAllStats() {
    const client = this.supabase.getClient();

    // is_hidden posts are excluded everywhere else (getCountryCount above,
    // findLocations, getCategories) — this query was the one that missed it,
    // so hidden races inflated fm_count past what the list actually shows.
    const { data: posts, error } = await client
      .from('fb_posts')
      .select('metadata, category')
      .eq('is_hidden', false)
      .neq('metadata', '{}');

    if (error) {
      this.logger.error(`Failed to fetch posts for stats: ${error.message}`);
      return;
    }

    const statsMap = new Map<string, any>();

    posts.forEach((post) => {
      const participants = post.metadata?.participants;
      const category = post.category || '';
      if (!Array.isArray(participants)) return;

      participants.forEach((p) => {
        const name = p.name;
        if (!['Davis', 'Rose'].includes(name)) return;

        if (!statsMap.has(name)) {
          statsMap.set(name, {
            participant_name: name,
            fm_count: 0,
            hm_count: 0,
            um_count: 0,
            calculated_fm: 0,
            calculated_hm: 0,
            calculated_um: 0,
          });
        }

        const current = statsMap.get(name);
        const pStats = p.stats || {};
        const distanceType = p.distance || '';

        // 1. Calculated Counts (ONLY for marathon category)
        if (category === '馬拉松') {
          if (distanceType.includes('超馬') || pStats.distance_km > 45) {
            current.calculated_fm += 1;
            current.calculated_um += 1;
          } else if (
            distanceType.includes('全馬') ||
            pStats.distance_km >= 40
          ) {
            current.calculated_fm += 1;
          } else if (
            distanceType.includes('半馬') ||
            pStats.distance_km >= 20
          ) {
            current.calculated_hm += 1;
          }
        }

        // 2. Manual/Extracted Overrides (Take the maximum found in text)
        // Keep FM and HM overrides, skip UM overrides as previously discussed
        if (pStats.FM_count)
          current.fm_count = Math.max(current.fm_count, pStats.FM_count);
        if (pStats.HM_count)
          current.hm_count = Math.max(current.hm_count, pStats.HM_count);
      });
    });

    // 3. Final Reconcile
    for (const [name, stats] of statsMap.entries()) {
      const finalStats = {
        participant_name: name,
        // FM_count: Use max of extracted OR calculated (Davis's habit)
        fm_count: Math.max(stats.fm_count, stats.calculated_fm),
        // HM_count: Use max of extracted OR calculated
        hm_count: Math.max(stats.hm_count, stats.calculated_hm),
        // UM_count: Use ONLY calculated sum (since Davis doesn't count UM separately in text)
        um_count: stats.calculated_um,
        last_updated: new Date().toISOString(),
      };

      const { error: upsertError } = await client
        .from('participant_stats')
        .upsert(finalStats, { onConflict: 'participant_name' });

      if (upsertError) {
        this.logger.error(
          `Failed to update stats for ${name}: ${upsertError.message}`,
        );
      } else {
        this.logger.log(`✅ Successfully updated stats for ${name}`);
      }
    }
  }
}
