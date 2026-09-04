import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { LocationTranslationsService } from './location-translations.service';
import { SupabaseService } from '../supabase/supabase.service';

describe('LocationTranslationsService', () => {
  let service: LocationTranslationsService;

  const mockSupabaseClient = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    // Make thenable to support `await query` directly (no .single()) as
    // list()/delete() do — matches the pattern in fb-posts.service.spec.ts.
    then: jest.fn(function (resolve) {
      return resolve({ data: [], error: null });
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSupabaseClient.from.mockReturnThis();
    mockSupabaseClient.select.mockReturnThis();
    mockSupabaseClient.delete.mockReturnThis();
    mockSupabaseClient.upsert.mockReturnThis();
    mockSupabaseClient.insert.mockReturnThis();
    mockSupabaseClient.eq.mockReturnThis();
    mockSupabaseClient.order.mockReturnThis();
    mockSupabaseClient.single.mockReturnThis();
    mockSupabaseClient.maybeSingle.mockResolvedValue({
      data: null,
      error: null,
    });
    mockSupabaseClient.then.mockImplementation((resolve) =>
      resolve({ data: [], error: null }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationTranslationsService,
        {
          provide: SupabaseService,
          useValue: {
            getClient: jest.fn().mockReturnValue(mockSupabaseClient),
          },
        },
      ],
    }).compile();

    service = module.get<LocationTranslationsService>(
      LocationTranslationsService,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('listCountries', () => {
    it('orders by zh and returns the rows', async () => {
      const rows = [
        { zh: '台灣', en: 'Taiwan', updated_at: '2026-01-01' },
        { zh: '日本', en: 'Japan', updated_at: '2026-01-01' },
      ];
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: rows, error: null }),
      );

      const result = await service.listCountries();

      expect(mockSupabaseClient.from).toHaveBeenCalledWith(
        'country_translations',
      );
      expect(mockSupabaseClient.order).toHaveBeenCalledWith('zh', {
        ascending: true,
      });
      expect(result).toEqual(rows);
    });

    it('throws InternalServerErrorException on a Supabase error', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: null, error: { message: 'boom' } }),
      );

      await expect(service.listCountries()).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('upsertCountry', () => {
    it('trims input and inserts a genuinely new country', async () => {
      mockSupabaseClient.maybeSingle.mockResolvedValueOnce({
        data: null,
        error: null,
      });
      mockSupabaseClient.single.mockResolvedValueOnce({
        data: { zh: '台灣', en: 'Taiwan', updated_at: '2026-01-01' },
        error: null,
      });

      const result = await service.upsertCountry('  台灣  ', '  Taiwan  ');

      expect(mockSupabaseClient.insert).toHaveBeenCalledWith({
        zh: '台灣',
        en: 'Taiwan',
      });
      expect(result).toEqual({
        zh: '台灣',
        en: 'Taiwan',
        updated_at: '2026-01-01',
      });
    });

    it('rejects with BadRequestException when the country already exists — countries are create-only', async () => {
      mockSupabaseClient.maybeSingle.mockResolvedValueOnce({
        data: { zh: '台灣' },
        error: null,
      });

      await expect(
        service.upsertCountry('台灣', 'Some New Name'),
      ).rejects.toThrow(BadRequestException);
      expect(mockSupabaseClient.insert).not.toHaveBeenCalled();
    });
  });

  describe('listCities', () => {
    it('filters by country when provided', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: [], error: null }),
      );

      await service.listCities('台灣');

      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('country_zh', '台灣');
    });

    it('does not filter when no country is provided', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: [], error: null }),
      );

      await service.listCities();

      expect(mockSupabaseClient.eq).not.toHaveBeenCalled();
    });
  });

  describe('upsertCity', () => {
    it('upserts on the (country_zh, zh) composite conflict key', async () => {
      mockSupabaseClient.single.mockResolvedValueOnce({
        data: {
          country_zh: '台灣',
          zh: '台北',
          en: 'Taipei',
          updated_at: '2026-01-01',
        },
        error: null,
      });

      await service.upsertCity('台灣', '台北', 'Taipei');

      expect(mockSupabaseClient.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          country_zh: '台灣',
          zh: '台北',
          en: 'Taipei',
        }),
        { onConflict: 'country_zh,zh' },
      );
    });
  });

  describe('deleteCity', () => {
    it('deletes by both country_zh and zh', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({ error: null }),
      );

      await service.deleteCity('台灣', '台北');

      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('country_zh', '台灣');
      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('zh', '台北');
    });
  });

  describe('getCountryMap', () => {
    it('flattens rows into a zh -> en record', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({
          data: [
            { zh: '台灣', en: 'Taiwan', updated_at: '2026-01-01' },
            { zh: '日本', en: 'Japan', updated_at: '2026-01-01' },
          ],
          error: null,
        }),
      );

      const map = await service.getCountryMap();

      expect(map).toEqual({ 台灣: 'Taiwan', 日本: 'Japan' });
    });
  });

  describe('getCityMap', () => {
    it('nests rows into country_zh -> { city_zh: city_en }', async () => {
      mockSupabaseClient.then.mockImplementationOnce((resolve) =>
        resolve({
          data: [
            {
              country_zh: '台灣',
              zh: '台北',
              en: 'Taipei',
              updated_at: '2026-01-01',
            },
            {
              country_zh: '台灣',
              zh: '台中',
              en: 'Taichung',
              updated_at: '2026-01-01',
            },
            {
              country_zh: '日本',
              zh: '東京',
              en: 'Tokyo',
              updated_at: '2026-01-01',
            },
          ],
          error: null,
        }),
      );

      const map = await service.getCityMap();

      expect(map).toEqual({
        台灣: { 台北: 'Taipei', 台中: 'Taichung' },
        日本: { 東京: 'Tokyo' },
      });
    });
  });
});
