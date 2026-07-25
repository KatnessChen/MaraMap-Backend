import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  Inject,
  Logger,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { randomUUID } from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { UpdateFbPostDto } from './update-fb-post.dto';
import { CreateFbPostDto } from './create-fb-post.dto';
import { R2Service } from '../storage/r2.service';
import { StatsService } from '../stats/stats.service';

// Permanent media live under the same R2 prefix the Facebook ETL uploads to
// (see utils/upload-to-r2.js), so manually-added and imported media share one
// consistent path convention. Provenance is tracked by fb_posts.source, not by
// the storage path. tmp uploads stage under `tmp/` first (swept by the
// R2 lifecycle rule) and are copied here on create/save.
const PERMANENT_MEDIA_PREFIX = 'your_facebook_activity/posts/media';

@Injectable()
export class FbPostsService {
  private readonly logger = new Logger(FbPostsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly r2: R2Service,
    private readonly stats: StatsService,
  ) {}

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
      // 明確要求看隱藏文章卻沒有管理員身分（多半是 token 過期）：
      // 回 401 讓前端導回登入頁，而不是默默降級成公開清單。
      if (status === 'all' || status === 'hidden') {
        throw new UnauthorizedException('管理員登入已過期，請重新登入。');
      }
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

  async fuzzySearch(userId: string, queryDto: any, isAdmin: boolean = false) {
    const { q, category, limit = 20, offset = 0 } = queryDto;
    const client = this.supabase.getClient();
    const publicUrl = process.env.R2_PUBLIC_URL || '';
    let query = client
      .from('fb_posts')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('event_date', { ascending: false });
    // 公開搜尋強制只顯示非隱藏文章；管理員搜尋則顯示全部（含隱藏）
    if (!isAdmin) query = query.eq('is_hidden', false);
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
    香港: 'Hong Kong S.A.R.',
    澳門: 'Macao S.A.R',
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
    捷克: 'Czechia',
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
    俄羅斯: 'Russia',
    蒙古: 'Mongolia',
    智利: 'Chile',
    秘魯: 'Peru',
    摩洛哥: 'Morocco',
    寮國: 'Laos',
    冰島: 'Iceland',
    法羅群島: 'Faroe Islands',
    南極: 'Antarctica',
    帛琉: 'Palau',
  };

  async findLocations(
    userId: string,
    category?: string,
    subCategory?: string,
    startDate?: string,
    endDate?: string,
    search?: string,
    geoOnly: boolean = true,
  ) {
    if (!userId) return [];
    const publicUrl = process.env.R2_PUBLIC_URL || '';
    const client = this.supabase.getClient();
    let query = client
      .from('fb_posts')
      .select(
        'id, event_date, title, category, sub_categories, ' +
          'rep_media:fb_posts_rep_media, ' +
          'fallback_lat:metadata->fallback_lat, fallback_lng:metadata->fallback_lng, ' +
          'country:metadata->>country, continent:metadata->>continent, city:metadata->>city',
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
    return ((data as any[]) || [])
      .map((post) => {
        // rep_media is computed server-side by the fb_posts_rep_media()
        // Postgres function (see supabase/migrations) — finds the first
        // media item with real EXIF GPS without shipping the whole
        // (often 20-600+ item) media array to the backend.
        const repMedia = post.rep_media || {};
        const hasRealGeo = repMedia.lat != null && repMedia.lng != null;
        // No photo has real EXIF GPS — fall back to an approximate coordinate
        // pre-computed by etl/08_geocode/geocode-fallback.js (venue name /
        // same-trip sibling / city+country, in that priority order).
        const fallbackLat = post.fallback_lat ?? null;
        const fallbackLng = post.fallback_lng ?? null;
        const hasFallback = fallbackLat !== null && fallbackLng !== null;
        if (geoOnly && !hasRealGeo && !hasFallback) return null;
        const repUri = repMedia.uri || null;
        const uri =
          repUri && !repUri.startsWith('http')
            ? `${publicUrl}/${repUri}`
            : repUri;
        return {
          id: post.id,
          postId: post.id,
          lat: hasRealGeo ? repMedia.lat : fallbackLat,
          lng: hasRealGeo ? repMedia.lng : fallbackLng,
          isApprox: !hasRealGeo && hasFallback,
          title: post.title,
          date: post.event_date,
          cat: post.category,
          uri: uri,
          photoCount: repMedia.photo_count ?? 0,
          sub_cats: Array.isArray(post.sub_categories)
            ? post.sub_categories
            : [],
          country: post.country || null,
          country_en:
            this.COUNTRY_NAME_MAP[post.country?.trim()] || post.country || null,
          continent: post.continent || null,
          city: post.city || null,
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
      .select(
        'id, event_date, title, category, cover_image, media, metadata, trip_id',
      )
      .eq('user_id', userId)
      .eq('trip_id', tripId)
      .eq('is_hidden', false)
      .order('event_date', { ascending: true });
    if (error) return [];
    return (data || []).map((post) => {
      let cover = post.cover_image;
      if (!cover || cover.trim() === '') {
        const media = Array.isArray(post.media) ? post.media : [];
        const firstPhoto = media.find(
          (m) => m.type === 'photo' || m.type === 'image',
        );
        cover = firstPhoto?.uri ?? media[0]?.uri ?? null;
      }
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

  private readonly TRIP_WINDOW_DAYS = 14;

  /**
   * 智慧推薦同行文章：同國家 + 事件日在 ±windowDays 內、尚未在本行程的文章，
   * 依「同城 > 日期接近 > 旅遊/登山次文」排序。錨點無國家時退回僅日期的弱推薦。
   */
  async getTripSuggestions(
    userId: string,
    postId: string,
    windowDays = this.TRIP_WINDOW_DAYS,
  ) {
    const publicUrl = process.env.R2_PUBLIC_URL || '';
    const client = this.supabase.getClient();
    const { data: anchor } = await client
      .from('fb_posts')
      .select('id, event_date, trip_id, metadata')
      .eq('user_id', userId)
      .eq('id', postId)
      .single();
    if (!anchor) throw new NotFoundException('文章不存在');

    const country = anchor.metadata?.country?.trim() || null;
    const anchorMs = new Date(anchor.event_date).getTime();
    const lo = new Date(anchorMs - windowDays * 86400000);
    const hi = new Date(anchorMs + windowDays * 86400000);
    const iso = (d: Date) => d.toISOString().split('T')[0];

    let query = client
      .from('fb_posts')
      .select(
        'id, event_date, title, category, cover_image, media, metadata, trip_id',
      )
      .eq('user_id', userId)
      .eq('is_hidden', false)
      .neq('id', postId)
      .gte('event_date', iso(lo))
      .lte('event_date', iso(hi));
    if (country) query = query.eq('metadata->>country', country);

    const { data, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);

    const anchorTrip = anchor.trip_id;
    return (data || [])
      .filter((p) => !(anchorTrip && p.trip_id === anchorTrip))
      .map((p) => {
        const days = Math.round(
          Math.abs(new Date(p.event_date).getTime() - anchorMs) / 86400000,
        );
        const sameCity =
          !!country &&
          !!p.metadata?.city &&
          p.metadata.city === anchor.metadata?.city;
        const isSecondary = p.category === '旅遊' || p.category === '登山';
        const reason = [
          country ? '同國' : '鄰近日期',
          sameCity ? '同城' : null,
          `差 ${days} 天`,
        ]
          .filter(Boolean)
          .join('・');
        const norm = this.normalizePost(p, publicUrl);
        return {
          score: (sameCity ? 100 : 0) - days + (isSecondary ? 5 : 0),
          item: {
            postId: p.id,
            title: p.title,
            date: p.event_date,
            category: p.category,
            country: p.metadata?.country || null,
            city: p.metadata?.city || null,
            coverImage: norm?.cover_image || null,
            daysDiff: days,
            alreadyInOtherTrip: !!p.trip_id,
            reason,
          },
        };
      })
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item);
  }

  /**
   * 加入同行文章。若錨點尚未有行程，則自動建立（錨點成為主文），再把目標掛入。
   */
  async addToTrip(userId: string, anchorId: string, postId: string) {
    const client = this.supabase.getClient();
    const { data: anchor } = await client
      .from('fb_posts')
      .select('id, trip_id')
      .eq('user_id', userId)
      .eq('id', anchorId)
      .single();
    if (!anchor) throw new NotFoundException('主文不存在');

    let tripId = anchor.trip_id;
    if (!tripId) {
      tripId = anchor.id; // 錨點成為主文
      const { error } = await client
        .from('fb_posts')
        .update({ trip_id: tripId })
        .eq('user_id', userId)
        .eq('id', anchor.id);
      if (error) throw new InternalServerErrorException(error.message);
    }

    const { error: e2 } = await client
      .from('fb_posts')
      .update({ trip_id: tripId })
      .eq('user_id', userId)
      .eq('id', postId);
    if (e2) throw new InternalServerErrorException(e2.message);

    await this.cacheManager.del(`pb:${userId}`);
    return this.findByTripId(userId, tripId);
  }

  /**
   * 移出行程。若欲移除的是主文且行程尚有其他成員，擋下並要求先改主文，
   * 避免留下沒有主文的孤兒行程。
   */
  async removeFromTrip(userId: string, postId: string) {
    const client = this.supabase.getClient();
    const { data: post } = await client
      .from('fb_posts')
      .select('id, trip_id')
      .eq('user_id', userId)
      .eq('id', postId)
      .single();
    if (!post) throw new NotFoundException('文章不存在');
    if (!post.trip_id) return [];

    const tripId = post.trip_id;
    if (post.id === tripId) {
      const { data: others } = await client
        .from('fb_posts')
        .select('id')
        .eq('user_id', userId)
        .eq('trip_id', tripId)
        .neq('id', post.id);
      if (others && others.length > 0) {
        throw new BadRequestException(
          '此為主文，請先將其他文章設為主文，才能移除。',
        );
      }
    }

    const { error } = await client
      .from('fb_posts')
      .update({ trip_id: null })
      .eq('user_id', userId)
      .eq('id', postId);
    if (error) throw new InternalServerErrorException(error.message);

    await this.cacheManager.del(`pb:${userId}`);
    return post.id === tripId ? [] : this.findByTripId(userId, tripId);
  }

  /**
   * 設為主文：把整組所有成員的 trip_id 全部改成該篇 id（因為主文 id 即 trip_id），
   * 原主文自動降為附文。無行程者則自建單篇行程。
   */
  async makePrimary(userId: string, postId: string) {
    const client = this.supabase.getClient();
    const { data: post } = await client
      .from('fb_posts')
      .select('id, trip_id')
      .eq('user_id', userId)
      .eq('id', postId)
      .single();
    if (!post) throw new NotFoundException('文章不存在');

    const oldTrip = post.trip_id;
    const filter =
      oldTrip && oldTrip !== post.id
        ? client
            .from('fb_posts')
            .update({ trip_id: post.id })
            .eq('trip_id', oldTrip)
        : client
            .from('fb_posts')
            .update({ trip_id: post.id })
            .eq('id', post.id);
    const { error } = await filter.eq('user_id', userId);
    if (error) throw new InternalServerErrorException(error.message);

    await this.cacheManager.del(`pb:${userId}`);
    return this.findByTripId(userId, post.id);
  }

  async getCategories(userId: string) {
    if (!userId) return [];
    const VALID_CATEGORIES = ['馬拉松', '旅遊', '登山'];
    const SUB_CATEGORY_MAP: Record<string, string[]> = {
      馬拉松: ['海外馬', '國內馬', '超馬(44K+)', '高山馬', '九大馬', '普查'],
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

  async geocodeLocation(country?: string, city?: string) {
    const query = [city, country].filter(Boolean).join(' ').trim();
    if (!query) return { lat: null, lng: null };
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    let results: any[];
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'MaraMap-admin-geocode/1.0 (personal project, manual admin lookup)',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      results = await res.json();
    } catch {
      throw new InternalServerErrorException('地理編碼查詢失敗，請稍後再試。');
    }
    const hit = results[0];
    if (!hit) return { lat: null, lng: null };
    return { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) };
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

  /**
   * 後台手動新增單篇文章。fb_timestamp 以毫秒級 Date.now() 產生：FB 匯入的
   * 時間戳為「秒」（~1e9），毫秒級（~1.7e12）不會與其相撞，也滿足
   * (user_id, fb_timestamp) 的唯一鍵。
   */
  async create(userId: string, dto: CreateFbPostDto) {
    const publicUrl = process.env.R2_PUBLIC_URL || '';
    const client = this.supabase.getClient();
    // Promote any freshly-uploaded media out of the tmp prefix before it's
    // persisted, so the row never stores a tmp URI that lifecycle would reap.
    const { media, cover_image } = await this.claimTmpMedia(
      userId,
      dto.media ?? [],
      dto.cover_image,
    );
    const row = {
      user_id: userId,
      fb_timestamp: Date.now(),
      event_date: dto.event_date,
      title: dto.title,
      content: dto.content ?? '',
      category: dto.category,
      sub_categories: dto.sub_categories ?? [],
      tags: dto.tags ?? [],
      media,
      metadata: dto.metadata ?? {},
      cover_image,
      is_hidden: dto.is_hidden ?? false,
      is_personal_best: dto.is_personal_best ?? false,
      source: 'manual',
    };
    const { data, error } = await client
      .from('fb_posts')
      .insert(row)
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    await this.cacheManager.del(`pb:${userId}`);
    await this.stats.refreshAfterMutation(`post create ${data.id}`);
    return this.normalizePost(data, publicUrl);
  }

  private readonly IMAGE_MIME_EXT: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  private readonly VIDEO_MIME_EXT: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
  };

  // Per-type ceilings, sized from the real corpus (images top out ~4.4MB,
  // videos ~58MB). The controller's multer fileSize limit is the hard memory
  // guard; these give a friendly per-type message. VIDEO_MAX_BYTES is the
  // source of truth for the interceptor limit too.
  static readonly IMAGE_MAX_BYTES = 8 * 1024 * 1024;
  static readonly VIDEO_MAX_BYTES = 64 * 1024 * 1024;

  /**
   * 把後台上傳的圖片/影片存到 R2，回傳完整網址（可直接寫入 media[].uri /
   * cover_image；normalizePost 對 http 開頭原樣放行）與媒體型別。
   */
  async uploadMedia(userId: string, file: Express.Multer.File) {
    if (!file || !file.buffer) {
      throw new BadRequestException('沒有收到檔案。');
    }
    const imageExt = this.IMAGE_MIME_EXT[file.mimetype];
    const videoExt = this.VIDEO_MIME_EXT[file.mimetype];

    let ext: string;
    let type: 'photo' | 'video';
    let maxBytes: number;
    if (imageExt) {
      ext = imageExt;
      type = 'photo';
      maxBytes = FbPostsService.IMAGE_MAX_BYTES;
    } else if (videoExt) {
      ext = videoExt;
      type = 'video';
      maxBytes = FbPostsService.VIDEO_MAX_BYTES;
    } else {
      throw new BadRequestException(
        '僅支援 JPG / PNG / WebP / GIF 圖片，或 MP4 / MOV / WebM 影片。',
      );
    }

    const size = file.size ?? file.buffer.length;
    if (size > maxBytes) {
      const mb = Math.round(maxBytes / 1024 / 1024);
      throw new BadRequestException(
        `${type === 'photo' ? '圖片' : '影片'}不可超過 ${mb}MB。`,
      );
    }

    // Uploads land in a tmp prefix and are "claimed" into the permanent path
    // when a post is actually created (see claimTmpMedia). Anything never
    // claimed (abandoned drafts) is swept by the R2 Object Lifecycle rule on
    // `tmp/` (configured in the Cloudflare dashboard — see README).
    const key = `tmp/${userId}/${Date.now()}-${randomUUID()}.${ext}`;
    const url = await this.r2.upload(key, file.buffer, file.mimetype);
    return { key, url, type };
  }

  /**
   * Moves any media still sitting in this user's tmp prefix into the permanent
   * `manual/<userId>/` path and rewrites their URIs. Best-effort per item: if a
   * copy fails the original tmp URI is kept (the object still exists and the
   * lifecycle rule will eventually reclaim it) rather than failing the whole
   * post creation.
   */
  private async claimTmpMedia(
    userId: string,
    media: Array<{ uri: string; type: string }>,
    coverImage: string | null | undefined,
  ): Promise<{
    media: Array<{ uri: string; type: string }>;
    cover_image: string | null;
  }> {
    const tmpPrefix = `tmp/${userId}/`;
    const publicUrl = process.env.R2_PUBLIC_URL || '';
    const uriMap = new Map<string, string>(); // old tmp uri -> permanent uri

    const newMedia: Array<{ uri: string; type: string }> = [];
    for (const m of media) {
      const key = this.r2.keyFromUrl(m?.uri);
      if (!key || !key.startsWith(tmpPrefix)) {
        newMedia.push(m);
        continue;
      }
      const destKey = `${PERMANENT_MEDIA_PREFIX}/${key.slice(tmpPrefix.length)}`;
      try {
        await this.r2.copy(key, destKey);
        await this.r2.delete(key); // best-effort; lifecycle covers leftovers
        const newUri = publicUrl ? `${publicUrl}/${destKey}` : destKey;
        uriMap.set(m.uri, newUri);
        newMedia.push({ ...m, uri: newUri });
      } catch (err: any) {
        this.logger.warn(
          `claim tmp media failed for ${key}: ${err?.message || err}`,
        );
        newMedia.push(m);
      }
    }

    const newCover =
      coverImage && uriMap.has(coverImage)
        ? uriMap.get(coverImage)!
        : (coverImage ?? null);
    return { media: newMedia, cover_image: newCover };
  }

  async update(userId: string, id: string, updateDto: UpdateFbPostDto) {
    const publicUrl = process.env.R2_PUBLIC_URL || '';
    const client = this.supabase.getClient();

    const payload: Record<string, any> = { ...updateDto };

    // When media is part of the edit: promote any freshly-uploaded (tmp) items
    // to the permanent path, rewrite the cover if it pointed at one, and delete
    // the R2 objects for media removed in this edit. Diff by R2 key (not raw
    // URI) so the relative↔absolute forms of the same object aren't mistaken
    // for a removal. PATCHes that don't send media (e.g. hide/unhide) skip all
    // of this and leave media untouched.
    if (updateDto.media !== undefined) {
      const claimed = await this.claimTmpMedia(
        userId,
        updateDto.media,
        updateDto.cover_image,
      );
      payload.media = claimed.media;
      if (updateDto.cover_image !== undefined) {
        payload.cover_image = claimed.cover_image;
      }

      const { data: existing } = await client
        .from('fb_posts')
        .select('media')
        .eq('user_id', userId)
        .eq('id', id)
        .single();
      const oldMedia = Array.isArray(existing?.media) ? existing.media : [];
      const newKeys = new Set(
        payload.media
          .map((m: any) => this.r2.keyFromUrl(m?.uri))
          .filter(Boolean),
      );
      for (const m of oldMedia) {
        const key = this.r2.keyFromUrl(m?.uri);
        if (key && !newKeys.has(key)) {
          try {
            await this.r2.delete(key);
          } catch (err: any) {
            this.logger.warn(
              `R2 cleanup skipped for ${m?.uri}: ${err?.message || err}`,
            );
          }
        }
      }
    }

    const { data, error } = await client
      .from('fb_posts')
      .update(payload)
      .eq('user_id', userId)
      .eq('id', id)
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    await this.cacheManager.del(`pb:${userId}`);
    // Edits reach the stats through several fields, not just metadata:
    // category, is_hidden and metadata.participants all change the totals.
    // Refreshing unconditionally is simpler than diffing which one moved.
    await this.stats.refreshAfterMutation(`post update ${id}`);
    return this.normalizePost(data, publicUrl);
  }

  private parseTimeToSeconds(time: string): number | null {
    if (!time) return null;
    const parts = time.split(':').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  private formatDelta(diffSeconds: number): string {
    const abs = Math.abs(diffSeconds);
    const h = Math.floor(abs / 3600);
    const m = Math.floor((abs % 3600) / 60);
    const s = abs % 60;
    const sign = diffSeconds < 0 ? '-' : '+';
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${sign}${h}:${mm}:${ss}` : `${sign}${mm}:${ss}`;
  }

  // The six distance buckets the PB page tracks. Fixed-distance buckets are
  // ranked by time (faster = better); timed races (6H/12H) are ranked by
  // distance (farther = better) because there the clock is the constant. Any
  // race that is not one of these six is deliberately excluded — one-off
  // distances (round-island stage races, odd ultras) have no progression of
  // their own and only add noise.
  private readonly PB_BUCKET_ORDER = ['半馬', '全馬', '50K', '100K', '6H', '12H'];

  private classifyPbRace(
    p: any,
    title: string,
  ): { bucket: string; mode: 'time' | 'distance'; value: number } | null {
    const type: string = p.distance || '';
    const km: number | null = p.stats?.distance_km ?? null;
    const timeSeconds = this.parseTimeToSeconds(p.time || '');
    const looksMarathon = km != null && km >= 40 && km <= 44;

    // Timed race — detect ONLY by event-name markers (射日組/陽光組, "N小時超馬")
    // or an exact N:00:00 clock. NEVER by finish-time prose like "跑 4 小時 36
    // 分", which titles routinely contain and would misfile ordinary marathons
    // as timed races. A marathon-range distance also vetoes the timed reading.
    const timedByName =
      /射日|陽光|(\d+)\s*小時[^,，。]{0,8}(?:超馬|挑戰|賽)|(\d+)\s*H\s*(?:組|射日|陽光)/.test(
        `${title} ${type}`,
      );
    const exactCap = /^0?(\d{1,2}):00:00$/.exec(p.time || '');
    if ((timedByName || exactCap) && !looksMarathon && km != null) {
      const nameHrs = /(\d+)\s*(?:小時|H)/i.exec(title);
      const hrs = nameHrs
        ? nameHrs[1]
        : exactCap
          ? String(parseInt(exactCap[1], 10))
          : null;
      if (hrs && ['6', '12'].includes(hrs)) {
        return { bucket: `${hrs}H`, mode: 'distance', value: km };
      }
      return null; // timed but an unsupported cap → excluded
    }

    // Fixed-distance buckets, ranked by time. Only the four named distances;
    // distance_km bands catch ultras that carry a km, type strings catch the
    // standard races that often omit it.
    if (timeSeconds == null) return null;
    if (type === '半馬' || (km != null && km >= 20 && km <= 22))
      return { bucket: '半馬', mode: 'time', value: timeSeconds };
    if (type === '全馬' || (km != null && km >= 40 && km <= 44))
      return { bucket: '全馬', mode: 'time', value: timeSeconds };
    if (km != null && km >= 48 && km <= 52)
      return { bucket: '50K', mode: 'time', value: timeSeconds };
    if (km != null && km >= 95 && km <= 105)
      return { bucket: '100K', mode: 'time', value: timeSeconds };
    return null; // non-standard distance → excluded by design
  }

  async findPersonalBests(userId: string) {
    if (!userId) return { participants: {} };
    const cacheKey = `pb:${userId}`;
    const cached = await this.cacheManager.get(cacheKey);
    if (cached) return cached;
    const client = this.supabase.getClient();
    // Include 旅遊 as well as 馬拉松: many of Davis's half marathons are filed
    // under 旅遊, not 馬拉松. To avoid disturbing the other buckets, a 旅遊 post
    // only contributes to the 半馬 bucket (see the guard in the loop) — its 全馬
    // and 超馬 entries, which are also mis-filed there, are left out on purpose.
    const { data, error } = await client
      .from('fb_posts')
      .select('id, event_date, title, category, metadata')
      .eq('user_id', userId)
      .eq('is_hidden', false)
      .in('category', ['馬拉松', '旅遊'])
      .order('event_date', { ascending: true });
    if (error || !data) return { participants: {} };

    const fmtClock = (secs: number) => {
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };

    type Milestone = {
      date: string;
      raceName: string | null;
      postId: string;
      country: string | null;
      display: string;
      delta: string | null;
    };
    type Bucket = {
      mode: 'time' | 'distance';
      record: number;
      best: Omit<Milestone, 'delta'>;
      progression: Milestone[];
    };

    // participant -> bucket -> running state. Posts are ASC by date, so a single
    // forward pass yields the record progression directly: each race that beats
    // the running record is a new PB milestone. This replaces the old manual
    // is_personal_best flag entirely.
    const byParticipant: Record<string, Record<string, Bucket>> = {};

    for (const post of data) {
      const raceName: string | null =
        post.metadata?.race_name || post.title || null;
      const country: string | null = post.metadata?.country || null;
      for (const p of post.metadata?.participants || []) {
        if (!p.name) continue;
        const cls = this.classifyPbRace(p, post.title || '');
        if (!cls) continue;
        // 旅遊 posts are scanned only for half marathons; their mis-filed
        // 全馬/超馬 entries do not count toward those buckets.
        if (post.category === '旅遊' && cls.bucket !== '半馬') continue;
        const { bucket, mode, value } = cls;

        byParticipant[p.name] ??= {};
        const buckets = byParticipant[p.name];
        const existing = buckets[bucket];
        const isImprovement =
          !existing ||
          (mode === 'time'
            ? value < existing.record
            : value > existing.record);
        if (!isImprovement) continue;

        const display = mode === 'time' ? fmtClock(value) : `${value}K`;
        const best = {
          date: post.event_date,
          raceName,
          postId: post.id,
          country,
          display,
        };
        if (!existing) {
          buckets[bucket] = {
            mode,
            record: value,
            best,
            progression: [{ ...best, delta: null }],
          };
        } else {
          const delta =
            mode === 'time'
              ? this.formatDelta(value - existing.record)
              : `+${(value - existing.record).toFixed(2)}K`;
          existing.record = value;
          existing.best = best;
          existing.progression.push({ ...best, delta });
        }
      }
    }

    // Shape output: bucket order fixed, internal `record` stripped.
    const result: Record<
      string,
      {
        records: Record<
          string,
          {
            mode: 'time' | 'distance';
            best: Omit<Milestone, 'delta'>;
            progression: Milestone[];
          }
        >;
      }
    > = {};
    for (const [name, buckets] of Object.entries(byParticipant)) {
      const ordered = this.PB_BUCKET_ORDER.filter((b) => buckets[b]);
      if (ordered.length === 0) continue;
      const records: Record<string, any> = {};
      for (const b of ordered) {
        records[b] = {
          mode: buckets[b].mode,
          best: buckets[b].best,
          progression: buckets[b].progression,
        };
      }
      result[name] = { records };
    }

    // Cache for a day rather than the global 1h default. PB only changes when a
    // post is created/edited/deleted or a trip is reassigned — and each of those
    // paths already deletes this key — so the TTL is just a backstop for the one
    // gap those hooks miss: the ETL importer, which writes to Supabase directly.
    // A longer TTL is safe here precisely because writes invalidate explicitly.
    const PB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
    await this.cacheManager.set(cacheKey, { participants: result }, PB_CACHE_TTL_MS);
    return { participants: result };
  }

  /**
   * Admin action: force a fresh Personal Best computation. PB is computed
   * lazily and cached, so this drops the cache and recomputes now — the manual
   * escape hatch for out-of-band writes (e.g. the ETL importer) that would
   * otherwise wait out the day-long TTL. Throws if the recompute fails, so the
   * caller can report success/failure.
   */
  async recomputePersonalBests(userId: string) {
    await this.cacheManager.del(`pb:${userId}`);
    return this.findPersonalBests(userId);
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

    // Best-effort R2 cleanup — must never fail the delete itself.
    const media = Array.isArray(data?.media) ? data.media : [];
    for (const m of media) {
      try {
        const key = this.r2.keyFromUrl(m?.uri);
        if (key) await this.r2.delete(key);
      } catch (err: any) {
        this.logger.warn(
          `R2 cleanup skipped for ${m?.uri}: ${err?.message || err}`,
        );
      }
    }

    await this.cacheManager.del(`pb:${userId}`);
    await this.stats.refreshAfterMutation(`post delete ${id}`);
    return data;
  }
}
