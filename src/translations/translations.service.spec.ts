import { Test, TestingModule } from '@nestjs/testing';
import { TranslationsService } from './translations.service';
import { SupabaseService } from '../supabase/supabase.service';

describe('TranslationsService', () => {
  let service: TranslationsService;

  // Minimal chainable Supabase mock — each test stages what `.then()`
  // resolves to for the query(ies) it cares about, mirroring the pattern in
  // fb-posts.service.spec.ts.
  const mockClient = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    then: jest.fn(function (resolve) {
      return resolve({ data: null, error: null });
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranslationsService,
        {
          provide: SupabaseService,
          useValue: { getClient: jest.fn().mockReturnValue(mockClient) },
        },
      ],
    }).compile();
    service = module.get<TranslationsService>(TranslationsService);
    jest.clearAllMocks();
    mockClient.from.mockReturnThis();
    mockClient.select.mockReturnThis();
    mockClient.insert.mockReturnThis();
    mockClient.update.mockReturnThis();
    mockClient.upsert.mockReturnThis();
    mockClient.delete.mockReturnThis();
    mockClient.eq.mockReturnThis();
    mockClient.in.mockReturnThis();
    mockClient.not.mockReturnThis();
    mockClient.or.mockReturnThis();
    mockClient.order.mockReturnThis();
    mockClient.maybeSingle.mockReturnThis();
    mockClient.single.mockReturnThis();
  });

  describe('raceEn / mountainEn (glossary lookup + fallback)', () => {
    it('returns the mapped English name for an exact key', () => {
      expect(
        service.raceEn('東京馬拉松', { 東京馬拉松: 'Tokyo Marathon' }),
      ).toBe('Tokyo Marathon');
    });

    it('strips a leading 4-digit year before matching, per real fb_posts data', () => {
      expect(
        service.raceEn('2019波士頓馬拉松', { 波士頓馬拉松: 'Boston Marathon' }),
      ).toBe('Boston Marathon');
    });

    it('normalizes 臺->台 before matching, per real fb_posts data', () => {
      expect(
        service.raceEn('臺北馬拉松', { 台北馬拉松: 'Taipei Marathon' }),
      ).toBe('Taipei Marathon');
    });

    it('falls back to the zh string itself when nothing matches (never blank)', () => {
      expect(service.raceEn('某個沒有人翻過的路跑賽', {})).toBe(
        '某個沒有人翻過的路跑賽',
      );
    });

    it('returns null for empty/missing input', () => {
      expect(service.raceEn(null, {})).toBeNull();
      expect(service.raceEn('', {})).toBeNull();
    });

    it('mountainEn applies the same normalization', () => {
      expect(
        service.mountainEn('合歡北峰', { 合歡北峰: 'Hehuanshan North Peak' }),
      ).toBe('Hehuanshan North Peak');
    });
  });

  describe('triggerContentTranslation concurrency claim', () => {
    it('returns cached content immediately when already done', async () => {
      mockClient.then.mockImplementationOnce((resolve) =>
        resolve({
          data: {
            title: 'Title EN',
            content: 'Content EN',
            content_status: 'done',
          },
          error: null,
        }),
      );
      const result = await service.triggerContentTranslation(
        'user-1',
        'post-1',
      );
      expect(result).toEqual({
        status: 'done',
        content: 'Content EN',
        title: 'Title EN',
      });
      // Only the lookup ran — no insert/update attempted once already done.
      expect(mockClient.insert).not.toHaveBeenCalled();
    });

    it('returns pending without calling Gemini when another request already holds a fresh claim', async () => {
      const freshClaim = new Date().toISOString();
      mockClient.then.mockImplementationOnce((resolve) =>
        resolve({
          data: {
            title: null,
            content: null,
            content_status: 'pending',
            content_claimed_at: freshClaim,
            source: null,
          },
          error: null,
        }),
      );
      const result = await service.triggerContentTranslation(
        'user-1',
        'post-1',
      );
      expect(result).toEqual({ status: 'pending' });
    });

    it('inserts a pending claim when no row exists yet, and reports pending if the insert loses a race', async () => {
      // First call: no existing row.
      mockClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: null, error: null }),
      );
      // Insert fails as if another request's insert won the (post_id, locale)
      // primary key first — the concurrency guard this claim relies on.
      mockClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: null, error: { message: 'duplicate key value' } }),
      );
      const result = await service.triggerContentTranslation(
        'user-1',
        'post-1',
      );
      expect(result).toEqual({ status: 'pending' });
      expect(mockClient.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          post_id: 'post-1',
          locale: 'en',
          content_status: 'pending',
        }),
      );
    });
  });

  describe('translateOneTitle', () => {
    it('does not overwrite a human-reviewed title', async () => {
      mockClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: { source: 'human' }, error: null }),
      );
      await service.translateOneTitle('post-1', '台北馬拉松');
      expect(mockClient.upsert).not.toHaveBeenCalled();
    });
  });
});
