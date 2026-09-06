import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
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
  constructor(
    private readonly supabase: SupabaseService,
    private readonly translations: TranslationsService,
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
  }

  /** zh → en, for FbPostsService.countryEn(). Fetch once per request. */
  async getCountryMap(): Promise<Record<string, string>> {
    const rows = await this.listCountries();
    const map: Record<string, string> = {};
    for (const r of rows) map[r.zh] = r.en;
    return map;
  }

  /** country zh → { city zh → city en }, for FbPostsService.cityEn(). */
  async getCityMap(): Promise<Record<string, Record<string, string>>> {
    const rows = await this.listCities();
    const map: Record<string, Record<string, string>> = {};
    for (const r of rows) {
      (map[r.country_zh] ??= {})[r.zh] = r.en;
    }
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
