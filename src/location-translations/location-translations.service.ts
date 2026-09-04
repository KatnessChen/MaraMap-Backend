import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export interface CountryTranslation {
  zh: string;
  en: string;
  updated_at: string;
}

export interface CityTranslation {
  country_zh: string;
  zh: string;
  en: string;
  updated_at: string;
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
  constructor(private readonly supabase: SupabaseService) {}

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
}
