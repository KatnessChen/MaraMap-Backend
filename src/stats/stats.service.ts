import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Automatically refresh all participant stats at midnight every day.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCron() {
    this.logger.debug('Running daily participant stats refresh...');
    await this.refreshAllStats();
  }

  /**
   * Fetch aggregated stats for a specific participant.
   */
  async getParticipantStats(name: string) {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('participant_stats')
      .select('*')
      .ilike('participant_name', name)
      .single();

    if (error) {
      this.logger.error(`Error fetching stats for ${name}: ${error.message}`);
      return null;
    }
    return data;
  }

  /**
   * Core logic to aggregate data from fb_posts and update participant_stats table.
   */
  async refreshAllStats() {
    const client = this.supabase.getClient();

    const { data: posts, error } = await client
      .from('fb_posts')
      .select('metadata, category')
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
            total_distance_km: 0,
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

        // 1. Cumulative Distance (Always accumulate if available)
        if (pStats.distance_km) {
          current.total_distance_km += parseFloat(pStats.distance_km);
        }

        // 2. Calculated Counts (ONLY for marathon category)
        if (category === 'marathon') {
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

        // 3. Manual/Extracted Overrides (Take the maximum found in text)
        // Keep FM and HM overrides, skip UM overrides as previously discussed
        if (pStats.FM_count)
          current.fm_count = Math.max(current.fm_count, pStats.FM_count);
        if (pStats.HM_count)
          current.hm_count = Math.max(current.hm_count, pStats.HM_count);
      });
    });

    // 4. Final Reconcile
    for (const [name, stats] of statsMap.entries()) {
      const finalStats = {
        participant_name: name,
        total_distance_km: stats.total_distance_km,
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
