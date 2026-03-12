import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class FbPostsService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Fetch paginated posts for a specific user.
   * Supports filtering by category, date range, and search keywords.
   */
  async findAll(
    userId: string,
    page: number = 1,
    limit: number = 10,
    category?: string,
    startDate?: string,
    endDate?: string,
    search?: string,
  ) {
    const client = this.supabase.getClient();
    const offset = (page - 1) * limit;

    let query = client
      .from('fb_posts')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('event_date', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply category filter
    if (category) {
      query = query.eq('category', category);
    }

    // Apply date range filter
    if (startDate) {
      query = query.gte('event_date', startDate);
    }
    if (endDate) {
      query = query.lte('event_date', endDate);
    }

    // Apply keyword search (case-insensitive partial match on content or title)
    if (search) {
      query = query.or(`content.ilike.%${search}%,title.ilike.%${search}%`);
    }

    const { data, count, error } = await query;

    if (error) {
      console.error('Error fetching fb_posts:', error.message);
      throw error;
    }

    return {
      data,
      meta: {
        total: count,
        page: Number(page),
        limit: Number(limit),
        last_page: Math.ceil((count || 0) / limit),
      },
    };
  }

  /**
   * Get all geotagged posts for map markers.
   * Supports filtering to keep the map in sync with the list view.
   */
  async findLocations(
    userId: string,
    category?: string,
    startDate?: string,
    endDate?: string,
    search?: string,
  ) {
    const client = this.supabase.getClient();
    
    let query = client
      .from('fb_posts')
      .select('id, event_date, title, category, media')
      .eq('user_id', userId)
      .order('event_date', { ascending: false });

    if (category) query = query.eq('category', category);
    if (startDate) query = query.gte('event_date', startDate);
    if (endDate) query = query.lte('event_date', endDate);
    if (search) query = query.or(`content.ilike.%${search}%,title.ilike.%${search}%`);

    const { data, error } = await query;

    if (error) throw error;

    // Filter posts that have at least one media item with GPS coordinates
    return (data || []).filter(post => 
      Array.isArray(post.media) && 
      post.media.some(m => m.lat !== null && m.lng !== null)
    );
  }

  /**
   * Get unique categories and their counts for a user.
   */
  async getCategories(userId: string) {
    const client = this.supabase.getClient();
    
    const { data, error } = await client
      .from('fb_posts')
      .select('category')
      .eq('user_id', userId);

    if (error) throw error;

    const stats = (data || []).reduce((acc, curr) => {
      const cat = curr.category || 'unknown';
      acc[cat] = (acc[cat] || 0) + 1;
      return acc;
    }, {});

    return Object.keys(stats).map(name => ({
      name,
      count: stats[name]
    }));
  }
}
