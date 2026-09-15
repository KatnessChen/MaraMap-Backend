import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { SupabaseService } from '../supabase/supabase.service';
import { TranslationsService } from '../translations/translations.service';

export interface CountryTranslation {
  zh: string;
  en: string;
  updated_at: string;
}

export interface CityTranslation {
  country_zh: string;
  zh: string;
  en: string;
  source: string;
  needs_review: boolean;
  updated_at: string;
}

export interface MissingCity {
  countryZh: string;
  zh: string;
  count: number;
}

/** Taiwan county display strips its 市/縣 suffix before matching a city map
 *  key — mirrors FbPostsService.cityEn()'s stripTaiwanSuffix() (duplicated
 *  here rather than shared: it's a 3-line regex, not worth a cross-module
 *  import for). Applied here too since city_translations' zh keys are
 *  seeded suffix-free (e.g. "台北"), or findMissingCities() would report
 *  cities as missing that are actually already covered. */
const TW_COUNTRY_NAMES = new Set(['台灣', '台 灣', '臺灣', 'Taiwan']);
function stripTaiwanSuffix(
  city: string,
  country: string | null | undefined,
): string {
  const trimmed = city.trim();
  if (!trimmed || !country || !TW_COUNTRY_NAMES.has(country.trim()))
    return trimmed;
  return trimmed.replace(/[市縣]$/u, '') || trimmed;
}

/**
 * CRUD over `country_translations` / `city_translations` (see
 * supabase/migrations/20260903_location_translations.sql), plus the flat
 * zh→en maps FbPostsService needs to compute `country_en`/`city_en` on
 * post responses. No caching here on purpose — this table is tiny (~75
 * countries, ~200 cities) and rarely read outside two endpoints, so an
 * admin edit through the CRUD routes below is reflected immediately rather
 * than waiting out a cache TTL.
 */
@Injectable()
export class LocationTranslationsService {
  // country/city translations only change through the admin CRUD methods
  // below, every one of which deletes the relevant key — the TTL is just a
  // backstop, same reasoning as FbPostsService.findPersonalBests()'s PB
  // cache. This data used to be re-queried from Supabase on every single
  // read endpoint call (categories, locations, a single post, ...), which
  // was most of a /log/[id] page's ~200ms backend latency for what's
  // effectively static reference data.
  private static readonly COUNTRY_MAP_CACHE_KEY = 'location-translations:country-map';
  private static readonly CITY_MAP_CACHE_KEY = 'location-translations:city-map';
  private static readonly MAP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly translations: TranslationsService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async listCountries(): Promise<CountryTranslation[]> {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('country_translations')
      .select('*')
      .order('zh', { ascending: true });
    if (error) throw new InternalServerErrorException(error.message);
    return data || [];
  }

  /**
   * Create-only, deliberately. `en` doubles as the choropleth match key
   * MapView.tsx compares against public/countries.geojson's `properties.name`
   * — editing an already-correct value (or deleting the row) can silently
   * stop that country's map fill from matching, with no error anywhere to
   * surface it. Confirmed live: 3 of the original 75 seeded rows (pulled from
   * the frontend's unverified COUNTRY_EN_MAP) didn't actually match the
   * GeoJSON until a follow-up migration fixed them — see
   * supabase/migrations/20260904_fix_country_geojson_mismatches.sql. So
   * existing rows are frozen; only genuinely new countries can be added, and
   * the frontend constrains `en` to the real GeoJSON name list (a plain
   * <select>, not free text) so a new row can't introduce the same class of
   * mismatch. There is no deleteCountry — same reasoning.
   */
  async upsertCountry(zh: string, en: string): Promise<CountryTranslation> {
    const trimmedZh = zh.trim();
    const client = this.supabase.getClient();
    const { data: existing, error: lookupError } = await client
      .from('country_translations')
      .select('zh')
      .eq('zh', trimmedZh)
      .maybeSingle();
    if (lookupError)
      throw new InternalServerErrorException(lookupError.message);
    if (existing) {
      throw new BadRequestException(
        `「${trimmedZh}」已存在，國家的英文名稱不開放編輯（同時是世界地圖比對用的資料，需與 GeoJSON 保持一致）。如需更正請聯繫開發者。`,
      );
    }
    const { data, error } = await client
      .from('country_translations')
      .insert({ zh: trimmedZh, en: en.trim() })
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    await this.cacheManager.del(
      LocationTranslationsService.COUNTRY_MAP_CACHE_KEY,
    );
    return data;
  }

  async listCities(countryZh?: string): Promise<CityTranslation[]> {
    const client = this.supabase.getClient();
    let query = client
      .from('city_translations')
      .select('*')
      .order('country_zh', { ascending: true })
      .order('zh', { ascending: true });
    if (countryZh) query = query.eq('country_zh', countryZh.trim());
    const { data, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);
    return data || [];
  }

  /** Manual add/edit through the admin CRUD form — always counts as a
   *  human-confirmed value, clearing any AI-guessed needs_review flag
   *  (same semantics as upsertRace()/upsertMountain()). */
  async upsertCity(
    countryZh: string,
    zh: string,
    en: string,
  ): Promise<CityTranslation> {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('city_translations')
      .upsert(
        {
          country_zh: countryZh.trim(),
          zh: zh.trim(),
          en: en.trim(),
          source: 'human',
          needs_review: false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'country_zh,zh' },
      )
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    await this.cacheManager.del(LocationTranslationsService.CITY_MAP_CACHE_KEY);
    return data;
  }

  async deleteCity(countryZh: string, zh: string): Promise<void> {
    const client = this.supabase.getClient();
    const { error } = await client
      .from('city_translations')
      .delete()
      .eq('country_zh', countryZh.trim())
      .eq('zh', zh.trim());
    if (error) throw new InternalServerErrorException(error.message);
    await this.cacheManager.del(LocationTranslationsService.CITY_MAP_CACHE_KEY);
  }

  /** zh → en, for FbPostsService.countryEn(). Cached — see the class-level comment. */
  async getCountryMap(): Promise<Record<string, string>> {
    const cached = await this.cacheManager.get<Record<string, string>>(
      LocationTranslationsService.COUNTRY_MAP_CACHE_KEY,
    );
    if (cached) return cached;
    const rows = await this.listCountries();
    const map: Record<string, string> = {};
    for (const r of rows) map[r.zh] = r.en;
    await this.cacheManager.set(
      LocationTranslationsService.COUNTRY_MAP_CACHE_KEY,
      map,
      LocationTranslationsService.MAP_CACHE_TTL_MS,
    );
    return map;
  }

  /** country zh → { city zh → city en }, for FbPostsService.cityEn(). Cached — see the class-level comment. */
  async getCityMap(): Promise<Record<string, Record<string, string>>> {
    const cached = await this.cacheManager.get<
      Record<string, Record<string, string>>
    >(LocationTranslationsService.CITY_MAP_CACHE_KEY);
    if (cached) return cached;
    const rows = await this.listCities();
    const map: Record<string, Record<string, string>> = {};
    for (const r of rows) {
      (map[r.country_zh] ??= {})[r.zh] = r.en;
    }
    await this.cacheManager.set(
      LocationTranslationsService.CITY_MAP_CACHE_KEY,
      map,
      LocationTranslationsService.MAP_CACHE_TTL_MS,
    );
    return map;
  }

  /**
   * Every (country, city) pair actually used across all posts that has no
   * matching row in city_translations yet — the reason an English reader
   * still sees a Chinese city name somewhere. PostgREST can't DISTINCT a
   * jsonb field server-side, so this fetches every post's metadata and
   * dedupes/counts in JS (same shape as StatsService.getCountryCount()).
   * Sorted by usage count descending so the most-visible gaps surface first.
   */
  async findMissingCities(): Promise<MissingCity[]> {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('fb_posts')
      .select('metadata')
      .eq('is_hidden', false)
      .not('metadata', 'is', null);
    if (error) throw new InternalServerErrorException(error.message);

    const counts = new Map<string, MissingCity>();
    for (const post of data || []) {
      const countryZh = (post.metadata?.country as string | undefined)?.trim();
      const rawCity = post.metadata?.city as string | undefined;
      if (!countryZh || !rawCity) continue;
      const zh = stripTaiwanSuffix(rawCity, countryZh);
      if (!zh) continue;
      const key = `${countryZh}::${zh}`;
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { countryZh, zh, count: 1 });
    }

    const known = new Set(
      (await this.listCities()).map((c) => `${c.country_zh}::${c.zh}`),
    );
    return [...counts.values()]
      .filter((c) => !known.has(`${c.countryZh}::${c.zh}`))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Finds every missing city (see findMissingCities()) and fills in an
   * AI-guessed English name for each, flagged needs_review — same trust
   * model as TranslationsService.resolveProperNoun() for race/mountain
   * names: the guess goes live immediately (so the site stops showing
   * Chinese right away) but stays flagged until an admin confirms it via
   * the normal upsertCity() edit flow.
   */
  async resolveMissingCities(): Promise<{ count: number }> {
    const missing = await this.findMissingCities();
    if (missing.length === 0) return { count: 0 };

    const resolved = await this.translations.resolveCityNames(
      missing.map((m) => ({ countryZh: m.countryZh, cityZh: m.zh })),
    );
    if (resolved.size === 0) return { count: 0 };

    const client = this.supabase.getClient();
    const rows = missing
      .map((m) => {
        const en = resolved.get(`${m.countryZh}::${m.zh}`);
        return en
          ? {
              country_zh: m.countryZh,
              zh: m.zh,
              en,
              source: 'machine',
              needs_review: true,
              updated_at: new Date().toISOString(),
            }
          : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length === 0) return { count: 0 };

    const { error } = await client
      .from('city_translations')
      .upsert(rows, { onConflict: 'country_zh,zh' });
    if (error) throw new InternalServerErrorException(error.message);
    return { count: rows.length };
  }
}
