import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ForbiddenException,
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
    subCategory?: string,
    continent?: string,
    country?: string,
    city?: string,
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
      query = query.eq('is_hidden', false);
    } else {
      if (status === 'visible') query = query.eq('is_hidden', false);
      else if (status === 'hidden') query = query.eq('is_hidden', true);
    }

    if (category) query = query.eq('category', category);
    if (subCategory) query = query.contains('sub_categories', [subCategory]);
    if (startDate) query = query.gte('event_date', startDate);
    if (endDate) query = query.lte('event_date', endDate);
    if (search)
      query = query.or(`content.ilike.%${search}%,title.ilike.%${search}%`);
    if (tag) query = query.contains('tags', [tag]);
    if (continent)
      query = query.ilike('metadata->>continent', `%${continent}%`);
    if (country) query = query.ilike('metadata->>country', `%${country}%`);
    if (city) query = query.ilike('metadata->>city', `%${city}%`);

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
    const { q, category, limit = 20, offset = 0 } = queryDto;
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

  private readonly COUNTRY_NAME_MAP: Record<string, string> = {
    台灣: 'Taiwan',
    '台 灣': 'Taiwan',
    中國: 'China',
    香港: 'Hong Kong',
    澳門: 'Macao',
    泰國: 'Thailand',
    馬來西亞: 'Malaysia',
    新加坡: 'Singapore',
    挪威: 'Norway',
    葡萄牙: 'Portugal',
    格陵蘭: 'Greenland',
    澳洲: 'Australia',
    柬埔寨: 'Cambodia',
    日本: 'Japan',
    加拿大: 'Canada',
    法國: 'France',
    奧地利: 'Austria',
    美國: 'United States of America',
    英國: 'United Kingdom',
    德國: 'Germany',
    義大利: 'Italy',
    西班牙: 'Spain',
    荷蘭: 'Netherlands',
    瑞典: 'Sweden',
    丹麥: 'Denmark',
    芬蘭: 'Finland',
    瑞士: 'Switzerland',
    比利時: 'Belgium',
    捷克: 'Czech Republic',
    波蘭: 'Poland',
    匈牙利: 'Hungary',
    希臘: 'Greece',
    土耳其: 'Turkey',
    以色列: 'Israel',
    印度: 'India',
    韓國: 'South Korea',
    越南: 'Vietnam',
    印尼: 'Indonesia',
    菲律賓: 'Philippines',
    紐西蘭: 'New Zealand',
    南非: 'South Africa',
    巴西: 'Brazil',
    阿根廷: 'Argentina',
    墨西哥: 'Mexico',
  };

  async findLocations(
    userId: string,
    category?: string,
    subCategory?: string,
    startDate?: string,
    endDate?: string,
    search?: string,
  ) {
    if (!userId) return [];
    const publicUrl = process.env.R2_PUBLIC_URL || '';
    const client = this.supabase.getClient();
    let query = client
      .from('fb_posts')
      .select(
        'id, event_date, title, category, sub_categories, media, metadata',
      )
      .eq('user_id', userId)
      .eq('is_hidden', false)
      .order('event_date', { ascending: false });
    if (category) query = query.eq('category', category);
    if (subCategory) query = query.contains('sub_categories', [subCategory]);
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
          country_en:
            this.COUNTRY_NAME_MAP[post.metadata?.country?.trim()] ||
            post.metadata?.country ||
            null,
          continent: post.metadata?.continent || null,
          city: post.metadata?.city || null,
        };
      })
      .filter((p) => p !== null);
  }

  async findByCountry(userId: string, country: string) {
    if (!userId) return [];
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('fb_posts')
      .select('id, event_date, title, category, metadata')
      .eq('user_id', userId)
      .eq('is_hidden', false)
      .order('event_date', { ascending: true });
    if (error) return [];
    const normalized = country.trim().replace(/\s+/g, '');
    return (data || [])
      .filter((post) => {
        const metaCountry = (post.metadata?.country || '')
          .trim()
          .replace(/\s+/g, '');
        return metaCountry === normalized;
      })
      .map((post) => ({
        postId: post.id,
        title: post.title,
        date: post.event_date,
        category: post.category,
        raceName: post.metadata?.race_name || null,
        city: post.metadata?.city || null,
        participants: (post.metadata?.participants || []).map((p: any) => ({
          name: p.name,
          distance: p.distance || null,
          distanceKm: p.stats?.distance_km || null,
          time: p.time || null,
        })),
      }));
  }

  async findByTripId(userId: string, tripId: string) {
    if (!userId) return [];
    const publicUrl = process.env.R2_PUBLIC_URL || '';
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('fb_posts')
      .select('id, event_date, title, category, cover_image, metadata, trip_id')
      .eq('user_id', userId)
      .eq('trip_id', tripId)
      .eq('is_hidden', false)
      .order('event_date', { ascending: true });
    if (error) return [];
    return (data || []).map((post) => {
      let cover = post.cover_image;
      if (cover && !cover.startsWith('http')) cover = `${publicUrl}/${cover}`;
      return {
        postId: post.id,
        title: post.title,
        date: post.event_date,
        category: post.category,
        country: post.metadata?.country || null,
        city: post.metadata?.city || null,
        coverImage: cover || null,
        isPrimary: post.id === tripId,
      };
    });
  }

  async getCategories(userId: string) {
    if (!userId) return [];
    const VALID_CATEGORIES = ['馬拉松', '旅遊', '登山'];
    const SUB_CATEGORY_MAP: Record<string, string[]> = {
      馬拉松: ['海外馬', '國內馬', '超馬(44K+)', '高山馬', '七大馬', '普查'],
      旅遊: [],
      登山: ['大百岳', '小百岳', '海外登山'],
    };
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('fb_posts')
      .select('category, sub_categories')
      .eq('user_id', userId)
      .eq('is_hidden', false)
      .in('category', VALID_CATEGORIES);
    if (error) throw error;

    // Count by category and sub_category
    const catStats: Record<string, number> = {};
    const subStats: Record<string, Record<string, number>> = {};
    for (const row of data || []) {
      const cat = row.category;
      catStats[cat] = (catStats[cat] || 0) + 1;
      if (!subStats[cat]) subStats[cat] = {};
      for (const sub of row.sub_categories || []) {
        subStats[cat][sub] = (subStats[cat][sub] || 0) + 1;
      }
    }

    return VALID_CATEGORIES.filter((name) => catStats[name] !== undefined).map(
      (name) => ({
        name,
        count: catStats[name],
        sub_categories: (SUB_CATEGORY_MAP[name] || [])
          .filter((sub) => subStats[name]?.[sub] !== undefined)
          .map((sub) => ({ name: sub, count: subStats[name][sub] })),
      }),
    );
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

    const { data: current } = await client
      .from('fb_posts')
      .select('is_ai_editing_locked')
      .eq('user_id', userId)
      .eq('id', id)
      .single();
    if (current?.is_ai_editing_locked && updateDto.is_ai_editing_locked !== false) {
      throw new ForbiddenException('此文章已鎖定，禁止修改。');
    }

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
