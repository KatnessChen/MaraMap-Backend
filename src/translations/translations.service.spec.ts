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

    it('checks the source post (rather than bouncing) even when a fresh pending claim already exists, and marks failed if the post has no content', async () => {
      const freshClaim = new Date().toISOString();
      // 1st: existing row, already 'pending' and fresh.
      mockClient.then.mockImplementationOnce((resolve) =>
        resolve({
          data: {
            title: null,
            content: null,
            content_status: 'pending',
            content_claimed_at: freshClaim,
            source: null,
            content_translated_chunks: [],
          },
          error: null,
        }),
      );
      // 2nd: fb_posts lookup finds nothing — the row exists but the source
      // post doesn't (or has no content).
      mockClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: null, error: null }),
      );
      const result = await service.triggerContentTranslation(
        'user-1',
        'post-1',
      );
      expect(result).toEqual({ status: 'skipped' });
      // Old behavior would have returned 'pending' immediately without ever
      // querying fb_posts or touching the row again; new behavior always
      // checks the post first and marks the claim failed when it's missing.
      expect(mockClient.update).toHaveBeenCalledWith(
        expect.objectContaining({ content_status: 'failed' }),
      );
    });

    it('re-reads the row when the insert to create it loses a race, and returns the winner\'s cached content if already done', async () => {
      // 1st: no existing row.
      mockClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: null, error: null }),
      );
      // 2nd: fb_posts lookup — a real post with content to translate.
      mockClient.then.mockImplementationOnce((resolve) =>
        resolve({
          data: {
            id: 'post-1',
            title: '標題',
            content: '第一段。\n\n第二段。',
            metadata: null,
          },
          error: null,
        }),
      );
      // 3rd: insert fails as if another request's insert won the
      // (post_id, locale) primary key first.
      mockClient.then.mockImplementationOnce((resolve) =>
        resolve({ data: null, error: { message: 'duplicate key value' } }),
      );
      // 4th: re-read finds the winner already finished the translation.
      mockClient.then.mockImplementationOnce((resolve) =>
        resolve({
          data: {
            title: 'Title EN',
            content: 'Content EN',
            content_status: 'done',
            content_claimed_at: null,
            source: 'machine',
            content_translated_chunks: ['第一段 EN', '第二段 EN'],
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
      expect(mockClient.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          post_id: 'post-1',
          locale: 'en',
          content_status: 'pending',
          content_translated_chunks: [],
        }),
      );
    });

    it('finalizes without calling Gemini again when every paragraph is already translated but content_status never flipped to done', async () => {
      const freshClaim = new Date().toISOString();
      // 1st: existing row, fresh 'pending', but every paragraph is already
      // in content_translated_chunks (a prior call wrote the last chunk
      // then crashed before flipping content_status).
      mockClient.then.mockImplementationOnce((resolve) =>
        resolve({
          data: {
            title: 'Title EN',
            content: null,
            content_status: 'pending',
            content_claimed_at: freshClaim,
            source: null,
            content_translated_chunks: ['第一段 EN', '第二段 EN'],
          },
          error: null,
        }),
      );
      // 2nd: fb_posts lookup — same two paragraphs as the cached chunks.
      mockClient.then.mockImplementationOnce((resolve) =>
        resolve({
          data: {
            id: 'post-1',
            title: '標題',
            content: '第一段。\n\n第二段。',
            metadata: null,
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
        content: '第一段 EN\n\n第二段 EN',
        title: 'Title EN',
      });
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
