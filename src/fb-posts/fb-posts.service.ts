import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { UpdateFbPostDto } from './update-fb-post.dto';

@Injectable()
export class FbPostsService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * 核心處理：URL 正規化與主圖自動回退邏輯
   */
  private normalizePost(post: any, publicUrl: string) {
    if (!post) return null;
    const media = Array.isArray(post.media)
      ? post.media.map((m) => ({
          ...m,
          uri:
            m.uri && typeof m.uri === 'string' && !m.uri.startsWith('http')
              ? `${publicUrl}/${m.uri}`
              : m.uri,
        }))
      : [];
    let coverImage = post.cover_image;
    if (
      !coverImage ||
      (typeof coverImage === 'string' && coverImage.trim() === '')
    ) {
      if (media.length > 0) {
        const firstPhoto = media.find(
          (m) => m.type === 'photo' || m.type === 'image',
        );
        coverImage = firstPhoto ? firstPhoto.uri : media[0].uri;
      }
    } else if (
      typeof coverImage === 'string' &&
      !coverImage.startsWith('http')
    ) {
      coverImage = `${publicUrl}/${coverImage}`;
    }
    return { ...post, media, cover_image: coverImage || null };
  }

  async findAll(
    userId: string,
    page: number = 1,
    limit: number = 10,
    category?: string,
    startDate?: string,
    endDate?: string,
    search?: string,
    status: 'all' | 'visible' | 'hidden' = 'visible',
    order: 'asc' | 'desc' = 'desc',
    tag?: string,
    isAdmin: boolean = false,
  ) {
    if (!userId) throw new InternalServerErrorException('User ID is required');
    const p = Math.max(1, Number(page));
    const l = Math.max(1, Number(limit));
    const offset = (p - 1) * l;
    const client = this.supabase.getClient();
    let query = client
      .from('fb_posts')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('event_date', { ascending: order === 'asc' });

    // --- 安全過濾邏輯 ---
    if (!isAdmin) {
      // 非管理員：強制只能看公開文章，且忽視傳入的 status 參數
      query = query.eq('is_hidden', false);
    } else {
      // 管理員：尊重 status 參數
      if (status === 'visible') query = query.eq('is_hidden', false);
      else if (status === 'hidden') query = query.eq('is_hidden', true);
    }

    if (category) {
      const categoryMap = {
        馬拉松: 'marathon',
        海外馬: 'overseas_marathon',
        國內馬: 'domestic_marathon',
        旅遊: 'travel',
        跑步訓練: 'training',
        日常生活: 'daily',
      };
      const dbCategory = categoryMap[category] || category;
      query = query.or(`category.eq.${category},category.eq.${dbCategory}`);
    }
    if (startDate) query = query.gte('event_date', startDate);
    if (endDate) query = query.lte('event_date', endDate);
    if (search)
      query = query.or(`content.ilike.%${search}%,title.ilike.%${search}%`);
    if (tag) query = query.contains('tags', [tag]);

    const { data, count, error } = await query.range(offset, offset + l - 1);
    if (error) throw new InternalServerErrorException(error.message);
    const publicUrl = process.env.R2_PUBLIC_URL || '';
    const normalizedData = (data || []).map((post) =>
      this.normalizePost(post, publicUrl),
    );
    return {
      data: normalizedData,
      meta: {
        total: count || 0,
        page: p,
        limit: l,
        last_page: Math.ceil((count || 0) / l),
      },
    };
  }

  async fuzzySearch(userId: string, queryDto: any) {
    const { q, category, limit = 20, offset = 0, is_overseas } = queryDto;
    const client = this.supabase.getClient();
    const publicUrl = process.env.R2_PUBLIC_URL || '';
    // 公開搜尋強制只顯示非隱藏文章
    let query = client
      .from('fb_posts')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .eq('is_hidden', false)
      .order('event_date', { ascending: false });
    if (q) query = query.or(`title.ilike.%${q}%,content.ilike.%${q}%`);
    if (category) query = query.eq('category', category);
    if (is_overseas !== undefined) query = query.eq('is_overseas', is_overseas);
    const { data, count, error } = await query.range(
      offset,
      offset + limit - 1,
    );
    if (error) throw new InternalServerErrorException(error.message);
    return {
      data: (data || []).map((post) => this.normalizePost(post, publicUrl)),
      meta: { total: count || 0, offset, limit },
    };
  }

  async findLocations(
    userId: string,
    category?: string,
    startDate?: string,
    endDate?: string,
    search?: string,
  ) {
    if (!userId) return [];
    const publicUrl = process.env.R2_PUBLIC_URL || '';
    const client = this.supabase.getClient();
    let query = client
      .from('fb_posts')
      .select('id, event_date, title, category, media, metadata')
      .eq('user_id', userId)
      .eq('is_hidden', false)
      .order('event_date', { ascending: false });
    if (category) {
      const categoryMap = {
        馬拉松: 'marathon',
        海外馬: 'overseas_marathon',
        國內馬: 'domestic_marathon',
        旅遊: 'travel',
        跑步訓練: 'training',
        日常生活: 'daily',
      };
      const dbCategory = categoryMap[category] || category;
      query = query.or(`category.eq.${category},category.eq.${dbCategory}`);
    }
    if (startDate) query = query.gte('event_date', startDate);
    if (endDate) query = query.lte('event_date', endDate);
    if (search)
      query = query.or(`content.ilike.%${search}%,title.ilike.%${search}%`);
    const { data, error } = await query;
    if (error) return [];
    return (data || [])
      .map((post) => {
        if (!Array.isArray(post.media)) return null;
        const rep = post.media.find(
          (m) =>
            m.lat !== null && m.lng !== null && !isNaN(m.lat) && !isNaN(m.lng),
        );
        if (!rep) return null;
        const uri =
          rep.uri && !rep.uri.startsWith('http')
            ? `${publicUrl}/${rep.uri}`
            : rep.uri;
        return {
          id: post.id,
          postId: post.id,
          lat: rep.lat,
          lng: rep.lng,
          title: post.title,
          date: post.event_date,
          cat: post.category,
          uri: uri,
          photoCount: post.media.length,
          country: post.metadata?.country || null,
        };
      })
      .filter((p) => p !== null);
  }

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

  async findOne(userId: string, id: string, isAdmin: boolean = false) {
    const publicUrl = process.env.R2_PUBLIC_URL || '';
    const client = this.supabase.getClient();
    let query = client
      .from('fb_posts')
      .select('*')
      .eq('user_id', userId)
      .eq('id', id);
    if (!isAdmin) query = query.eq('is_hidden', false);
    const { data, error } = await query.single();
    if (error || !data)
      throw new NotFoundException('找不到文章或該文章已被隱藏。');
    return this.normalizePost(data, publicUrl);
  }

  async update(userId: string, id: string, updateDto: UpdateFbPostDto) {
    const publicUrl = process.env.R2_PUBLIC_URL || '';
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('fb_posts')
      .update(updateDto)
      .eq('user_id', userId)
      .eq('id', id)
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    return this.normalizePost(data, publicUrl);
  }

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
