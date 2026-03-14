import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { UpdateFbPostDto } from './update-fb-post.dto';

@Injectable()
export class FbPostsService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Fetch paginated posts for a specific user.
   */
  async findAll(
    userId: string,
    page: number = 1,
    limit: number = 10,
    category?: string,
    startDate?: string,
    endDate?: string,
    search?: string,
    showHidden: boolean = false,
  ) {
    if (!userId) {
      throw new InternalServerErrorException('User ID is required');
    }

    // Ensure parameters are numbers to prevent math errors (NaN)
    const p = Math.max(1, Number(page));
    const l = Math.max(1, Number(limit));
    const offset = (p - 1) * l;

    const client = this.supabase.getClient();
    let query = client
      .from('fb_posts')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('event_date', { ascending: false })
      .range(offset, offset + l - 1);

    // Only filter by is_hidden if we are NOT showing hidden posts
    try {
      if (!showHidden) {
        query = query.eq('is_hidden', false);
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      console.warn('⚠️ is_hidden column missing in DB');
    }

    if (category) {
      // Support both localized and original category names
      const categoryMap = {
        馬拉松: 'marathon',
        旅遊: 'travel',
        跑步訓練: 'training',
        日常生活: 'daily',
      };
      const dbCategory = categoryMap[category] || category;
      query = query.or(`category.eq.${category},category.eq.${dbCategory}`);
    }
    if (startDate) query = query.gte('event_date', startDate);
    if (endDate) query = query.lte('event_date', endDate);

    if (search) {
      // Use case-insensitive partial match
      query = query.or(`content.ilike.%${search}%,title.ilike.%${search}%`);
    }

    const { data, count, error } = await query;

    if (error) {
      console.error('❌ Supabase Query Error:', error.message, error.details);
      // If the error is about missing column 'is_hidden', let's provide a clear hint
      if (error.message.includes('is_hidden')) {
        throw new InternalServerErrorException(
          'Database schema mismatch: Did you run the SQL to add "is_hidden" column?',
        );
      }
      throw new InternalServerErrorException(error.message);
    }

    return {
      data: data || [],
      meta: {
        total: count || 0,
        page: p,
        limit: l,
        last_page: Math.ceil((count || 0) / l),
      },
    };
  }

  /**
   * Get all geotagged posts for map markers.
   */
  async findLocations(
    userId: string,
    category?: string,
    startDate?: string,
    endDate?: string,
    search?: string,
  ) {
    if (!userId) return [];

    const client = this.supabase.getClient();
    let query = client
      .from('fb_posts')
      .select('id, event_date, title, category, media')
      .eq('user_id', userId)
      .eq('is_hidden', false)
      .order('event_date', { ascending: false });

    if (category) query = query.eq('category', category);
    if (startDate) query = query.gte('event_date', startDate);
    if (endDate) query = query.lte('event_date', endDate);
    if (search)
      query = query.or(`content.ilike.%${search}%,title.ilike.%${search}%`);

    const { data, error } = await query;
    if (error) {
      console.error('❌ Supabase Location Error:', error.message);
      return [];
    }

    return (data || []).filter(
      (post) =>
        Array.isArray(post.media) &&
        post.media.some((m) => m.lat !== null && m.lng !== null),
    );
  }

  /**
   * Get unique categories and their counts.
   */
  async getCategories(userId: string) {
    if (!userId) return [];

    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('fb_posts')
      .select('category')
      .eq('user_id', userId)
      .eq('is_hidden', false);

    if (error) throw error;

    const stats = (data || []).reduce((acc, curr) => {
      const cat = curr.category || '未分類';
      acc[cat] = (acc[cat] || 0) + 1;
      return acc;
    }, {});

    return Object.keys(stats).map((name) => ({ name, count: stats[name] }));
  }

  /**
   * Get a single post by ID.
   */
  async findOne(userId: string, id: string) {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('fb_posts')
      .select('*')
      .eq('user_id', userId)
      .eq('id', id)
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Update a post.
   */
  async update(userId: string, id: string, updateDto: UpdateFbPostDto) {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('fb_posts')
      .update(updateDto)
      .eq('user_id', userId)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Delete a post.
   */
  async remove(userId: string, id: string) {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('fb_posts')
      .delete()
      .eq('user_id', userId)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }
}
